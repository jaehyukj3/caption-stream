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
const MIN_INTERIM_INTERVAL_MS = 700;

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
        minSilenceDuration: 0.5, // 0.5초 쉬면 문장 확정
        minSpeechDuration: 0.25,
        maxSpeechDuration: 12, // 쉬지 않고 말해도 12초마다 끊어서 확정
        windowSize: VAD_WINDOW,
      },
      tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      bufferSizeInSeconds: 30,
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

function transcribe(samples) {
  const t0 = performance.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform(SAMPLE_RATE, samples);
  recognizer.decode(stream);
  const text = recognizer.getResult(stream).text || '';
  stream.free();
  post({ op: 'decode', ms: performance.now() - t0, audioMs: (samples.length / SAMPLE_RATE) * 1000 });
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 확정 결과가 문장 앞부분을 빠뜨렸으면(예: 중간 "문을 닫습니다" → 확정 "닫습니다") 마지막 중간 결과의 앞부분으로 채운다.
 * SenseVoice는 같은 말소리라도 끝까지 넣고 다시 인식하면 앞 어절을 빼먹을 때가 있다 (잡음 많은 소리에서 잦음).
 * 확정 결과가 중간 결과의 뒷부분과 맞아떨어질 때만 채우고, 전혀 다른 문장이면 확정 결과를 그대로 쓴다.
 */
function mergeFinal(interim, final) {
  const fi = normText(final);
  const it = normText(interim);
  if (!it || fi.length >= it.length * 0.8) return final;
  if (!fi) return interim;
  let best = -1;
  let bestRatio = Infinity;
  for (let p = 1; p < interim.length; p++) {
    if (interim[p - 1] !== ' ') continue; // 어절 경계에서만
    const a = normText(interim.slice(p));
    if (!a) continue;
    let cost = Infinity;
    for (let k = Math.max(1, a.length - 2); k <= Math.min(fi.length, a.length + 2); k++) cost = Math.min(cost, editDistance(a, fi.slice(0, k)));
    const ratio = cost / a.length;
    if (ratio <= 0.34 && ratio < bestRatio) {
      best = p;
      bestRatio = ratio;
    }
  }
  return best < 0 ? final : `${interim.slice(0, best).trim()} ${final}`;
}

/** 다른 후보들과의 글자 차이 합이 가장 작은 후보 (같으면 앞의 것) */
function medoid(cands) {
  let best = cands[0];
  let bestD = Infinity;
  for (const c of cands) {
    const d = cands.reduce((n, o) => n + editDistance(normText(c), normText(o)), 0);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function normText(s) {
  return s.replace(/[\s.,?!·…~"'()]/g, '');
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 노트북 프로그램(server/src/stt/sttWorker.ts)의 Session과 같은 동작 */
const session = {
  pending: new Float32Array(0),
  preroll: [],
  prerollLen: 0,
  speech: [],
  speechLen: 0,
  speaking: false,
  lastInterim: '',
  /** 이번 문장의 중간 결과들 (확정 다수결에 씀) */
  interims: [],
  lastInterimAt: 0,
  lastDecodeMs: 0,

  accept(samples) {
    const buf = this.pending.length ? concat([this.pending, samples]) : samples;
    let o = 0;
    for (; o + VAD_WINDOW <= buf.length; o += VAD_WINDOW) vad.acceptWaveform(buf.subarray(o, o + VAD_WINDOW));
    this.pending = buf.slice(o);

    const detected = vad.isDetected();
    if (detected && !this.speaking) {
      this.speech = [...this.preroll];
      this.speechLen = this.prerollLen;
    }
    if (detected) {
      this.speech.push(samples);
      this.speechLen += samples.length;
    }
    this.speaking = detected;
    this.remember(samples);

    this.drainFinals();
    if (this.speaking) this.maybeInterim();
  },

  flush() {
    vad.flush();
    const hadSegment = !vad.isEmpty();
    this.drainFinals();
    if (!hadSegment && this.speechLen > MIN_INTERIM_SAMPLES) this.emitFinal(transcribe(concat(this.speech)));
    this.reset();
  },

  reset() {
    vad.reset();
    this.resetSpeech();
    this.speaking = false;
    this.pending = new Float32Array(0);
    this.preroll = [];
    this.prerollLen = 0;
  },

  drainFinals() {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      this.emitFinal(this.decideFinal(seg.samples));
      this.resetSpeech();
    }
  },

  maybeInterim() {
    const now = Date.now();
    const interval = Math.max(MIN_INTERIM_INTERVAL_MS, this.lastDecodeMs * 2);
    if (this.speechLen < MIN_INTERIM_SAMPLES || now - this.lastInterimAt < interval) return;
    const t0 = Date.now();
    const text = transcribe(concat(this.speech));
    this.lastDecodeMs = Date.now() - t0;
    this.lastInterimAt = Date.now();
    if (text && text !== this.lastInterim) {
      this.lastInterim = text;
      this.interims.push(text);
      post({ op: 'result', kind: 'interim', text });
    }
  },

  /**
   * 확정 인식. 결과가 마지막 중간 결과와 다르면(맞게 보였다가 틀리게 바뀌는 경우) 소리를 조금 달리 넣어
   * 두 번 더 인식하고, 최근 중간 결과들까지 넣어 서로 가장 비슷한 결과(다수결)를 고른다.
   * (잡음·잔향을 섞은 낭독 48문장: 글자 오류 6.9% → 6.4%)
   */
  decideFinal(samples) {
    const first = transcribe(samples);
    if (!this.lastInterim || normText(first) === normText(this.lastInterim)) return first;
    const pad = new Float32Array(SAMPLE_RATE * 0.6);
    const cands = [first, transcribe(concat([pad, samples, pad])), ...this.interims.slice(-2)];
    if (this.speechLen > 0) cands.push(transcribe(concat(this.speech)));
    return medoid(cands.filter(Boolean));
  },

  emitFinal(raw) {
    const text = mergeFinal(this.lastInterim, raw);
    this.lastInterim = '';
    if (text) post({ op: 'result', kind: 'final', text });
  },

  resetSpeech() {
    this.interims = [];
    this.speech = [];
    this.speechLen = 0;
    this.lastInterimAt = 0;
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
