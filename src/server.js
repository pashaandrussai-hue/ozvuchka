/**
 * Озвучка текста — v1.3
 * Локальный сервер: текст -> mp3 (+ субтитры .srt по границам слов).
 * Ни ключей, ни оплаты, ни аккаунтов. Слушает только 127.0.0.1.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const assets = require('./assets');

const PORT_START = 8731;
const OUTDIR = path.join(assets.baseDir, 'output');
const BYTES_PER_SEC = 48000 / 8; // 48 кбит/с, моно, 24 кГц — постоянный битрейт

fs.mkdirSync(OUTDIR, { recursive: true });

let VOICES = [];
try {
  VOICES = assets.voices();
} catch (e) {
  console.error('Не найден voices.json — список голосов будет пустым.');
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Режем длинный текст на куски по границам предложений. */
function chunkText(text, max) {
  const norm = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const parts = norm.split(/(?<=[.!?…\n])\s*/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.filter((x) => x.trim().length > 0);
}

/** Достаём из потока метаданных законченные JSON-объекты (могут приходить кусками). */
function extractJsonObjects(buffer) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc2 = false;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (inStr) {
      if (esc2) esc2 = false;
      else if (ch === '\\') esc2 = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const raw = buffer.slice(start, i + 1);
        try { objs.push(JSON.parse(raw)); } catch (_) {}
        start = -1;
      }
    }
  }
  return { objs, rest: depth > 0 && start !== -1 ? buffer.slice(start) : '' };
}

function streamChunk(tts, text, rate, pitch, words) {
  return new Promise((resolve, reject) => {
    const { audioStream, metadataStream } = tts.toStream(esc(text), { rate, pitch, volume: '+0%' });
    const arr = [];
    const timer = setTimeout(() => reject(new Error('Таймаут синтеза')), 120000);

    if (metadataStream) {
      let buf = '';
      metadataStream.on('data', (d) => {
        buf += d.toString('utf8');
        const { objs, rest } = extractJsonObjects(buf);
        buf = rest;
        for (const o of objs) {
          for (const m of o.Metadata || []) {
            if (m.Type === 'WordBoundary' && m.Data && m.Data.text) {
              words.push({
                text: m.Data.text.Text,
                start: (m.Data.Offset || 0) / 1e7,
                dur: (m.Data.Duration || 0) / 1e7,
              });
            }
          }
        }
      });
      metadataStream.on('error', () => {});
    }

    audioStream.on('data', (d) => arr.push(d));
    audioStream.on('error', (e) => { clearTimeout(timer); reject(e); });
    audioStream.on('end', () => {
      clearTimeout(timer);
      const b = Buffer.concat(arr);
      if (b.length < 1000) reject(new Error('Пустой ответ сервиса озвучки'));
      else resolve(b);
    });
  });
}

async function openTts(voice) {
  const t = new MsEdgeTTS({ connectionTimeoutMs: 25000, synthesisTimeoutMs: 120000 });
  await t.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
  return t;
}

async function synthesize(text, voice, rate, pitch) {
  const chunks = chunkText(text, 1200);
  if (!chunks.length) throw new Error('Пустой текст');
  const bufs = [];
  const words = [];
  let tts = null;
  let played = 0; // сколько секунд уже склеено, для сдвига субтитров

  try {
    tts = await openTts(voice);
    for (let i = 0; i < chunks.length; i++) {
      let chunkWords = [];
      let buf = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 5 && !buf; attempt++) {
        chunkWords = [];
        try {
          buf = await streamChunk(tts, chunks[i], rate, pitch, chunkWords);
        } catch (e) {
          lastErr = e;
          try { tts.close(); } catch (_) {}
          // Edge иногда рвёт соединение: ждём всё дольше и открываем заново
          const wait = Math.min(1200 * Math.pow(2, attempt - 1), 6000);
          await new Promise((r) => setTimeout(r, wait));
          try { tts = await openTts(voice); } catch (_) {}
        }
      }
      if (!buf) {
        const where = chunks.length > 1 ? ` (часть ${i + 1} из ${chunks.length})` : '';
        const msg = String(lastErr && lastErr.message || lastErr);
        if (/Пустой ответ/.test(msg)) {
          throw new Error(`Голос ${voice} не читает текст на этом языке — вернул пустой звук${where}. Выбери русский или многоязычный голос.`);
        }
        if (/stream closed|turn\.end|timeout|Таймаут/i.test(msg)) {
          throw new Error('Сервис озвучки сейчас перегружен и не ответил. Подожди минуту и нажми «Озвучить» ещё раз — программа уже пробовала несколько раз.');
        }
        throw new Error(`Сервис озвучки не ответил${where}. Попробуй ещё раз или выбери другой голос.`);
      }
      for (const w of chunkWords) {
        words.push({ text: w.text, start: w.start + played, dur: w.dur });
      }
      bufs.push(buf);
      played += buf.length / BYTES_PER_SEC;
    }
  } finally {
    try { if (tts) tts.close(); } catch (_) {}
  }

  return { audio: Buffer.concat(bufs), words, chunks };
}

