/**
 * 음성인식 엔진 추상화.
 * - LocalSttProvider: 노트북 안에서 도는 엔진 (기본, 음성이 외부로 나가지 않음)
 * - WebSpeechProvider: 크롬·사파리 내장(Google·Apple 서버) — 웹 송출용
 * - OnDeviceSttProvider: 폰·PC 브라우저 안에서 도는 엔진(WebAssembly) — 웹 송출용, 음성이 기기 밖으로 나가지 않음
 * - NativeSttProvider: 안드로이드 앱 안에서 도는 엔진 — 같은 모델을 폰 CPU 여러 코어로, 음성이 기기 밖으로 나가지 않음
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
  /** 방금 확정한 문장을 고친 결과 (새 줄을 추가하지 않고 마지막 줄을 바꾼다) */
  onRevise?(cb: (text: string) => void): void;
  /** 사용할 마이크 (없으면 Windows 기본 마이크). 다음 start()부터 적용 */
  setDeviceId?(deviceId: string | null): void;
  /** 최근 몇 초 동안 엔진으로 보낸 소리 (16kHz Int16, 진단용). 지원하는 엔진만. */
  recentAudio?(): Int16Array | null;
  /** 진단용 이벤트 (테스트 기록): 인식이 실제로 듣기 시작/멈춤, 오류 */
  onDiag?(cb: (e: SttDiag) => void): void;
}

export interface SttDiag {
  /** decode: 기기 안 인식 1회 (detail = 인식 ms/말소리 ms) */
  type: 'listening' | 'stopped' | 'error' | 'decode';
  detail?: string;
}

export interface SttError {
  /** fatal이면 엔진이 멈춘 상태이며 사용자가 다시 시작해야 한다 */
  fatal: boolean;
  code: string;
  message: string;
}
