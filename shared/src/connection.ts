import {
  isValidRoomCode,
  MAX_TEXT_LENGTH,
  type ClientMessage,
  type ErrorCode,
  type Role,
  type ServerMessage,
} from './protocol.js';
import type { Peer, Room } from './room.js';

/** 코드로 방을 찾고 송출 권한을 확인하는 곳 (노트북 서버: RoomManager, 웹 송출: 방 하나) */
export interface RoomDirectory {
  get(code: string): Room | undefined;
  verifyHost(room: Room, token: string | undefined): boolean;
}

/**
 * 연결 하나(직접 WebSocket 또는 중계 서버를 거친 원격 수신자)의 메시지 처리.
 * 전송 방식과 무관하게 같은 규칙으로 방에 입장시키고 자막을 받는다.
 */
export interface Connection {
  handleRaw(raw: string): void;
  close(): void;
}

export function openConnection(peer: Peer, rooms: RoomDirectory, opts: { allowHost: boolean }): Connection {
  let room: Room | null = null;
  let role: Role | null = null;
  const fail = (code: ErrorCode, message: string) => peer.send(JSON.stringify({ type: 'error', code, message } satisfies ServerMessage));

  function handle(msg: ClientMessage): void {
    if (msg.type === 'join') {
      if (room) return fail('BAD_MESSAGE', 'already joined');
      const target = isValidRoomCode(msg.code) ? rooms.get(msg.code) : undefined;
      if (!target) return fail('ROOM_NOT_FOUND', '존재하지 않거나 만료된 방입니다.');
      if (msg.role === 'host' && (!opts.allowHost || !rooms.verifyHost(target, msg.hostToken))) {
        return fail('NOT_HOST', '송출 권한이 없습니다.');
      }
      room = target;
      role = msg.role;
      room.addPeer(peer, msg.role, msg.sinceSeq ?? 0);
      return;
    }

    if (!room) return fail('NOT_JOINED', 'join first');
    if (role !== 'host') return fail('NOT_HOST', '송출자만 보낼 수 있습니다.');
    if (room.ended) return fail('SESSION_ENDED', '이미 종료된 세션입니다.');

    switch (msg.type) {
      case 'interim':
        room.pushInterim(msg.text);
        break;
      case 'final': {
        const text = msg.text.trim();
        if (text) room.pushFinal(text);
        break;
      }
      case 'end':
        room.end();
        break;
    }
  }

  return {
    handleRaw(raw) {
      const msg = parse(raw);
      if (!msg) return fail('BAD_MESSAGE', 'invalid message');
      handle(msg);
    },
    close() {
      room?.removePeer(peer);
      room = null;
    },
  };
}

/** 신뢰할 수 없는 입력을 ClientMessage로 검증 */
function parse(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT_LENGTH;

  switch (m.type) {
    case 'join':
      if (typeof m.code !== 'string' || (m.role !== 'host' && m.role !== 'viewer')) return null;
      if (m.hostToken !== undefined && typeof m.hostToken !== 'string') return null;
      if (m.sinceSeq !== undefined && (typeof m.sinceSeq !== 'number' || !Number.isInteger(m.sinceSeq))) return null;
      return {
        type: 'join',
        code: m.code,
        role: m.role,
        hostToken: m.hostToken as string | undefined,
        sinceSeq: m.sinceSeq as number | undefined,
      };
    case 'interim':
    case 'final':
      return isText(m.text) ? { type: m.type, text: m.text } : null;
    case 'end':
      return { type: 'end' };
    default:
      return null;
  }
}
