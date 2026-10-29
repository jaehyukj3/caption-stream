import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import {
  isValidRoomCode,
  type CreateRoomResponse,
  type NetInfoResponse,
  type RoomStatusResponse,
  type SttStatusResponse,
} from '@caption/shared';
import { config } from './config.js';
import type { RoomManager } from './RoomManager.js';
import { sttStatus } from './stt/SttEngine.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** 같은 와이파이 접속(외부 포트) 제어. index.ts가 만든다. */
export interface LanControl {
  readonly port: number | null;
  readonly enabled: boolean;
  enable(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = (req: IncomingMessage) => LOOPBACK.has(req.socket.remoteAddress ?? '');

export function createHttpHandler(rooms: RoomManager, staticDir: string | null, lan: LanControl) {
  const netInfo = (): NetInfoResponse => ({
    publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') || null,
    lanAddresses: lanAddresses(),
    lanPort: lan.port,
    lanEnabled: lan.enabled,
  });

  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/rooms' && req.method === 'POST') {
      // 방 만들기는 강사 노트북에서만 (같은 와이파이 참석자가 방을 만들 수 없게)
      if (lan.port !== null && !isLoopback(req)) return json(res, 403, { error: 'LOCAL_ONLY' });
      const room = rooms.create();
      if (!room) return json(res, 503, { error: 'TOO_MANY_ROOMS' });
      return json(res, 201, { code: room.code, hostToken: room.hostToken } satisfies CreateRoomResponse);
    }

    const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(path);
    if (roomMatch && req.method === 'GET') {
      const code = roomMatch[1]!;
      const room = isValidRoomCode(code) ? rooms.get(code) : undefined;
      if (!room) return json(res, 404, { error: 'ROOM_NOT_FOUND' });
      return json(res, 200, {
        code: room.code,
        ended: room.ended,
        lineCount: room.lines.length,
      } satisfies RoomStatusResponse);
    }

    if (path === '/api/net-info' && req.method === 'GET') return json(res, 200, netInfo());

    if (path === '/api/lan' && req.method === 'POST') {
      if (!isLoopback(req)) return json(res, 403, { error: 'LOCAL_ONLY' });
      lan.enable().then(
        () => json(res, 200, netInfo()),
        (e: Error) => json(res, 500, { error: 'LAN_FAILED', message: e.message }),
      );
      return;
    }

    if (path === '/api/stt-status' && req.method === 'GET') {
      return json(res, 200, sttStatus() satisfies SttStatusResponse);
    }

    if (path === '/api/health') return json(res, 200, { ok: true });

    // 노트북 프로그램 새 버전 확인: 웹 송출 사이트에 올라간 최신 빌드 번호와 받기 주소
    if (path === '/api/latest' && req.method === 'GET') {
      if (!config.relayUrl) return json(res, 404, { error: 'NO_RELAY' });
      fetch(`${config.relayUrl}/version.json`, { signal: AbortSignal.timeout(5000), headers: { 'cache-control': 'no-cache' } })
        .then((r) => (r.ok ? (r.json() as Promise<{ build?: string }>) : Promise.reject(new Error(String(r.status)))))
        .then(
          (v) => json(res, 200, { build: v.build ?? null, download: `${config.relayUrl}/download` }),
          () => json(res, 502, { error: 'UNREACHABLE' }),
        );
      return;
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });

    if (staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveStatic(staticDir, path, res);
    }
    res.writeHead(404).end('Not Found');
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 빌드된 클라이언트 정적 파일 서빙. 없는 경로는 SPA 라우팅을 위해 index.html로 보낸다. */
function serveStatic(root: string, urlPath: string, res: ServerResponse): void {
  const rootAbs = resolve(root);
  let file = resolve(join(rootAbs, normalize(decodeURIComponent(urlPath))));
  if (!file.startsWith(rootAbs)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) file = join(rootAbs, 'index.html');

  const isAsset = file.includes(`${join(rootAbs, 'assets')}`);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    // 해시가 붙은 assets는 오래 캐시, index.html은 항상 새로
    'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) result.push(addr.address);
    }
  }
  // Windows 모바일 핫스팟(192.168.137.x)을 맨 앞으로, 그다음 사설망 대역 (192.168 > 10 > 172.16-31)
  const rank = (ip: string) =>
    ip.startsWith('192.168.137.')
      ? 0
      : ip.startsWith('192.168.')
        ? 1
        : ip.startsWith('10.')
          ? 2
          : /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
            ? 3
            : 4;
  return result.sort((a, b) => rank(a) - rank(b));
}
