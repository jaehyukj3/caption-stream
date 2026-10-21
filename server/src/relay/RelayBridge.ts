import WebSocket from 'ws';
import {
  e2eDecrypt,
  e2eEncrypt,
  generateE2eKey,
  importE2eKey,
  randomId,
  RELAY_WS_PATH,
  type E2eKey,
  type RelayDownMessage,
  type RelayUpMessage,
} from '@caption/shared';
import type { Room } from '../Room.js';
import type { RoomManager } from '../RoomManager.js';
import { openConnection, type Connection } from '../socket.js';

const PING_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

interface RemoteViewer {
  conn: Connection;
  /** 복호화가 비동기라 도착 순서대로 처리하기 위한 줄 */
  inbox: Promise<void>;
}

/**
 * 방 하나를 중계 서버에 연결한다 (와이파이 없이 LTE로 접속하는 참석자용).
 * 중계 서버를 거쳐 온 참석자 한 명 한 명을 방의 일반 수신자처럼 취급하므로
 * 이력·재접속·접속자 수 등 기존 동작이 그대로 적용된다. 송출 권한은 주지 않는다.
 * 오가는 내용은 모두 이 노트북에서 암호화되며, 키는 참석자 QR 주소의 # 뒤에만 있다.
 */
export class RelayBridge {
  private readonly rid = randomId(18);
  private readonly token = randomId(24);
  private readonly keyB64 = generateE2eKey();
  private key: E2eKey | null = null;

  private ws: WebSocket | null = null;
  private readonly viewers = new Map<string, RemoteViewer>();
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  /** 같은 순간에 나간 메시지를 모아 같은 내용은 한 번만 암호화·전송 (broadcast) */
  private pending = new Map<string, string[]>();
  private flushScheduled = false;
  private outbox: Promise<void> = Promise.resolve();

  constructor(
    private readonly relayUrl: string,
    private readonly room: Room,
    private readonly rooms: RoomManager,
  ) {
    void importE2eKey(this.keyB64).then((k) => {
      this.key = k;
      this.connect();
    });
  }

  /** 참석자에게 보여줄 주소. 키는 # 뒤에 있어 중계 서버로 전송되지 않는다. */
  get viewerUrl(): string {
    return `${this.relayUrl}/view/${this.room.code}?r=${this.rid}#k=${this.keyB64}`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.dropAllViewers();
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.disposed) return;
    this.room.setShare('connecting', null);
    const url = `${this.relayUrl.replace(/^http/, 'ws')}${RELAY_WS_PATH}/${this.rid}?role=pub`;
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => this.up({ t: 'hello', token: this.token }));
    ws.on('message', (raw) => {
      if (String(raw) === 'pong') return;
      let msg: RelayDownMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.onRelayMessage(msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.dropAllViewers();
      if (this.disposed) return;
      this.room.setShare('offline', null);
      const delay = Math.min(1000 * 2 ** this.attempt++, MAX_BACKOFF_MS);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
    ws.on('error', (e) => {
      if (this.attempt === 0) console.warn(`[relay] 중계 서버 연결 실패: ${e.message} (인터넷 연결 확인)`);
    });
  }

  private onRelayMessage(msg: RelayDownMessage) {
    switch (msg.t) {
      case 'welcome':
        this.attempt = 0;
        this.room.setShare('online', this.viewerUrl);
        this.pingTimer = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send('ping'), PING_INTERVAL_MS);
        console.log(`[relay] 방 ${this.room.code} 중계 연결됨`);
        break;
      case 'denied':
        console.warn(`[relay] 중계 서버가 연결을 거부했습니다: ${msg.reason}`);
        this.disposed = true;
        this.room.setShare('offline', null);
        break;
      case 'sub-join': {
        const id = msg.id;
        const conn = openConnection({ send: (data) => this.queue(id, data) }, this.rooms, { allowHost: false });
        this.viewers.set(id, { conn, inbox: Promise.resolve() });
        break;
      }
      case 'sub-msg': {
        const v = this.viewers.get(msg.id);
        if (!v || !this.key) return;
        const key = this.key;
        v.inbox = v.inbox.then(async () => {
          try {
            v.conn.handleRaw(await e2eDecrypt(key, msg.data));
          } catch {
            /* 키가 다른(위조된) 메시지는 버린다 */
          }
        });
        break;
      }
      case 'sub-leave':
        this.viewers.get(msg.id)?.conn.close();
        this.viewers.delete(msg.id);
        break;
    }
  }

  private queue(id: string, data: string) {
    const ids = this.pending.get(data);
    if (ids) ids.push(id);
    else this.pending.set(data, [id]);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush() {
    this.flushScheduled = false;
    const batch = this.pending;
    this.pending = new Map();
    const key = this.key;
    if (!key) return;
    const total = this.viewers.size;
    // 순서 보장: 이전 묶음이 다 나간 뒤에 다음 묶음을 보낸다
    this.outbox = this.outbox.then(async () => {
      for (const [data, ids] of batch) {
        const sealed = await e2eEncrypt(key, data);
        const live = ids.filter((id) => this.viewers.has(id));
        if (live.length > 1 && live.length === total) this.up({ t: 'broadcast', data: sealed });
        else for (const id of live) this.up({ t: 'to', id, data: sealed });
      }
    });
  }

  private dropAllViewers() {
    for (const v of this.viewers.values()) v.conn.close();
    this.viewers.clear();
  }

  private up(msg: RelayUpMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
