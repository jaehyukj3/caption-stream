/**
 * 음성인식 작업 스레드. 인식(수백 ms)이 서버의 자막 중계를 막지 않도록 따로 돈다.
 *
 * 방식: Silero VAD가 말하는 구간을 찾고, SenseVoice가 그 구간을 받아 적는다.
 *  - 말하는 중: 지금까지의 구간을 주기적으로 다시 인식해 중간 결과(interim)로 보낸다
 *  - 말이 끝나면(짧은 쉼): 그 구간 전체를 인식해 확정(final)으로 보낸다
 * 스트리밍 모델보다 느리지만 훨씬 정확하다 (잔향·잡음이 있는 강의실 음성에서 특히).
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;
/** 말 시작 직전 소리도 포함 (첫 음절 잘림 방지) */
const PREROLL_SAMPLES = SAMPLE_RATE * 0.3;
/** 이보다 짧은 말소리 구간은 중간 결과를 내지 않는다 */
const MIN_INTERIM_SAMPLES = SAMPLE_RATE * 0.5;
const MIN_INTERIM_INTERVAL_MS = 700;

export type WorkerIn =
  | { op: 'open'; id: number }
  | { op: 'audio'; id: number; pcm: ArrayBuffer }
  | { op: 'flush'; id: number }
  | { op: 'close'; id: number };

export type WorkerOut =
  | { op: 'ready' }
  | { op: 'error'; message: string }
  | { op: 'result'; id: number; kind: 'interim' | 'final'; text: string }
  | { op: 'flushed'; id: number };

interface Sherpa {
  OfflineRecognizer: new (config: unknown) => OfflineRecognizer;
  Vad: new (config: unknown, bufferSeconds: number) => Vad;
}
interface OfflineStream {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
}
interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(s: OfflineStream): void;
  getResult(s: OfflineStream): { text: string };
}
interface Vad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
  reset(): void;
}

const port = parentPort!;
const modelDir: string = workerData.modelDir;
const post = (m: WorkerOut) => port.postMessage(m);

let recognizer: OfflineRecognizer;
let sherpa: Sherpa;
let vadConfig: unknown;

try {
  sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa;
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: join(modelDir, 'model.int8.onnx'), language: 'ko', useInverseTextNormalization: 1 },
      tokens: join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  vadConfig = {
    sileroVad: {
      model: join(modelDir, 'silero_vad.onnx'),
      threshold: 0.5,
      minSilenceDuration: 0.5, // 0.5초 쉬면 문장 확정
      minSpeechDuration: 0.25,
      maxSpeechDuration: 12, // 쉬지 않고 말해도 12초마다 끊어서 확정
      windowSize: VAD_WINDOW,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  };
  post({ op: 'ready' });
} catch (e) {
  post({ op: 'error', message: (e as Error).message });
}

function transcribe(samples: Float32Array): string {
  const s = recognizer.createStream();
  s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  recognizer.decode(s);
  return cleanText(recognizer.getResult(s).text);
}

/** 겹친 공백만 정리한다 (음절 반복 같은 오인식은 바르게 쓰인 문장까지 망칠 수 있어 고치지 않는다) */
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

class Session {
  private readonly vad = new sherpa.Vad(vadConfig, 30);
  /** VAD 창(512) 단위로 넣고 남은 조각 */
  private pending = new Float32Array(0);
  /** 최근 소리 (말 시작 직전 부분) */
  private preroll: Float32Array[] = [];
  private prerollLen = 0;
  /** 지금 말하는 중인 구간 (중간 결과용) */
  private speech: Float32Array[] = [];
  private speechLen = 0;
  private speaking = false;
  private lastInterim = '';
  /** 이번 문장의 중간 결과들 (확정 다수결에 씀) */
  private interims: string[] = [];
  private lastInterimAt = 0;
  private lastDecodeMs = 0;

  // 작업 스레드는 Node 자체의 타입 제거 방식으로 실행될 수 있어 파라미터 프로퍼티 문법을 쓰지 않는다
  private readonly id: number;
  constructor(id: number) {
    this.id = id;
  }

