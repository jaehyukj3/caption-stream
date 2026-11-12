/**
 * 음성인식 작업 스레드. 인식(수백 ms)이 서버의 자막 중계를 막지 않도록 따로 돈다.
 *
 * 방식: Silero VAD가 말하는 구간을 찾고, SenseVoice가 지금 줄의 소리를 주기적으로 다시 받아 적는다.
 * 브라우저 음성인식처럼 보이도록 '연속 일치'로 줄을 나누고 확정한다 (줄 관리는 Session):
 *  - 두 번 연달아 같게 나온 앞부분 낱말(1초 이상 지난 것)은 고정해 다시 바뀌지 않게 한다
 *  - 고정된 낱말이 문장 끝(. ? !)이거나 40자를 넘거나 줄이 15초를 넘으면 그 자리에서 줄을 확정한다
 *  - 말이 끝나면(짧은 쉼) 고정되지 않은 뒷부분만 다시 받아 적어 붙여 확정한다
 * 스트리밍 모델보다 느리지만 훨씬 정확하다 (잔향·잡음이 있는 강의실 음성에서 특히).
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;
/** 말 시작 직전 소리도 포함 (첫 음절 잘림 방지) */
const PREROLL_SAMPLES = SAMPLE_RATE * 0.3;
/** 이보다 짧은 줄은 중간 결과를 내지 않는다 */
const MIN_INTERIM_SAMPLES = SAMPLE_RATE * 0.5;
const MIN_INTERIM_INTERVAL_MS = 500;
/** 이만큼 지난 낱말만 고정한다 (갓 들어온 끝부분은 다음 인식에서 자주 바뀐다) */
const LOCK_GUARD_SEC = 1.0;
/** 고정된 글자가 이보다 많으면 줄을 확정한다 */
const MAX_LINE_CHARS = 40;
/** 줄이 이보다 길면 마지막 낱말 앞에서 줄을 확정한다 */
const MAX_LINE_SEC = 15;

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
  getResult(s: OfflineStream): { text: string; tokens: string[]; timestamps: number[] };
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
      minSilenceDuration: 0.4, // 0.4초 쉬면 문장 확정 (0.5와 정확도 같고 0.1초 빠름)
      minSpeechDuration: 0.25,
      maxSpeechDuration: 30, // 줄은 Session이 나누므로 VAD 구간 길이 제한은 넉넉하게 (버퍼 60초 안)
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

/** 받아 적은 낱말. start/end는 세션 시작부터 센 초 */
interface Word {
  text: string;
  start: number;
  end: number;
}

