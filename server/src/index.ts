import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_PATH } from '@caption/shared';
import { createHttpHandler } from './http.js';
import { RoomManager } from './RoomManager.js';
import { attachWebSocket } from './socket.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

// 운영 모드에서는 빌드된 클라이언트(client/dist)도 이 서버가 서빙한다
const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '../../client/dist');
const staticDir = process.env.NODE_ENV === 'production' && existsSync(distDir) ? distDir : null;

const rooms = new RoomManager();
rooms.start();

const server = createServer(createHttpHandler(rooms, staticDir));
const wss = attachWebSocket(server, rooms);

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}  (ws: ${WS_PATH})`);
  console.log(staticDir ? `[server] serving client from ${staticDir}` : '[server] API only (client는 Vite dev 서버 사용)');
});

function shutdown(): void {
  rooms.stop();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
