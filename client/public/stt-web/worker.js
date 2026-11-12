/* 폰(브라우저) 안에서 도는 음성인식 작업 스레드.
 * 노트북 프로그램과 같은 방식: Silero VAD가 말하는 구간을 찾고 SenseVoice가 받아 적는다.
 * 음성은 이 기기 밖으로 나가지 않는다. 엔진(WebAssembly)과 모델은 처음 한 번 받아 브라우저에 보관한다.
 *
 * 받는 메시지: {op:'init'} · {op:'audio', pcm: ArrayBuffer(Int16, 16kHz)} · {op:'flush'} · {op:'reset'}
 * 보내는 메시지: {op:'progress', loaded, total} · {op:'loading'} · {op:'ready', cached} · {op:'error', message}
 *               {op:'result', kind:'interim'|'final', text} · {op:'flushed'} · {op:'decode', ms, audioMs}
 */
'use strict';

const ENGINE = new URL('engine/', self.location.href).href;
const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;
/** 말 시작 직전 소리도 포함 (첫 음절 잘림 방지) */
const PREROLL_SAMPLES = SAMPLE_RATE * 0.3;
/** 이보다 짧은 말소리 구간은 중간 결과를 내지 않는다 */
const MIN_INTERIM_SAMPLES = SAMPLE_RATE * 0.5;
const MIN_INTERIM_INTERVAL_MS = 500;
/** 이만큼 지난 낱말만 고정한다 (갓 들어온 끝부분은 다음 인식에서 자주 바뀐다) */
const LOCK_GUARD_SEC = 1.0;
/** 고정된 글자가 이보다 많으면 줄을 확정한다 */
const MAX_LINE_CHARS = 40;
/** 줄이 이보다 길면 마지막 낱말 앞에서 줄을 확정한다 */
const MAX_LINE_SEC = 15;

const post = (m) => self.postMessage(m);
/** 진단: 엔진이 실제로 받은 소리 (3초마다 알림) */
const rx = { chunks: 0, samples: 0, peak: 0, speechSamples: 0, nonFinite: 0, since: Date.now() };
let recognizer = null;
let vad = null;
let initPromise = null;

/** 모델 조각을 받아(브라우저 보관함에 있으면 그것을) 하나로 이어 붙인다 */
async function loadModelData() {
  const manifest = await (await fetch(ENGINE + 'manifest.json', { cache: 'no-cache' })).json();
  const cache = await caches.open(`caption-stt-${manifest.version}`);
  // 이전 버전 보관분 정리
  for (const key of await caches.keys()) if (key.startsWith('caption-stt-') && key !== `caption-stt-${manifest.version}`) await caches.delete(key);

  const data = new Uint8Array(manifest.size);
  let offset = 0;
  let cachedAll = true;
  for (const part of manifest.parts) {
    const url = ENGINE + part.name;
    let res = await cache.match(url);
    if (!res) {
      cachedAll = false;
      const got = await fetch(url);
      if (!got.ok) throw new Error(`모델 다운로드 실패 (${got.status})`);
      await cache.put(url, got.clone());
      res = got;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== part.size) {
      await cache.delete(url);
      throw new Error('모델 파일이 손상되었습니다. 다시 시도해 주세요.');
    }
    data.set(buf, offset);
    offset += buf.length;
    post({ op: 'progress', loaded: offset, total: manifest.size });
  }
  return { data, manifest, cachedAll };
}