/** 소리를 받아 적어 낱말 단위로 돌려준다 (토큰 앞 공백이 낱말 시작, 문장부호는 앞 낱말에 붙임) */
function transcribeWords(samples: Float32Array, offsetSec: number): Word[] {
  const s = recognizer.createStream();
  s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  recognizer.decode(s);
  const r = recognizer.getResult(s);
  const out: Word[] = [];
  r.tokens.forEach((t, i) => {
    const at = offsetSec + (r.timestamps[i] ?? 0);
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

const joinWords = (ws: Word[]) => ws.map((w) => w.text).join(' ');
const wordKey = (w: Word) => w.text.replace(/[.,?!]/g, '');
const endsSentence = (w: Word) => /[.?!]$/.test(w.text);

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * 연속 일치(local agreement)로 줄을 나누고 확정한다.
 * 강당 녹음·낭독 시험(정답 대비): 정확도는 비슷하고, 글자가 더 바뀌지 않게 되기까지 2.7초 → 1.3초,
 * 확정할 때 이미 보이던 글자가 바뀌는 일 24번(3분) → 0번.
 */
class Session {
  private readonly vad = new sherpa.Vad(vadConfig, 60);
  /** VAD 창(512) 단위로 넣고 남은 조각 */
  private pending = new Float32Array(0);
  /** 최근 소리 (말 시작 직전 부분) */
  private preroll: Float32Array[] = [];
  private prerollLen = 0;
  /** 지금 줄의 소리와 그 시작 시각 */
  private line: Float32Array[] = [];
  private lineLen = 0;
  private lineStart = 0;
  /** 지금까지 받은 소리 길이(초) */
  private clock = 0;
  private speaking = false;
  /** 고정된 낱말 (다시 바뀌지 않음) */
  private locked: Word[] = [];
  /** 마지막으로 고정한 낱말: 다음 인식 결과에서 '고정한 부분 다음'을 찾는 기준 */
  private anchor: Word | null = null;
  /** 지난 인식에서 고정되지 않은 낱말 (이번 인식과 같으면 고정) */
  private prev: Word[] = [];
  private lastInterim = '';
  private lastInterimAt = 0;
  private lastDecodeMs = 0;

  // 작업 스레드는 Node 자체의 타입 제거 방식으로 실행될 수 있어 파라미터 프로퍼티 문법을 쓰지 않는다
  private readonly id: number;
  constructor(id: number) {
    this.id = id;
  }

  accept(samples: Float32Array) {
    const buf = this.pending.length ? concat([this.pending, samples]) : samples;
    let o = 0;
    for (; o + VAD_WINDOW <= buf.length; o += VAD_WINDOW) this.vad.acceptWaveform(buf.subarray(o, o + VAD_WINDOW));
    this.pending = buf.slice(o);
    while (!this.vad.isEmpty()) this.vad.pop(); // 구간은 쓰지 않고 말하는 중인지만 본다

    const detected = this.vad.isDetected();
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
  }

  flush() {
    if (this.lineLen > MIN_INTERIM_SAMPLES) this.endLine();
    this.vad.reset();
    this.line = [];
    this.lineLen = 0;
    this.resetLocks();
    this.speaking = false;
    this.pending = new Float32Array(0);
    post({ op: 'flushed', id: this.id });
  }

  private maybeInterim() {
    const now = Date.now();
    const interval = Math.max(MIN_INTERIM_INTERVAL_MS, this.lastDecodeMs * 2);
    if (this.lineLen < MIN_INTERIM_SAMPLES || now - this.lastInterimAt < interval) return;
    const fresh = this.afterLocked(transcribeWords(concat(this.line), this.lineStart));
    this.lastDecodeMs = Date.now() - now;
    this.lastInterimAt = Date.now();

    // 두 번 연달아 같은 앞부분, 그리고 1초 이상 지난 낱말만 고정
    let n = 0;
    while (n < fresh.length && n < this.prev.length && wordKey(fresh[n]!) === wordKey(this.prev[n]!) && fresh[n]!.end < this.clock - LOCK_GUARD_SEC) n++;
    for (let i = 0; i < n; i++) this.lockWord(fresh[i]!);
    const rest = fresh.slice(n);
    // 화면에는 고정된 낱말 + 지난번 인식과도 같게 나온 뒷부분만 보인다 (이번에 처음 나온 낱말은 다음 인식에서 같으면 보임).
    // 새로 나온 끝 낱말은 다음 인식에서 자주 바뀌어, 보였다가 지워지는 일이 잦다 (강당 3분: 분당 62번 → 1번, 글자가 보이는 때는 약 0.5초 늦어짐)
    const prevRest = this.prev.slice(n);
    let agreed = 0;
    while (agreed < rest.length && agreed < prevRest.length && wordKey(rest[agreed]!) === wordKey(prevRest[agreed]!)) agreed++;
    this.prev = rest;
    this.sendInterim(joinWords([...this.locked, ...rest.slice(0, agreed)]));

    // 줄 확정: 고정된 낱말이 문장 끝이면 거기서, 고정 글자가 많거나 줄이 너무 길면 지금까지
    const si = this.locked.findIndex(endsSentence);
    if (si >= 0) {
      const carry = this.locked.slice(si + 1);
      this.finishLine(this.locked.slice(0, si + 1), carry[0]?.start ?? rest[0]?.start ?? this.clock);
      for (const w of carry) this.lockWord(w);
    } else if (this.locked.reduce((a, w) => a + w.text.length, 0) >= MAX_LINE_CHARS) {
      this.finishLine(this.locked, rest[0]?.start ?? this.clock);
    } else if (this.lineLen / SAMPLE_RATE > MAX_LINE_SEC && rest.length > 1) {
      this.finishLine([...this.locked, ...rest.slice(0, -1)], rest[rest.length - 1]!.start);
    }
  }

  /** 말이 끝났을 때: 고정되지 않은 뒷부분만 다시 받아 적어 붙여 확정 */
  private endLine() {
    const tail = this.afterLocked(transcribeWords(concat(this.line), this.lineStart));
    const text = joinWords([...this.locked, ...tail]);
    if (text) post({ op: 'result', id: this.id, kind: 'final', text });
    this.line = [];
    this.lineLen = 0;
    this.resetLocks();
  }

  /** 낱말들을 한 줄로 확정하고, cutSec 앞의 소리를 버려 다음 줄을 시작한다 */
  private finishLine(words: Word[], cutSec: number) {
    const text = joinWords(words);
    if (text) post({ op: 'result', id: this.id, kind: 'final', text });
    const all = concat(this.line);
    const cut = Math.max(0, Math.min(all.length, Math.round((cutSec - 0.02 - this.lineStart) * SAMPLE_RATE)));
    this.line = [all.subarray(cut)];
    this.lineLen = all.length - cut;
    this.lineStart += cut / SAMPLE_RATE;
    this.resetLocks();
  }

  private lockWord(w: Word) {
    this.locked.push(w);
    this.anchor = w;
  }

  private resetLocks() {
    this.locked = [];
    this.anchor = null;
    this.prev = [];
    this.lastInterim = '';
    this.lastInterimAt = 0;
  }

  /** 인식 결과에서 이미 고정한 부분 다음만 고른다: 마지막 고정 낱말을 글자로 찾고(±0.5초), 못 찾으면 시각으로 */
  private afterLocked(ws: Word[]): Word[] {
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
  }

  private sendInterim(text: string) {
    if (!text || text === this.lastInterim) return;
    this.lastInterim = text;
    post({ op: 'result', id: this.id, kind: 'interim', text });
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
