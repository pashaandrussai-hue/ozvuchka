# -*- coding: utf-8 -*-
"""
Движок «озвучка своим голосом»: Chatterbox TTS (лицензия MIT), локально, без интернета.

Запускается приложением автоматически. Слушает только 127.0.0.1.

  GET  /health      -> состояние
  POST /reference   -> сохранить запись голоса (WAV 16 кГц, телом запроса)
  POST /say         -> JSON {text, ref, language} -> WAV

Модель грузится один раз при первом запросе (~10-20 с), первый запуск качает веса.
"""
import io
import json
import os
import re
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = '127.0.0.1', 8791
BASE = os.path.dirname(os.path.abspath(__file__))
REFS = os.path.join(BASE, 'references')
os.makedirs(REFS, exist_ok=True)

_model = None
_lock = threading.Lock()
_state = {'stage': 'idle', 'done': 0, 'total': 0, 'elapsed': 0.0}


def log(*a):
    try:
        print('[engine]', *a, flush=True)
    except Exception:
        pass


def get_model():
    global _model
    with _lock:
        if _model is None:
            log('загружаю модель Chatterbox')
            t0 = time.time()
            from chatterbox.tts import ChatterboxTTS
            _model = ChatterboxTTS.from_pretrained(device='cpu')
            log('модель готова за %.1f с' % (time.time() - t0))
        return _model


def split_text(text, limit=220):
    """Режем на предложения — так проще следить за прогрессом и не растягивать синтез."""
    parts = re.split(r'(?<=[.!?…])\s+', text.replace('\n', ' ').strip())
    out, cur = [], ''
    for p in parts:
        if not p:
            continue
        if len(cur) + len(p) <= limit:
            cur = (cur + ' ' + p).strip()
        else:
            if cur:
                out.append(cur)
            while len(p) > limit:
                cut = p.rfind(' ', 0, limit)
                cut = cut if cut > 40 else limit
                out.append(p[:cut].strip())
                p = p[cut:].strip()
            cur = p
    if cur:
        out.append(cur)
    return [x for x in out if x]


def wav_bytes(tensor, sr):
    import numpy as np
    data = tensor.detach().cpu().numpy().squeeze()
    pcm = (np.clip(data, -1.0, 1.0) * 32767).astype('<i2').tobytes()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm)
    return buf.getvalue()


def say(text, ref_path):
    import torch
    model = get_model()
    chunks = split_text(text)
    _state.update({'stage': 'synthesizing', 'done': 0, 'total': len(chunks), 'elapsed': 0.0})
    t0 = time.time()
    pieces = []
    for i, chunk in enumerate(chunks, 1):
        wav = model.generate(chunk, audio_prompt_path=ref_path)
        pieces.append(wav)
        _state.update({'done': i, 'elapsed': round(time.time() - t0, 1)})
        log('часть %d/%d за %.1f с' % (i, len(chunks), time.time() - t0))
        # короткая пауза между фразами
        if i < len(chunks):
            pieces.append(torch.zeros(1, int(model.sr * 0.25)))
    full = torch.cat(pieces, dim=-1)
    data = wav_bytes(full, model.sr)
    _state.update({'stage': 'idle'})
    return data


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit=80 * 1024 * 1024):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > limit:
            return b''
        return self.rfile.read(n)

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {
                'ok': True,
                'engine': 'chatterbox',
                'loaded': _model is not None,
                'state': _state,
                'refs': sorted(os.listdir(REFS)),
            })
        self._json(404, {'error': 'не найдено'})

    def do_POST(self):
        try:
            if self.path == '/reference':
                raw = self._body()
                if len(raw) < 4000:
                    return self._json(400, {'error': 'запись слишком короткая — нужно 5–15 секунд'})
                name = 'ref_%d.wav' % int(time.time() * 1000)
                p = os.path.join(REFS, name)
                with open(p, 'wb') as f:
                    f.write(raw)
                log('эталон сохранён:', name, len(raw), 'байт')
                return self._json(200, {'ok': True, 'ref': name})

            if self.path == '/say':
                data = json.loads(self._body(4 * 1024 * 1024).decode('utf-8') or '{}')
                text = (data.get('text') or '').strip()
                ref = os.path.basename(data.get('ref') or '')
                if not text:
                    return self._json(400, {'error': 'нет текста'})
                ref_path = os.path.join(REFS, ref) if ref else ''
                if not ref or not os.path.exists(ref_path):
                    return self._json(400, {'error': 'нет записи голоса — сначала запиши образец'})
                _state.update({'stage': 'starting'})
                t0 = time.time()
                wav = say(text, ref_path)
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(wav)))
                self.send_header('X-Seconds', '%.1f' % (time.time() - t0))
                self.end_headers()
                self.wfile.write(wav)
                return

            self._json(404, {'error': 'не найдено'})
        except Exception as e:
            log('ошибка:', e)
            traceback.print_exc()
            _state.update({'stage': 'error'})
            self._json(500, {'error': str(e)})


if __name__ == '__main__':
    log('слушаю http://%s:%d' % (HOST, PORT))
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()
