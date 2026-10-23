import type { SttDiag, SttError, SttProvider } from './SttProvider';

// Web Speech API는 TS DOM 타입에 없거나 버전마다 달라 필요한 부분만 선언한다.
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}
interface RecognitionErrorEvent {
  readonly error: string;
  readonly message: string;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** 사용자가 고칠 때까지 재시작해도 소용없는 오류 */
const FATAL_ERRORS: Record<string, string> = {
  'not-allowed': '마이크 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요.',
  'service-not-allowed': '이 브라우저/주소에서는 음성인식을 사용할 수 없습니다. HTTPS 또는 localhost로 접속했는지 확인해 주세요.',
  'audio-capture': '마이크를 찾을 수 없습니다. 마이크 연결 상태를 확인해 주세요.',
  'language-not-supported': '한국어 인식을 지원하지 않는 환경입니다.',
};

const MAX_RESTART_DELAY_MS = 5000;
/**
 * 이 시간 안에 같은(또는 이어 붙은·고쳐진) 문장이 다시 오면 중복으로 본다.
 * 휴대폰 크롬은 확정한 긴 문장을 30초쯤 뒤에 앞부분을 고치거나 뒤를 늘려 다시 보내기도 한다.
 */
const DUPLICATE_WINDOW_MS = 60_000;
/** 앞부분이 이만큼 같으면 같은 문장을 고친 것으로 본다 (글자 기준) */
const REVISION_SIMILARITY = 0.8;
/** 짧은 문장은 비슷한 다른 문장일 수 있어("1번 확인", "2번 확인") 고친 것으로 보지 않는다 */
const REVISION_MIN_CHARS = 12;
/** 길이가 거의 같은 고침은 바로 다시 온 것만 (실제 크롬은 1~2초 안에 고쳐 보낸다) */
const CORRECTION_WINDOW_MS = 5_000;
/** 이만큼 이상 늘어났으면 '고친 뒤 이어 말한 것' */
const EXTENSION_MIN_CHARS = 5;
const IGNORED = /[\s.,?!]/;
/** 잠시 쉬면(이어지는 결과가 없으면) 한 줄로 확정 */
const COMMIT_DELAY_MS = 900;
const norm = (s: string) => s.replace(/[\s.,?!]/g, '').toLowerCase();

/** 두 문자열의 편집 거리 */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * b가 a를 고쳐 다시 보낸 것인지: 'same'(같거나 a의 앞부분만 다시 옴), 'revised'(고쳐졌거나 고친 뒤 늘어남), 'different'
 * elapsedMs: a를 확정한 뒤 지난 시간
 */
function compareRevision(a: string, b: string, elapsedMs: number): 'same' | 'revised' | 'different' {
  const x = norm(a);
  const y = norm(b);
  if (x.length < REVISION_MIN_CHARS || y.length < REVISION_MIN_CHARS) return 'different';
  if (x.startsWith(y)) return 'same';
  if (y.length < x.length + EXTENSION_MIN_CHARS && elapsedMs > CORRECTION_WINDOW_MS) return 'different';
  // 고치면서 글자 수가 조금 달라질 수 있어(예: "2조" → "초") b의 앞부분을 a 길이 ±3 범위에서 맞춰 본다
  let best = Infinity;
  for (let n = Math.max(1, x.length - 3); n <= Math.min(y.length, x.length + 3); n++) best = Math.min(best, editDistance(x, y.slice(0, n)));
  if (1 - best / x.length >= REVISION_SIMILARITY) return 'revised';
  // 더 짧게 다시 온 것이 a의 앞부분과 비슷하면 그냥 재전송
  return y.length < x.length && 1 - editDistance(x.slice(0, y.length), y) / y.length >= REVISION_SIMILARITY ? 'same' : 'different';
}

/** text가 prefix로 시작하면(공백·문장부호 무시) 그 부분을 뺀 나머지 */
function stripPrefix(text: string, prefix: string): string {
  const p = norm(prefix);
  const n = norm(text);
  if (!p || !n.startsWith(p)) return text;
  let seen = 0;
  let i = 0;
  for (; i < text.length && seen < p.length; i++) if (!IGNORED.test(text[i]!)) seen++;
  return text.slice(i).replace(/^[\s.,?!]+/, '').trim();
}

/**
 * 크롬 Web Speech API 구현.
 * 크롬은 침묵·네트워크 오류·약 1분 경과 등으로 인식을 스스로 끝내므로(onend)
 * 사용자가 멈춘 게 아니면 자동으로 다시 시작한다.
 */
export class WebSpeechProvider implements SttProvider {
  readonly isSupported = !!getCtor();

