/**
 * Озвучка текста — v1.2
 * Локальный сервер: текст -> mp3 (+ субтитры .srt по границам слов).
 * Ни ключей, ни оплаты, ни аккаунтов. Слушает только 127.0.0.1.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
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
      for (let attempt = 1; attempt <= 4 && !buf; attempt++) {
        chunkWords = [];
        try {
          buf = await streamChunk(tts, chunks[i], rate, pitch, chunkWords);
        } catch (e) {
          lastErr = e;
          try { tts.close(); } catch (_) {}
          await new Promise((r) => setTimeout(r, 700 * attempt));
          try { tts = await openTts(voice); } catch (_) {}
        }
      }
      if (!buf) {
        const where = chunks.length > 1 ? ` (часть ${i + 1} из ${chunks.length})` : '';
        const msg = String(lastErr && lastErr.message || lastErr);
        if (/Пустой ответ/.test(msg)) {
          throw new Error(`Голос ${voice} не читает текст на этом языке — вернул пустой звук${where}. Выбери русский или многоязычный голос.`);
        }
        throw new Error(`Сервис озвучки не ответил${where}: ${msg}. Попробуй другой голос или повтори.`);
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

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
});

function listen(port, triesLeft) {
  server.listen(port, '127.0.0.1', () => {
    const addr = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  ОЗВУЧКА ТЕКСТА — v1.2');
    console.log('  Голосов в каталоге: ' + VOICES.length);
    console.log('  Открываю: ' + addr);
    console.log('  Закрыть программу: Ctrl+C в этом окне (или просто закрой окно).');
    console.log('');
    if (process.platform === 'win32' && !process.env.NO_OPEN) exec(`start "" "${addr}"`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) {
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('Не удалось запустить сервер: ' + e.message);
      process.exit(1);
    }
  });
}

listen(PORT_START, 10);