/** Собираем субтитры: слова -> строки по 42 символа, время берём из движка. */
function buildSrt(words, sourceText) {
  if (!words || !words.length) return '';
  // движок иногда присылает знаки препинания отдельными «словами» — выбрасываем их
  const clean = words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
  if (!clean.length) return '';
  // возвращаем знаки препинания из исходного текста: движок отдаёт слова без них
  const tokens = String(sourceText).split(/\s+/).filter(Boolean);
  let p = 0;
  const norm = (s) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  for (const w of clean) {
    if (p < tokens.length) {
      const t = norm(tokens[p]);
      const wv = norm(w.text);
      if (t && wv && (t.startsWith(wv.slice(0, 4)) || wv.startsWith(t.slice(0, 4)))) {
        w.text = tokens[p];
        p++;
      }
    }
  }

  const cues = [];
  let cur = [];
  const flush = () => { if (cur.length) { cues.push(cur); cur = []; } };
  for (const w of clean) {
    cur.push(w);
    const chars = cur.reduce((s, x) => s + x.text.length + 1, 0);
    if (chars >= 42 || cur.length >= 7) flush();
  }
  flush();

  const fmt = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
  };

  // собираем интервалы и не даём им накладываться друг на друга
  const spans = cues.map((c) => {
    const start = c[0].start;
    const last = c[c.length - 1];
    return { start, end: Math.max(start + 0.4, last.start + Math.max(last.dur, 0.25)), words: c };
  });
  for (let i = 0; i < spans.length - 1; i++) {
    if (spans[i].end > spans[i + 1].start) spans[i].end = Math.max(spans[i].start + 0.3, spans[i + 1].start - 0.001);
  }

  return spans.map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.words.map((x) => x.text).join(' ')}\n`).join('\n') + '\n';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('Слишком длинный текст')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

let busy = false;

// ── движок «свой голос» (Python + Chatterbox) ──────────────────────────────
const ENGINE_PORT = 8791;
let engineProc = null;
let engineStarting = null;

function engineDir() {
  const cands = [
    process.env.OZVUCHKA_ENGINE,
    path.join(assets.baseDir, 'engine'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ozvuchka', 'engine') : null,
    'D:\\Rabote\\engine',
  ].filter(Boolean);
  for (const d of cands) {
    try { if (fs.existsSync(path.join(d, 'server.py'))) return d; } catch (_) {}
  }
  return null;
}

function enginePython(dir) {
  for (const rel of [['venv', 'Scripts', 'python.exe'], ['venv', 'bin', 'python']]) {
    const p = path.join(dir, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function engineHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: ENGINE_PORT, path: '/health', timeout: 1200 }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Поднимает движок, если он ещё не работает. Без окна консоли. */
async function ensureEngine() {
  if (await engineHealth()) return true;
  if (engineStarting) return engineStarting;

  engineStarting = (async () => {
    const dir = engineDir();
    if (!dir) return false;
    const py = enginePython(dir);
    if (!py) return false;
    try {
      engineProc = execFile(py, [path.join(dir, 'server.py')], {
        cwd: dir,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
      });
      engineProc.on('exit', () => { engineProc = null; });
    } catch (_) {
      return false;
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await engineHealth()) return true;
    }
    return false;
  })();

  const ok = await engineStarting;
  engineStarting = null;
  return ok;
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('слишком большой файл')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stopEngine() {
  if (engineProc) {
    try { engineProc.kill(); } catch (_) {}
    engineProc = null;
  }
}
process.on('exit', stopEngine);
process.on('SIGINT', () => { stopEngine(); process.exit(0); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(assets.html());
  }

  if (req.method === 'GET' && url.pathname === '/voices.json') {
    return sendJson(res, 200, VOICES);
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, voices: VOICES.length, busy });
  }

  // отдача готовых файлов из output/
  if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/file/'.length));
    if (!/^[\w.\-]+$/.test(name)) return sendJson(res, 400, { error: 'Плохое имя файла' });
    const p = path.join(OUTDIR, name);
    if (!fs.existsSync(p)) return sendJson(res, 404, { error: 'Файл не найден' });
    const type = name.endsWith('.srt') ? 'text/plain; charset=utf-8' : 'audio/mpeg';
    res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
    return res.end(fs.readFileSync(p));
  }

  if (req.method === 'POST' && url.pathname === '/api/say') {
    if (busy) return sendJson(res, 429, { error: 'Уже озвучиваю предыдущий текст, подожди пару секунд' });
    busy = true;
    try {
      const raw = await readBody(req, 200 * 1024);
      const data = JSON.parse(raw || '{}');
      const text = String(data.text || '').trim();
      const voice = String(data.voice || 'ru-RU-SvetlanaNeural');
      const rate = String(data.rate || '+0%');
      const pitch = String(data.pitch || '+0Hz');
      if (!text) return sendJson(res, 400, { error: 'Нет текста' });
      if (text.length > 12000) return sendJson(res, 400, { error: 'Текст длиннее 12 000 символов — разбей на части' });

      const started = Date.now();
      const { audio, words } = await synthesize(text, voice, rate, pitch);
      const preview = data.preview === true;
      let fileName = '';
      let srtName = '';
      if (!preview) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fileName = `ozvuchka_${stamp}.mp3`;
        srtName = `ozvuchka_${stamp}.srt`;
        fs.writeFileSync(path.join(OUTDIR, fileName), audio);
        const srt = buildSrt(words, text);
        if (srt) fs.writeFileSync(path.join(OUTDIR, srtName), srt, 'utf8');
        else srtName = '';
      }

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'X-File-Name': encodeURIComponent(fileName),
        'X-Srt-Name': encodeURIComponent(srtName),
        'X-Seconds': ((Date.now() - started) / 1000).toFixed(1),
      });
      return res.end(audio);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    } finally {
      busy = false;
    }
  }

  // ── управление приложением ────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/open-folder') {
    try {
      fs.mkdirSync(OUTDIR, { recursive: true });
      execFile('explorer.exe', [OUTDIR], { windowsHide: true }, () => {});
      return sendJson(res, 200, { ok: true, path: OUTDIR });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/quit') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 250);
    return;
  }

  // страница шлёт пульс: если окно закрыли — сервер сам завершится
  if (url.pathname === '/api/ping') {
    lastPing = Date.now();
    if (!watchdog) startWatchdog();
    return sendJson(res, 200, { ok: true, out: OUTDIR });
  }

  // ── озвучка своим голосом: прокси к локальному движку ─────────────────────
  if (url.pathname === '/api/clone/status') {
    try {
      const h = await engineHealth();
      return sendJson(res, 200, {
        installed: engineDir() !== null,
        running: h !== null,
        loaded: !!(h && h.loaded),
        refs: (h && h.refs) || [],
      });
    } catch (e) {
      return sendJson(res, 200, { installed: engineDir() !== null, running: false, loaded: false, refs: [] });
    }
  }

  if (url.pathname === '/api/clone/progress') {
    const h = await engineHealth();
    return sendJson(res, 200, { state: (h && h.state) || { stage: 'idle' } });
  }

  if (req.method === 'POST' && url.pathname === '/api/clone/reference') {
    try {
      const raw = await readRawBody(req, 40 * 1024 * 1024);
      if (!(await ensureEngine())) return sendJson(res, 503, { error: 'движок не запустился' });
      const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/reference`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(raw.length) },
        body: raw,
      });
      const j = await r.json();
      return sendJson(res, r.status, j);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/clone/say') {
    try {
      const rawJson = await readBody(req, 200 * 1024);
      const data = JSON.parse(rawJson || '{}');
      const text = String(data.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'нет текста' });
      if (text.length > 3000) return sendJson(res, 400, { error: 'для своего голоса максимум 3 000 символов за раз' });
      if (!(await ensureEngine())) return sendJson(res, 503, { error: 'движок не запустился' });

      const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ref: String(data.ref || '') }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return sendJson(res, r.status, { error: j.error || 'движок вернул ошибку' });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `moy_golos_${stamp}.wav`;
      fs.writeFileSync(path.join(OUTDIR, name), buf);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': buf.length,
        'X-File-Name': encodeURIComponent(name),
      });
      return res.end(buf);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
});