  accept(samples: Float32Array) {
    let buf = this.pending.length ? concat([this.pending, samples]) : samples;
    let o = 0;
    for (; o + VAD_WINDOW <= buf.length; o += VAD_WINDOW) this.vad.acceptWaveform(buf.subarray(o, o + VAD_WINDOW));
    this.pending = buf.slice(o);

    const detected = this.vad.isDetected();
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
  }

  flush() {
    this.vad.flush();
    const hadSegment = !this.vad.isEmpty();
    this.drainFinals();
    // VAD가 아직 구간으로 확정하지 않은 말소리가 남아 있으면 그대로 확정
    if (!hadSegment && this.speechLen > MIN_INTERIM_SAMPLES) this.emitFinal(transcribe(concat(this.speech)));
    this.vad.reset();
    this.resetSpeech();
    this.speaking = false;
    this.pending = new Float32Array(0);
    post({ op: 'flushed', id: this.id });
  }

  private drainFinals() {
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      this.vad.pop();
      this.emitFinal(this.decideFinal(seg.samples));
      this.resetSpeech();
    }
  }

  private maybeInterim() {
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
      post({ op: 'result', id: this.id, kind: 'interim', text });
    }
  }

  /**
   * 확정 인식. 결과가 마지막 중간 결과와 다르면(맞게 보였다가 틀리게 바뀌는 경우) 소리를 조금 달리 넣어
   * 두 번 더 인식하고, 최근 중간 결과들까지 넣어 서로 가장 비슷한 결과(다수결)를 고른다.
   * (잡음·잔향을 섞은 낭독 48문장: 글자 오류 6.9% → 6.4%)
   */
  private decideFinal(samples: Float32Array): string {
    const first = transcribe(samples);
    if (!this.lastInterim || normText(first) === normText(this.lastInterim)) return first;
    const pad = new Float32Array(SAMPLE_RATE * 0.6);
    const cands = [first, transcribe(concat([pad, samples, pad])), ...this.interims.slice(-2)];
    if (this.speechLen > 0) cands.push(transcribe(concat(this.speech)));
    return medoid(cands.filter(Boolean));
  }

  private emitFinal(raw: string) {
    const text = mergeFinal(this.lastInterim, raw);
    this.lastInterim = '';
    if (text) post({ op: 'result', id: this.id, kind: 'final', text });
  }

  private resetSpeech() {
    this.interims = [];
    this.speech = [];
    this.speechLen = 0;
    this.lastInterimAt = 0;
  }

  private remember(samples: Float32Array) {
    this.preroll.push(samples);
    this.prerollLen += samples.length;
    while (this.prerollLen - this.preroll[0]!.length >= PREROLL_SAMPLES) this.prerollLen -= this.preroll.shift()!.length;
  }
}

const sessions = new Map<number, Session>();

port.on('message', (m: WorkerIn) => {
  if (!recognizer) return;
  try {
    switch (m.op) {
      case 'open':
        sessions.set(m.id, new Session(m.id));
        break;
      case 'audio': {
        const pcm = new Int16Array(m.pcm);
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768;
        sessions.get(m.id)?.accept(f);
        break;
      }
      case 'flush':
        sessions.get(m.id)?.flush() ?? post({ op: 'flushed', id: m.id });
        break;
      case 'close':
        sessions.delete(m.id);
        break;
    }
  } catch (e) {
    post({ op: 'error', message: (e as Error).message });
  }
});

/**
 * 확정 결과가 문장 앞부분을 빠뜨렸으면(예: 중간 "문을 닫습니다" → 확정 "닫습니다") 마지막 중간 결과의 앞부분으로 채운다.
 * SenseVoice는 같은 말소리라도 끝까지 넣고 다시 인식하면 앞 어절을 빼먹을 때가 있다 (잡음 많은 소리에서 잦음).
 * 확정 결과가 중간 결과의 뒷부분과 맞아떨어질 때만 채우고, 전혀 다른 문장이면 확정 결과를 그대로 쓴다.
 */
function mergeFinal(interim: string, final: string): string {
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
function medoid(cands: string[]): string {
  let best = cands[0]!;
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

function normText(s: string): string {
  return s.replace(/[\s.,?!·…~"'()]/g, '');
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length]!;
}
