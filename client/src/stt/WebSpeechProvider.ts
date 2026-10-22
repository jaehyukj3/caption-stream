import type { SttError, SttProvider } from './SttProvider';

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
/** 이 시간 안에 같은(또는 이어 붙은) 문장이 다시 오면 중복으로 본다 */
const DUPLICATE_WINDOW_MS = 10_000;
const IGNORED = /[\s.,?!]/;
const norm = (s: string) => s.replace(/[\s.,?!]/g, '');

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
  private lastFinal = '';
  private lastFinalAt = 0;
  private readonly finalized = new Set<number>();
  private restartDelay = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;

  private interimCb: (t: string) => void = () => {};
  private finalCb: (t: string) => void = () => {};
  private errorCb: (e: SttError) => void = () => {};

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
      rec.onresult = null;
      rec.onerror = null;
      rec.abort();
    }
    this.flushInterimAsFinal();
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
    // 그래서 처음부터 훑되, 이번 인식 세션에서 이미 낸 확정 결과(번호)는 건너뛴다.
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) {
        if (this.finalized.has(i)) continue;
        this.finalized.add(i);
        this.emitFinal(r[0].transcript);
      } else {
        interim += r[0].transcript;
      }
    }
    interim = this.withoutPrevious(interim.trim());
    if (interim !== this.lastInterim) {
      this.lastInterim = interim;
      this.interimCb(interim);
    }
    // 결과가 들어온다는 건 정상 동작 중이라는 뜻
    this.restartDelay = 0;
  }

  /**
   * 확정 문장 내보내기. 기기·브라우저별 반복 버그를 걸러 낸다.
   *  - 같은 문장이 곧바로 다시 오는 경우(재시작 직후 등) → 버림
   *  - 앞 문장에 이어 붙은 누적 결과("안녕하세요" → "안녕하세요 여러분") → 새로 붙은 부분만
   */
  private emitFinal(raw: string) {
    const text = raw.trim();
    this.lastInterim = '';
    if (!text) return;
    const recent = Date.now() - this.lastFinalAt < DUPLICATE_WINDOW_MS;
    if (recent && norm(text) === norm(this.lastFinal)) return;
    const fresh = this.withoutPrevious(text);
    this.lastFinal = text;
    this.lastFinalAt = Date.now();
    if (fresh) this.finalCb(fresh);
  }

  /** 직전 확정 문장으로 시작하면 그 부분을 뺀 나머지 (누적형 결과 대응) */
  private withoutPrevious(text: string): string {
    const prev = norm(this.lastFinal);
    if (!prev || Date.now() - this.lastFinalAt > DUPLICATE_WINDOW_MS) return text;
    const n = norm(text);
    if (n === prev) return '';
    if (!n.startsWith(prev)) return text;
    // 공백·문장부호를 무시하고 앞 문장 길이만큼 건너뛴다
    let seen = 0;
    let i = 0;
    for (; i < text.length && seen < prev.length; i++) if (!IGNORED.test(text[i]!)) seen++;
    return text.slice(i).replace(/^[\s.,?!]+/, '').trim();
  }

  private handleError(e: RecognitionErrorEvent) {
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

  private flushInterimAsFinal() {
    const t = this.lastInterim;
    this.lastInterim = '';
    if (t) this.emitFinal(t);
  }
}