function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let { data, manifest, cachedAll } = await loadModelData();
    post({ op: 'loading' }); // 받기 끝, 엔진에 모델을 읽어 들이는 중 (폰에서는 수십 초)
    await new Promise((resolve, reject) => {
      self.Module = {
        locateFile: (path) => ENGINE + path,
        // 모델 묶음(.data)은 위에서 직접 받아 둔 것을 쓴다 (25MB 제한 때문에 조각으로 나눠 둠)
        getPreloadedPackage: (_name, size) => {
          if (size !== manifest.size) throw new Error('모델 크기가 엔진과 맞지 않습니다.');
          const buf = data.buffer;
          data = null; // 엔진에 넘긴 뒤에는 이쪽 참조를 놓아 메모리를 아낀다
          return buf;
        },
        onRuntimeInitialized: resolve,
        onAbort: (what) => reject(new Error(`음성인식 엔진 오류: ${what}`)),
        print: () => {},
        printErr: () => {},
      };
      importScripts(ENGINE + 'sherpa-onnx-asr.js', ENGINE + 'sherpa-onnx-vad.js', ENGINE + 'sherpa-onnx-wasm-main-vad-asr.js');
    });
    const Module = self.Module;
    recognizer = new OfflineRecognizer(
      {
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: './sense-voice.onnx', language: 'ko', useInverseTextNormalization: 1 },
          tokens: './tokens.txt',
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
      },
      Module,
    );
    vad = createVad(Module, {
      sileroVad: {
        model: './silero_vad.onnx',
        // 노트북(0.5)보다 낮춘다: 휴대폰 마이크 소리는 말 사이에도 잡음이 깔려 0.5에서는 짧은 조각만 잡힌다
        // (실제 휴대폰 녹음: 0.5 → 2.5초 조각 둘 "まイク？", 0.35 → 4.6초 한 문장 "마이크 시작 말씀하시면…")
        threshold: 0.35,
        minSilenceDuration: 0.4, // 0.4초 쉬면 문장 확정 (0.5와 정확도 같고 0.1초 빠름)
        minSpeechDuration: 0.25,
        maxSpeechDuration: 30, // 줄은 session이 나누므로 VAD 구간 길이 제한은 넉넉하게 (버퍼 60초 안)
        windowSize: VAD_WINDOW,
      },
      tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      bufferSizeInSeconds: 60,
    });
    // 엔진이 모델을 읽어 들였으니 파일 사본은 지워 메모리를 아낀다
    for (const f of ['/sense-voice.onnx', '/silero_vad.onnx', '/tokens.txt']) {
      try {
        Module.FS.unlink(f);
      } catch {
        /* 없으면 무시 */
      }
    }
    post({ op: 'ready', cached: cachedAll });
  })().catch((e) => {
    initPromise = null;
    post({ op: 'error', message: e && e.message ? e.message : String(e) });
  });
  return initPromise;
}

/** 받아 적어 낱말 단위로 돌려준다. start/end는 세션 시작부터 센 초 (토큰 앞 공백이 낱말 시작, 문장부호는 앞 낱말에) */
function transcribeWords(samples, offsetSec) {
  const t0 = performance.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform(SAMPLE_RATE, samples);
  recognizer.decode(stream);
  const r = recognizer.getResult(stream);
  stream.free();
  post({ op: 'decode', ms: performance.now() - t0, audioMs: (samples.length / SAMPLE_RATE) * 1000 });
  const out = [];
  (r.tokens || []).forEach((t, i) => {
    const at = offsetSec + ((r.timestamps && r.timestamps[i]) || 0);
    const text = t.trim();
    if (!text) return;
    const punct = /^[.,?!]+$/.test(text);
    const last = out[out.length - 1];
    if (!last || (!punct && (t.startsWith(' ') || /[.,?!]$/.test(last.text)))) out.push({ text, start: at, end: at + 0.12 });
    else {
      last.text += text;
      last.end = at + 0.12;
    }
  });
  return out;
}

const joinWords = (ws) => ws.map((w) => w.text).join(' ');
const wordKey = (w) => w.text.replace(/[.,?!]/g, '');
const endsSentence = (w) => /[.?!]$/.test(w.text);

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * 노트북 프로그램(server/src/stt/sttWorker.ts)의 Session과 같은 동작: 브라우저 음성인식처럼 보이도록 '연속 일치'로 줄을 나누고 확정한다.
 *  - 두 번 연달아 같게 나온 앞부분 낱말(1초 이상 지난 것)은 고정해 다시 바뀌지 않게 한다
 *  - 고정된 낱말이 문장 끝(. ? !)이거나 40자를 넘거나 줄이 15초를 넘으면 그 자리에서 줄을 확정한다
 *  - 말이 끝나면(짧은 쉼) 고정되지 않은 뒷부분만 다시 받아 적어 붙여 확정한다
 * (강당 녹음·낭독 시험: 정확도는 비슷하고, 글자가 더 바뀌지 않게 되기까지 2.7초 → 1.3초, 확정할 때 보이던 글자가 바뀌는 일 0번)
 */
