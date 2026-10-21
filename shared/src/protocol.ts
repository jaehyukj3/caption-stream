/**
 * 송출자·수신자·서버가 공유하는 타입과 WebSocket 메시지 프로토콜.
 * 모든 메시지는 JSON 텍스트 프레임이며 `type` 필드로 구분한다.
 */

/** 확정된 자막 한 줄. seq는 방 안에서 1부터 단조 증가한다. */
export interface CaptionLine {
  seq: number;
  text: string;
  /** 서버 수신 시각 (epoch ms) */
  ts: number;
}

export type Role = 'host' | 'viewer';

// ───────── 클라이언트 → 서버 ─────────

export interface JoinMessage {
  type: 'join';
  code: string;
  role: Role;
  /** role=host일 때 필수 */
  hostToken?: string;
  /** 재연결 시 마지막으로 받은 seq. 이후 문장만 history로 받는다. */
  sinceSeq?: number;
}

export interface InterimUpMessage {
  type: 'interim';
  text: string;
}

export interface FinalUpMessage {
  type: 'final';
  text: string;
}

export interface EndMessage {
  type: 'end';
}

export type ClientMessage = JoinMessage | InterimUpMessage | FinalUpMessage | EndMessage;

// ───────── 서버 → 클라이언트 ─────────

export interface JoinedMessage {
  type: 'joined';
  role: Role;
  code: string;
  /** 이미 종료된 세션인지 */
  ended: boolean;
}

export interface HistoryMessage {
  type: 'history';
  lines: CaptionLine[];
}

export interface InterimDownMessage {
  type: 'interim';
  /** 빈 문자열이면 중간 결과를 지운다 */
  text: string;
}

export interface FinalDownMessage {
  type: 'final';
  line: CaptionLine;
}

export interface ViewerCountMessage {
  type: 'viewerCount';
  count: number;
}

export interface SessionEndMessage {
  type: 'sessionEnd';
}

export type ErrorCode = 'ROOM_NOT_FOUND' | 'NOT_HOST' | 'NOT_JOINED' | 'BAD_MESSAGE' | 'SESSION_ENDED';

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

/**
 * 송출자에게만: 참석자에게 보여줄 중계 주소 상태 (QR에 쓰임).
 * relayViewerUrl에는 복호화 키(#k=...)가 들어 있으므로 송출자 외에는 보내지 않는다.
 */
export interface ShareMessage {
  type: 'share';
  relay: RelayState;
  relayViewerUrl: string | null;
}

export type RelayState = 'off' | 'connecting' | 'online' | 'offline';

export type ServerMessage =
  | ShareMessage
  | JoinedMessage
  | HistoryMessage
  | InterimDownMessage
  | FinalDownMessage
  | ViewerCountMessage
  | SessionEndMessage
  | ErrorMessage;

// ───────── HTTP API ─────────

/** POST /api/rooms 응답 */
export interface CreateRoomResponse {
  code: string;
  hostToken: string;
}

/** GET /api/rooms/:code 응답 */
export interface RoomStatusResponse {
  code: string;
  ended: boolean;
  lineCount: number;
}

/** GET /api/net-info 응답: 휴대폰이 접속할 수 있는 주소 후보 */
export interface NetInfoResponse {
  /** PUBLIC_URL 환경변수가 있으면 그 값 */
  publicUrl: string | null;
  /** 서버 머신의 LAN IPv4 주소들 */
  lanAddresses: string[];
  /**
   * 같은 와이파이 참석자용 포트. null이면 지금 페이지와 같은 포트(서버가 처음부터 모든 주소에서 받는 경우).
   * 노트북 실행에서는 방화벽 창을 피하려고 평소엔 노트북 안에서만 받다가, 필요할 때 이 포트를 연다.
   */
  lanPort: number | null;
  /** 같은 와이파이 접속이 지금 열려 있는지 (닫혀 있으면 POST /api/lan 으로 연다) */
  lanEnabled: boolean;
}

// ───────── 상수 ─────────

export const WS_PATH = '/ws';
export const ROOM_CODE_LENGTH = 6;
/** interim 최소 간격 (초당 최대 4회) */
export const INTERIM_MIN_INTERVAL_MS = 250;
/** 방 유지 시간: 송출자 마지막 활동(또는 종료) 이후 */
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
/** 방 하나에 보관하는 확정 문장 최대 수 */
export const MAX_HISTORY_LINES = 5000;
/** 문장 한 개의 최대 길이 (비정상 입력 방어) */
export const MAX_TEXT_LENGTH = 2000;

export function isValidRoomCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

// ───────── 로컬 음성인식 (/stt) ─────────
// 송출 화면 → 서버: 16kHz mono Int16 LE PCM 바이너리 프레임, 또는 아래 JSON 텍스트 프레임
// 같은 노트북(localhost)에서 온 연결만 받는다. 음성은 노트북 밖으로 나가지 않는다.

export const STT_PATH = '/stt';
export const STT_SAMPLE_RATE = 16000;

export interface SttFlushMessage {
  /** 말하던 문장을 확정시킨다(일시정지·종료 직전). 서버는 final(있으면) 후 flushed로 답한다. */
  type: 'flush';
}

export type SttServerMessage =
  | { type: 'ready' }
  | { type: 'interim'; text: string }
  | { type: 'final'; text: string }
  | { type: 'flushed' }
  | { type: 'error'; code: 'NO_MODEL' | 'NOT_LOCAL' | 'ENGINE_ERROR'; message: string };

/** GET /api/stt-status 응답 */
export interface SttStatusResponse {
  available: boolean;
  message?: string;
}

// ───────── 중계 서버 (와이파이 없이 LTE로 받기) ─────────
// 노트북 ↔ 중계 서버 ↔ 참석자. 중계 서버는 암호문만 전달하며 내용을 볼 수 없다.
// 참석자 → 노트북 메시지(join 등)도 암호화되어 노트북이 위 프로토콜 그대로 처리한다.

export const RELAY_WS_PATH = '/relay';

/** 노트북(송출 쪽) → 중계 */
export type RelayUpMessage =
  | { t: 'hello'; token: string }
  | { t: 'broadcast'; data: string }
  | { t: 'to'; id: string; data: string };

/** 중계 → 노트북 */
export type RelayDownMessage =
  | { t: 'welcome' }
  | { t: 'sub-join'; id: string }
  | { t: 'sub-leave'; id: string }
  | { t: 'sub-msg'; id: string; data: string }
  | { t: 'denied'; reason: string };