// ── запуск приложения ──────────────────────────────────────────────────────

/** Уже запущено? Тогда просто открываем окно и выходим — второй копии не нужно. */
function alreadyRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 900 }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => resolve(r.statusCode === 200 && body.includes('"ok":true')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Браузеры, которые умеют режим приложения (окно без адресной строки и вкладок). */
function browserCandidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    path.join(pf86, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
    path.join(pf, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
    local ? path.join(local, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe') : '',
  ].filter(Boolean);
}

let appProfile = null;

function openWindow(addr) {
  if (process.platform !== 'win32') {
    exec(`xdg-open "${addr}"`);
    return 'browser';
  }
  // отдельный профиль: окно полностью наше, чужая история и входы не затрагиваются
  appProfile = path.join(assets.baseDir, '.app-profile');
  fs.mkdirSync(appProfile, { recursive: true });

  for (const exe of browserCandidates()) {
    if (!fs.existsSync(exe)) continue;
    const args = [
      `--app=${addr}`,
      '--window-size=1180,940',
      `--user-data-dir=${appProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-sync',
    ];
    try {
      const child = execFile(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return 'app:' + path.basename(exe);
    } catch (_) { /* пробуем следующий */ }
  }
  exec(`start "" "${addr}"`);
  return 'browser';
}

let lastPing = 0;
let watchdog = null;

/** Выключаемся, если окно закрыли и пульс пропал. */
function startWatchdog() {
  if (process.env.NO_AUTOEXIT === '1') return;
  const IDLE_MS = Number(process.env.WATCHDOG_IDLE_MS || 150000);
  watchdog = setInterval(() => {
    if (lastPing && Date.now() - lastPing > IDLE_MS) {
      console.log('Окно закрыто — выключаюсь.');
      try { fs.rmSync(appProfile, { recursive: true, force: true }); } catch (_) {}
      process.exit(0);
    }
  }, Math.min(15000, Math.max(1000, Math.floor(IDLE_MS / 3))));
  watchdog.unref?.();
}

function listen(port, triesLeft) {
  server.listen(port, '127.0.0.1', async () => {
    const addr = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  ОЗВУЧКА ТЕКСТА — версия 1.3');
    console.log('  Голосов в каталоге: ' + VOICES.length);
    console.log('  Файлы сохраняются в: ' + OUTDIR);
    console.log('');
    if (process.env.NO_OPEN !== '1') {
      const how = openWindow(addr);
      console.log('  Окно программы: ' + how);
    }
    console.log('  Закрыть программу: закрой окно (выключится само через пару минут)');
    console.log('  или кнопка «Выход» в окне. Это окно можно свернуть.');
    console.log('');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) {
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('Не удалось запустить: ' + e.message);
      process.exit(1);
    }
  });
}

(async () => {
  // вторая копия не нужна: будим окно уже запущенной
  for (let p = PORT_START; p < PORT_START + 10; p++) {
    if (await alreadyRunning(p)) {
      console.log('Программа уже запущена — открываю окно.');
      if (process.env.NO_OPEN !== '1') openWindow(`http://127.0.0.1:${p}`);
      setTimeout(() => process.exit(0), 1200);
      return;
    }
  }
  listen(PORT_START, 10);
})();
