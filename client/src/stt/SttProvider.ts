/**
 * 음성인식 엔진 추상화.
 * - LocalSttProvider: 노트북 안에서 도는 엔진 (기본, 음성이 외부로 나가지 않음)
 * - WebSpeechProvider: 크롬 내장(Google 서버) — 개발·비교용
 */
export interface SttProvider {
  readonly isSupported: boolean;
  /** 마이크 권한 요청 포함. 실패하면 onError로도 알린다. */
  start(): Promise<void>;
  /** 말하던 문장까지 확정(onFinal)한 뒤 끝난다 */
  stop(): Promise<void>;
  onInterim(cb: (text: string) => void): void;
  onFinal(cb: (text: string) => void): void;
  onError(cb: (err: SttError) => void): void;
}

export interface SttError {
  /** fatal이면 엔진이 멈춘 상태이며 사용자가 다시 시작해야 한다 */
  fatal: boolean;
  code: string;
  message: string;
}
