import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  isValidRoomCode,
  MAX_TEXT_LENGTH,
  WS_PATH,
  type ClientMessage,
  type ErrorCode,
  type Role,
  type ServerMessage,
} from '@caption/shared';
import type { Room } from './Room.js';
import type { RoomManager } from './RoomManager.js';

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

interface ConnState {
  room: Room | null;
  role: Role | null;
  alive: boolean;
}

export function attachWebSocket(server: Server, rooms: RoomManager): WebSocketServer {
  // 자막 텍스트만 오가므로 프레임 크기를 작게 제한
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 16 * 1024 });
  const states = new WeakMap<WebSocket, ConnState>();

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const state: ConnState = { room: null, role: null, alive: true };
    states.set(ws, state);

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return sendError(ws, 'BAD_MESSAGE', 'binary not supported');
      const msg = parse(raw.toString());
      if (!msg) return sendError(ws, 'BAD_MESSAGE', 'invalid message');
      handle(ws, state, msg, rooms);
    });

    ws.on('close', () => {
      state.room?.removePeer(ws);
      state.room = null;
    });

    ws.on('error', () => ws.terminate());
  });

  // 응답 없는 연결(휴대폰 잠금, 네트워크 전환 등) 정리
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = states.get(ws);
      if (!state) continue;
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function handle(ws: WebSocket, state: ConnState, msg: ClientMessage, rooms: RoomManager): void {
  if (msg.type === 'join') {
    if (state.room) return sendError(ws, 'BAD_MESSAGE', 'already joined');
    const room = isValidRoomCode(msg.code) ? rooms.get(msg.code) : undefined;
    if (!room) return sendError(ws, 'ROOM_NOT_FOUND', '존재하지 않거나 만료된 방입니다.');
    if (msg.role === 'host' && !rooms.verifyHost(room, msg.hostToken)) {
      return sendError(ws, 'NOT_HOST', '송출 권한이 없습니다.');
    }
    state.room = room;
    state.role = msg.role;
    room.addPeer(ws, msg.role, msg.sinceSeq ?? 0);
    return;
  }

  if (!state.room) return sendError(ws, 'NOT_JOINED', 'join first');
  if (state.role !== 'host') return sendError(ws, 'NOT_HOST', '송출자만 보낼 수 있습니다.');
  if (state.room.ended) return sendError(ws, 'SESSION_ENDED', '이미 종료된 세션입니다.');

  switch (msg.type) {
    case 'interim':
      state.room.pushInterim(msg.text);
      break;
    case 'final': {
      const text = msg.text.trim();
      if (text) state.room.pushFinal(text);
      break;
    }
    case 'end':
      state.room.end();
      break;
  }
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

function sendError(ws: WebSocket, code: ErrorCode, message: string): void {
  const msg: ServerMessage = { type: 'error', code, message };
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