  private rec: Recognition | null = null;
  private running = false;
  private lastInterim = '';
  /** 브라우저가 준 지금의 중간 결과 그대로 */
  private rawInterim = '';
  /** 확정됐지만 아직 내보내지 않은 문장 (이어지는 결과를 기다리는 중) */
  private pending = '';
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFinal = '';
  private lastFinalAt = 0;
  /** 마지막 줄을 낼 때 앞에서 빼낸 부분 (누적형 결과에서 이전 문장). 고칠 때도 똑같이 뺀다. */
  private lastLineBase = '';
  /** 이번 인식 세션에서 확정으로 낸 결과: 번호 → 내용 */
  private readonly finalized = new Map<number, string>();
  private restartDelay = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;

  private interimCb: (t: string) => void = () => {};
  private finalCb: (t: string) => void = () => {};
  private errorCb: (e: SttError) => void = () => {};
  private reviseCb: (t: string) => void = () => {};
  private diagCb: (e: SttDiag) => void = () => {};

  constructor(private readonly lang = 'ko-KR') {}

  onInterim(cb: (text: string) => void) {
    this.interimCb = cb;
  }
  onFinal(cb: (text: string) => void) {
    this.finalCb = cb;
  }
  onError(cb: (err: SttError) => void) {
    this.errorCb = cb;
  }
  onRevise(cb: (text: string) => void) {
    this.reviseCb = cb;
  }
  onDiag(cb: (e: SttDiag) => void) {
    this.diagCb = cb;
  }

  async start(): Promise<void> {
    const Ctor = getCtor();
    if (!Ctor) {
      const err = { fatal: true, code: 'unsupported', message: '이 브라우저는 음성인식을 지원하지 않습니다. 크롬(또는 엣지)을 사용해 주세요.' };
      this.errorCb(err);
      throw new Error(err.message);
    }
    if (this.running) return;
    this.running = true;
    this.restartDelay = 0;

    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => this.handleResult(e);
    rec.onerror = (e) => this.handleError(e);
    rec.onend = () => this.handleEnd();
    rec.onstart = () => this.diagCb({ type: 'listening' });
    this.rec = rec;
    this.startRecognition();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onend = null;
      rec.onstart = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.abort();
    }
    this.flushInterimAsFinal();
    this.commit();
  }

  private startRecognition() {
    if (!this.rec || !this.running) return;
    this.startedAt = Date.now();
    this.finalized.clear(); // 결과 번호는 인식 세션마다 0부터 다시 매겨진다
    try {
      this.rec.start();
    } catch {
      // 이미 시작된 상태(InvalidStateError)면 무시. onend에서 다시 시도된다.
    }
  }

