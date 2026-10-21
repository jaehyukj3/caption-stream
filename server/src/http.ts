import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import {
  isValidRoomCode,
  type CreateRoomResponse,
  type NetInfoResponse,
  type RoomStatusResponse,
} from '@caption/shared';
import type { RoomManager } from './RoomManager.js';

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

export function createHttpHandler(rooms: RoomManager, staticDir: string | null) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/rooms' && req.method === 'POST') {
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

    if (path === '/api/net-info' && req.method === 'GET') {
      return json(res, 200, {
        // Render 등 호스팅이 알려주는 외부 주소를 PUBLIC_URL 대신 써도 된다
        publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.replace(/\/$/, '') || null,
        lanAddresses: lanAddresses(),
      } satisfies NetInfoResponse);
    }

    if (path === '/api/health') return json(res, 200, { ok: true });

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
  // 사설망 대역을 앞으로 (192.168 > 10 > 172.16-31)
  const rank = (ip: string) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return result.sort((a, b) => rank(a) - rank(b));
}