const session = {
  pending: new Float32Array(0),
  preroll: [],
  prerollLen: 0,
  line: [],
  lineLen: 0,
  lineStart: 0,
  clock: 0,
  speaking: false,
  locked: [],
  anchor: null,
  prev: [],
  lastInterim: '',
  lastInterimAt: 0,
  lastDecodeMs: 0,

  accept(samples) {
    const buf = this.pending.length ? concat([this.pending, samples]) : samples;
    let o = 0;
    for (; o + VAD_WINDOW <= buf.length; o += VAD_WINDOW) vad.acceptWaveform(buf.subarray(o, o + VAD_WINDOW));
    this.pending = buf.slice(o);
    while (!vad.isEmpty()) vad.pop(); // 구간은 쓰지 않고 말하는 중인지만 본다

    const detected = vad.isDetected();
    if (detected && !this.speaking) {
      this.line = [...this.preroll];
      this.lineLen = this.prerollLen;
      this.lineStart = this.clock - this.prerollLen / SAMPLE_RATE;
      this.resetLocks();
    }
    if (detected || this.speaking) {
      this.line.push(samples);
      this.lineLen += samples.length;
    }
    this.clock += samples.length / SAMPLE_RATE;
    this.remember(samples);

    if (!detected && this.speaking) {
      this.speaking = false;
      this.endLine();
      return;
    }
    this.speaking = detected;
    if (this.speaking) this.maybeInterim();
  },

  flush() {
    if (this.lineLen > MIN_INTERIM_SAMPLES) this.endLine();
    this.reset();
  },

  reset() {
    vad.reset();
    this.line = [];
    this.lineLen = 0;
    this.resetLocks();
    this.speaking = false;
    this.pending = new Float32Array(0);
    this.preroll = [];
    this.prerollLen = 0;
  },

  maybeInterim() {
    const now = Date.now();
    const interval = Math.max(MIN_INTERIM_INTERVAL_MS, this.lastDecodeMs * 2);
    if (this.lineLen < MIN_INTERIM_SAMPLES || now - this.lastInterimAt < interval) return;
    const fresh = this.afterLocked(transcribeWords(concat(this.line), this.lineStart));
    this.lastDecodeMs = Date.now() - now;
    this.lastInterimAt = Date.now();

    // 두 번 연달아 같은 앞부분, 그리고 1초 이상 지난 낱말만 고정
    let n = 0;
    while (n < fresh.length && n < this.prev.length && wordKey(fresh[n]) === wordKey(this.prev[n]) && fresh[n].end < this.clock - LOCK_GUARD_SEC) n++;
    for (let i = 0; i < n; i++) this.lockWord(fresh[i]);
    const rest = fresh.slice(n);
    // 화면에는 고정된 낱말 + 지난번 인식과도 같게 나온 뒷부분만 보인다 (이번에 처음 나온 낱말은 다음 인식에서 같으면 보임).
    // 새로 나온 끝 낱말은 다음 인식에서 자주 바뀌어, 보였다가 지워지는 일이 잦다 (강당 3분: 분당 62번 → 1번, 글자가 보이는 때는 약 0.5초 늦어짐)
    const prevRest = this.prev.slice(n);
    let agreed = 0;
    while (agreed < rest.length && agreed < prevRest.length && wordKey(rest[agreed]) === wordKey(prevRest[agreed])) agreed++;
    this.prev = rest;
    this.sendInterim(joinWords([...this.locked, ...rest.slice(0, agreed)]));

    // 줄 확정: 고정된 낱말이 문장 끝이면 거기서, 고정 글자가 많거나 줄이 너무 길면 지금까지
    const si = this.locked.findIndex(endsSentence);
    if (si >= 0) {
      const carry = this.locked.slice(si + 1);
      this.finishLine(this.locked.slice(0, si + 1), carry.length ? carry[0].start : rest.length ? rest[0].start : this.clock);
      for (const w of carry) this.lockWord(w);
    } else if (this.locked.reduce((a, w) => a + w.text.length, 0) >= MAX_LINE_CHARS) {
      this.finishLine(this.locked, rest.length ? rest[0].start : this.clock);
    } else if (this.lineLen / SAMPLE_RATE > MAX_LINE_SEC && rest.length > 1) {
      this.finishLine([...this.locked, ...rest.slice(0, -1)], rest[rest.length - 1].start);
    }
  },

  /** 말이 끝났을 때: 고정되지 않은 뒷부분만 다시 받아 적어 붙여 확정 */
  endLine() {
    const tail = this.afterLocked(transcribeWords(concat(this.line), this.lineStart));
    const text = joinWords([...this.locked, ...tail]);
    if (text) post({ op: 'result', kind: 'final', text });
    this.line = [];
    this.lineLen = 0;
    this.resetLocks();
  },

  /** 낱말들을 한 줄로 확정하고, cutSec 앞의 소리를 버려 다음 줄을 시작한다 */
  finishLine(words, cutSec) {
    const text = joinWords(words);
    if (text) post({ op: 'result', kind: 'final', text });
    const all = concat(this.line);
    const cut = Math.max(0, Math.min(all.length, Math.round((cutSec - 0.02 - this.lineStart) * SAMPLE_RATE)));
    this.line = [all.subarray(cut)];
    this.lineLen = all.length - cut;
    this.lineStart += cut / SAMPLE_RATE;
    this.resetLocks();
  },

  lockWord(w) {
    this.locked.push(w);
    this.anchor = w;
  },

  resetLocks() {
    this.locked = [];
    this.anchor = null;
    this.prev = [];
    this.lastInterim = '';
    this.lastInterimAt = 0;
  },

  /** 인식 결과에서 이미 고정한 부분 다음만 고른다: 마지막 고정 낱말을 글자로 찾고(±0.5초), 못 찾으면 시각으로 */
  afterLocked(ws) {
    const a = this.anchor;
    if (!a) return ws;
    let best = -1;
    let bestDt = Infinity;
    ws.forEach((w, i) => {
      const dt = Math.abs(w.start - a.start);
      if (wordKey(w) === wordKey(a) && dt < 0.5 && dt < bestDt) {
        best = i;
        bestDt = dt;
      }
    });
    if (best >= 0) return ws.slice(best + 1);
    // 고정 낱말이 둘로 나뉘어 다시 나온 경우("다리를" → "다리" + "를")도 건너뜀
    return ws.filter((w) => w.start > a.end - 0.05);
  },

  sendInterim(text) {
    if (!text || text === this.lastInterim) return;
    this.lastInterim = text;
    post({ op: 'result', kind: 'interim', text });
  },

  remember(samples) {
    this.preroll.push(samples);
    this.prerollLen += samples.length;
    while (this.prerollLen - this.preroll[0].length >= PREROLL_SAMPLES) this.prerollLen -= this.preroll.shift().length;
  },
};

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    switch (m.op) {
      case 'init':
        void init();
        break;
      case 'audio': {
        if (!recognizer) {
          rx.chunks++; // 엔진 준비 전에 온 소리
          return;
        }
        const pcm = new Int16Array(m.pcm);
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          f[i] = pcm[i] / 32768;
          const a = Math.abs(f[i]);
          if (a > rx.peak) rx.peak = a;
        }
        rx.chunks++;
        rx.samples += pcm.length;
        session.accept(f);
        if (session.speaking) rx.speechSamples += pcm.length;
        if (Date.now() - rx.since >= 3000) {
          post({ op: 'rx', chunks: rx.chunks, seconds: rx.samples / SAMPLE_RATE, peak: rx.peak, speech: rx.speechSamples / SAMPLE_RATE, ready: !!recognizer });
          rx.chunks = 0; rx.samples = 0; rx.peak = 0; rx.speechSamples = 0; rx.since = Date.now();
        }
        break;
      }
      case 'flush':
        if (recognizer) session.flush();
        post({ op: 'flushed' });
        break;
      case 'reset':
        if (recognizer) session.reset();
        break;
    }
  } catch (e) {
    post({ op: 'error', message: e && e.message ? e.message : String(e) });
  }
};
