import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { SttServerMessage } from '@caption/shared';
import { loadSttEngine, SttSession, sttStatus } from './SttEngine.js';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 음성은 이 노트북 안에서만 오가야 한다.
 * 접속 주소가 루프백이고, Host 헤더도 localhost여야 한다
 * (개발 모드에서 Vite 프록시를 거쳐 LAN에서 들어오는 경우까지 막기 위해).
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_ADDRS.has(req.socket.remoteAddress ?? '') && LOCAL_HOSTNAMES.has(host);
}

export function createSttWebSocketServer(): WebSocketServer {
  // 100ms PCM ≈ 3.2KB. 여유 있게 잡되 큰 프레임은 거부
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const send = (msg: SttServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    if (!isLocalRequest(req)) {
      send({ type: 'error', code: 'NOT_LOCAL', message: '음성인식은 강사 노트북에서 http://localhost 주소로 연 송출 화면에서만 쓸 수 있습니다.' });
      ws.close();
      return;
    }
    if (!loadSttEngine()) {
      send({ type: 'error', code: 'NO_MODEL', message: sttStatus().message! });
      ws.close();
      return;
    }
    if (!sttStatus().available) {
      send({ type: 'error', code: 'ENGINE_ERROR', message: sttStatus().message! });
      ws.close();
      return;
    }

    const session = new SttSession(
      (text) => send({ type: 'interim', text }),
      (text) => send({ type: 'final', text }),
    );
    send({ type: 'ready' });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        session.acceptPcm16(data as Buffer);
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'flush') {
          await session.flush();
          send({ type: 'flushed' });
        }
      } catch {
        /* 잘못된 메시지 무시 */
      }
    });
    ws.on('close', () => session.close());
  });

  return wss;
}
