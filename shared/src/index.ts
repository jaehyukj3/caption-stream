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

export type ServerMessage =
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