  private handleResult(e: RecognitionEvent) {
    let interim = '';
    // 안드로이드 크롬은 resultIndex를 늘 0으로 주고 이미 확정된 결과를 매번 다시 보낸다.
    // 그래서 처음부터 훑되, 이번 인식 세션에서 같은 번호·같은 내용으로 이미 받은 확정 결과는 건너뛴다.
    // (번호 0을 새 문장마다 다시 쓰는 브라우저도 있어 번호만으로는 판단하지 않는다)
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) {
        const key = norm(r[0].transcript);
        if (this.finalized.get(i) === key) continue;
        this.finalized.set(i, key);
        this.stage(r[0].transcript);
      } else {
        interim += r[0].transcript;
      }
    }
    this.rawInterim = interim.trim();
    this.showInterim();
    // 결과가 들어온다는 건 정상 동작 중이라는 뜻
    this.restartDelay = 0;
  }

  /**
   * 확정 결과를 바로 내보내지 않고 잠깐 붙잡아 둔다.
   * 휴대폰 브라우저는 한 문장을 말하는 동안에도 "오늘은" → "오늘은 개인정보" → … 처럼
   * 앞부분을 포함한 확정 결과를 여러 번 보내는데, 이를 하나씩 내보내면 같은 자막이 반복되거나
   * 한 단어씩 잘린다. 이어지는 결과면 갱신하고, 잠시 쉬거나 다른 문장이 오면 그때 한 줄로 확정한다.
   */
  private stage(raw: string) {
    const text = raw.trim();
    if (!text) return;
    const t = norm(text);
    if (this.pending) {
      const p = norm(this.pending);
      if (t.startsWith(p)) this.pending = text; // 이어서 말한 부분까지 포함 → 갱신
      else if (!p.startsWith(t)) {
        this.commit(); // 다른 문장 → 앞 문장을 확정하고 새로 시작
        this.pending = text;
      } // 더 짧은 재전송은 무시
    } else {
      const recent = Date.now() - this.lastFinalAt < DUPLICATE_WINDOW_MS;
      const prev = norm(this.lastFinal);
      if (recent && prev.startsWith(t)) return; // 방금 확정한 문장(또는 그 앞부분)이 다시 옴
      this.pending = text;
    }
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => this.commit(), COMMIT_DELAY_MS);
  }

  /** 붙잡아 둔 문장을 한 줄로 확정 (이미 확정한 앞부분은 빼고) */
  private commit() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    if (!this.pending) return;
    const text = this.pending;
    this.pending = '';
    const recent = this.lastFinal && Date.now() - this.lastFinalAt < DUPLICATE_WINDOW_MS;
    // 이어 붙은 결과(앞부분이 그대로)는 새로 늘어난 부분만 새 줄로
    const fresh = this.withoutPrevious(text);
    if (!fresh) return this.showInterim(); // 방금 낸 문장 그대로 다시 옴
    if (recent && fresh === text) {
      // 앞부분이 그대로가 아니면, 방금 낸 줄을 고쳐 다시 보낸 것인지 본다
      const rel = compareRevision(this.lastFinal, text, Date.now() - this.lastFinalAt);
      if (rel !== 'different') {
        if (rel === 'revised') {
          this.lastFinal = text;
          this.lastFinalAt = Date.now();
          const line = this.lastLineBase ? stripPrefix(text, this.lastLineBase) : text;
          this.reviseCb(line);
        }
        this.showInterim();
        return;
      }
    }
    this.lastLineBase = fresh === text ? '' : this.lastFinal;
    this.lastFinal = text;
    this.lastFinalAt = Date.now();
    if (fresh) this.finalCb(fresh);
    this.showInterim();
  }

  /** 흐린 글씨: 아직 확정 전인 문장 + 지금 말하는 중인 부분 (이미 보여 준 앞부분은 빼고) */
  private showInterim() {
    const pending = this.withoutPrevious(this.pending);
    let live = this.withoutPrevious(this.rawInterim);
    if (this.pending) live = stripPrefix(live, this.pending);
    const text = [pending, live].filter(Boolean).join(' ');
    if (text !== this.lastInterim) {
      this.lastInterim = text;
      this.interimCb(text);
    }
  }

  /** 직전에 확정한 문장으로 시작하면 그 부분을 뺀 나머지 (누적형 결과 대응) */
  private withoutPrevious(text: string): string {
    if (!this.lastFinal || Date.now() - this.lastFinalAt > DUPLICATE_WINDOW_MS) return text;
    return stripPrefix(text, this.lastFinal);
  }

  private handleError(e: RecognitionErrorEvent) {
    if (e.error !== 'aborted') this.diagCb({ type: 'error', detail: e.error });
    // no-speech(침묵), aborted(재시작 과정)는 정상 흐름이다
    if (e.error === 'no-speech' || e.error === 'aborted') return;

    const fatalMessage = FATAL_ERRORS[e.error];
    if (fatalMessage) {
      this.errorCb({ fatal: true, code: e.error, message: fatalMessage });
      void this.stop();
      return;
    }
    // network 등 일시적 오류: onend에서 백오프 후 재시작
    this.restartDelay = Math.min(Math.max(this.restartDelay * 2, 500), MAX_RESTART_DELAY_MS);
    this.errorCb({
      fatal: false,
      code: e.error,
      message: e.error === 'network' ? '음성인식 서버 연결이 불안정합니다. 다시 연결하는 중…' : `음성인식 오류(${e.error}), 다시 시작합니다.`,
    });
  }

  private handleEnd() {
    this.diagCb({ type: 'stopped' });
    // 크롬은 확정되지 않은 중간 결과를 남긴 채 끝나기도 한다. 버리지 않고 확정으로 처리.
    this.flushInterimAsFinal();
    if (!this.running) return;

    // 시작하자마자 바로 끝나는 상황이 반복되면 과도한 재시작을 막는다
    if (Date.now() - this.startedAt < 1000) {
      this.restartDelay = Math.min(Math.max(this.restartDelay * 2, 300), MAX_RESTART_DELAY_MS);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startRecognition();
    }, this.restartDelay);
  }

  /** 끝나거나 멈출 때 남아 있던 중간 결과도 버리지 않고 확정 후보로 넣는다 */
  private flushInterimAsFinal() {
    const t = this.rawInterim;
    this.rawInterim = '';
    if (t) this.stage(t);
  }

}
