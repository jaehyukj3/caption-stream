import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STT_PATH, WS_PATH } from '@caption/shared';
import { createHttpHandler } from './http.js';
import { RoomManager } from './RoomManager.js';
import { createRoomWebSocketServer } from './socket.js';
import { desktopMode, isAlreadyRunning, openBrowser, printGuide } from './desktop.js';
import { loadSttEngine, sttStatus } from './stt/SttEngine.js';
import { createSttWebSocketServer } from './stt/sttSocket.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

// 빌드된 화면이 있으면 이 서버가 화면까지 서빙한다 (노트북 실행·운영 모드).
// 배포 패키지는 STATIC_DIR로 위치를 알려 준다.
const here = dirname(fileURLToPath(import.meta.url));
const distDir = process.env.STATIC_DIR ?? resolve(here, '../../client/dist');
const staticDir = existsSync(distDir) ? distDir : null;

const rooms = new RoomManager();
rooms.start();

// 첫 마이크 시작이 바로 되도록 모델을 미리 올려 둔다 (없으면 송출 화면에 안내)
if (!loadSttEngine()) console.warn(`[stt] ${sttStatus().message}`);

const server = createServer(createHttpHandler(rooms, staticDir));
const wss = createRoomWebSocketServer(rooms);
const sttWss = createSttWebSocketServer();

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const target = path === WS_PATH ? wss : path === STT_PATH ? sttWss : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && desktopMode && (await isAlreadyRunning(PORT))) {
    console.log('이미 실시간 자막이 켜져 있습니다. 송출 화면을 다시 엽니다.');
    openBrowser(`http://localhost:${PORT}/host`);
    setTimeout(() => process.exit(0), 3000);
    return;
  }
  console.error(e.code === 'EADDRINUSE' ? `[server] 포트 ${PORT}을(를) 이미 다른 프로그램이 쓰고 있습니다.` : e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}  (ws: ${WS_PATH})`);
  console.log(`[stt] ${sttStatus().available ? '로컬 음성인식 준비됨' : '로컬 음성인식 사용 불가'}`);
  console.log(staticDir ? `[server] serving client from ${staticDir}` : '[server] API only (client는 Vite dev 서버 사용)');
  if (desktopMode) {
    printGuide(PORT);
    openBrowser(`http://localhost:${PORT}/host`);
  }
});

function shutdown(): void {
  rooms.stop();
  wss.close();
  sttWss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
