import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { openConnection } from '@caption/shared';
import type { RoomManager } from './RoomManager.js';

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/** 자막 방 WebSocket (같은 네트워크의 직접 연결). 업그레이드 라우팅은 index.ts에서 경로별로 한다. */
export function createRoomWebSocketServer(rooms: RoomManager): WebSocketServer {
  // 자막 텍스트만 오가므로 프레임 크기를 작게 제한
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    alive.set(ws, true);
    const conn = openConnection({ send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d) }, rooms, { allowHost: true });

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      conn.handleRaw(raw.toString());
    });
    ws.on('close', () => conn.close());
    ws.on('error', () => ws.terminate());
  });

  // 응답 없는 연결(휴대폰 잠금, 네트워크 전환 등) 정리
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
