/**
 * 자막 중계 서버. 노트북과 참석자 사이에서 "암호문"만 전달한다.
 * 복호화 키는 참석자 QR 주소의 # 뒤에만 있어 이 서버로는 전송되지 않으므로, 자막 내용을 볼 수 없다.
 *
 * 방 하나 = Durable Object 하나.
 *  - pub(노트북) 1개: hello로 토큰 인증(처음 온 토큰을 방 주인으로 기억)
 *  - sub(참석자) 여러 개: 보낸 것은 pub에게 sub-msg로, pub이 보낸 것은 해당 sub(들)에게 그대로
 */
import { DurableObject } from 'cloudflare:workers';

interface Env {
  RELAY: DurableObjectNamespace<RelayRoom>;
  ASSETS: Fetcher;
}

const RID = /^\/relay\/([A-Za-z0-9_-]{16,64})$/;
const MAX_SUBS = 500;
const MAX_MESSAGE = 512 * 1024;
/** 마지막 송출 접속 후 이 시간이 지나면 방 정보(토큰) 삭제 */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

type Attachment = { role: 'pub'; authed: boolean } | { role: 'sub'; id: string };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const m = RID.exec(new URL(req.url).pathname);
    if (!m) return env.ASSETS.fetch(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    return env.RELAY.get(env.RELAY.idFromName(m[1]!)).fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 연결 유지용 ping은 깨우지 않고 바로 응답 (비용·지연 절감)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get('role');
    const { 0: client, 1: server } = new WebSocketPair();

    if (role === 'pub') {
      this.ctx.acceptWebSocket(server, ['pub']);
      server.serializeAttachment({ role: 'pub', authed: false } satisfies Attachment);
    } else {
      if (this.ctx.getWebSockets('sub').length >= MAX_SUBS) return new Response('room full', { status: 503 });
      const id = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, ['sub', id]);
      server.serializeAttachment({ role: 'sub', id } satisfies Attachment);
      this.toPub({ t: 'sub-join', id });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) return;
    const a = ws.deserializeAttachment() as Attachment;

    if (a.role === 'sub') {
      this.toPub({ t: 'sub-msg', id: a.id, data: message });
      return;
    }

    let m: { t?: string; token?: string; id?: string; data?: string };
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }

    if (!a.authed) {
      if (m.t !== 'hello' || typeof m.token !== 'string') return ws.close(4001, 'hello first');
      const hash = await sha256(m.token);
      const owner = await this.ctx.storage.get<string>('tokenHash');
      if (owner && owner !== hash) {
        ws.send(JSON.stringify({ t: 'denied', reason: 'token' }));
        return ws.close(4003, 'denied');
      }
      if (!owner) await this.ctx.storage.put('tokenHash', hash);
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);

      // 노트북이 다시 붙으면: 이전 연결은 끊고, 참석자들은 재접속시켜 놓친 자막을 받게 한다
      for (const other of this.ctx.getWebSockets('pub')) if (other !== ws) other.close(4000, 'replaced');
      ws.serializeAttachment({ role: 'pub', authed: true } satisfies Attachment);
      ws.send(JSON.stringify({ t: 'welcome' }));
      for (const s of this.ctx.getWebSockets('sub')) s.close(4010, 'publisher reconnected');
      return;
    }

    if (m.t === 'broadcast' && typeof m.data === 'string') {
      for (const s of this.ctx.getWebSockets('sub')) safeSend(s, m.data);
    } else if (m.t === 'to' && typeof m.id === 'string' && typeof m.data === 'string') {
      for (const s of this.ctx.getWebSockets(m.id)) safeSend(s, m.data);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.role === 'sub') this.toPub({ t: 'sub-leave', id: a.id });
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      /* 이미 닫힘 */
    }
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets('pub').length) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
  }

  private toPub(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const p of this.ctx.getWebSockets('pub')) {
      if ((p.deserializeAttachment() as Attachment & { authed?: boolean }).authed) safeSend(p, data);
    }
  }
}

function safeSend(ws: WebSocket, data: string) {
  try {
    ws.send(data);
  } catch {
    /* 끊기는 중인 연결 */
  }
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
