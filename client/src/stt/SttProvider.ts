/**
 * 음성인식 엔진 추상화. Web Speech API 외에 Google/Azure/Clova 스트리밍 STT로
 * 바꿀 때는 이 인터페이스를 구현한 클래스만 추가하면 된다.
 */
export interface SttProvider {
  readonly isSupported: boolean;
  /** 마이크 권한 요청 포함. 실패하면 onError로도 알린다. */
  start(): Promise<void>;
  stop(): void;
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
