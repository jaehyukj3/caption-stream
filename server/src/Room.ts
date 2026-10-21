import {
  INTERIM_MIN_INTERVAL_MS,
  MAX_HISTORY_LINES,
  ROOM_TTL_MS,
  type CaptionLine,
  type Role,
  type ServerMessage,
} from '@caption/shared';

/** 방에 붙는 연결. ws.WebSocket을 그대로 넘겨도 되고 테스트에서는 가짜 객체를 쓴다. */
export interface Peer {
  send(data: string): void;
}

export class Room {
  readonly lines: CaptionLine[] = [];
  ended = false;

  private readonly hosts = new Set<Peer>();
  private readonly viewers = new Set<Peer>();
  private nextSeq = 1;

  /** 송출자가 마지막으로 접속해 있었던 시각 (만료 계산 기준) */
  private lastHostSeenAt = Date.now();
  private endedAt: number | null = null;

  // interim 쓰로틀 상태
  private lastInterimSentAt = 0;
  private pendingInterim: string | null = null;
  /** 마지막으로 내보낸 중간 결과. 늦게 들어온 수신자에게 바로 보여준다. */
  private currentInterim = '';
  private interimTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly code: string,
    readonly hostToken: string,
  ) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  addPeer(peer: Peer, role: Role, sinceSeq = 0): void {
    (role === 'host' ? this.hosts : this.viewers).add(peer);
    if (role === 'host') this.lastHostSeenAt = Date.now();

    send(peer, { type: 'joined', role, code: this.code, ended: this.ended });
    send(peer, { type: 'history', lines: sinceSeq > 0 ? this.lines.filter((l) => l.seq > sinceSeq) : this.lines });
    if (this.ended) {
      send(peer, { type: 'sessionEnd' });
    } else if (role === 'viewer' && this.currentInterim) {
      send(peer, { type: 'interim', text: this.currentInterim });
    }
    this.broadcastViewerCount();
  }

  removePeer(peer: Peer): void {
    if (this.hosts.delete(peer)) this.lastHostSeenAt = Date.now();
    if (this.viewers.delete(peer)) this.broadcastViewerCount();
  }

  /**
   * 중간 결과는 수신자에게만, 최대 INTERIM_MIN_INTERVAL_MS 간격으로 보낸다.
   * 간격 안에 들어온 값은 마지막 것만 남겨 두었다가 간격이 지나면 보낸다(trailing).
   */
  pushInterim(text: string): void {
    if (this.ended) return;
    this.pendingInterim = text;
    if (this.interimTimer) return;

    const wait = this.lastInterimSentAt + INTERIM_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.flushInterim();
    } else {
      this.interimTimer = setTimeout(() => this.flushInterim(), wait);
    }
  }

  pushFinal(text: string): CaptionLine | null {
    if (this.ended) return null;
    this.cancelInterim();

    const line: CaptionLine = { seq: this.nextSeq++, text, ts: Date.now() };
    this.lines.push(line);
    if (this.lines.length > MAX_HISTORY_LINES) this.lines.shift();

    // 송출자도 받는다: 서버가 매긴 seq가 붙은 확정본을 화면에 반영하기 위해
    this.broadcast({ type: 'final', line }, true);
    return line;
  }

  end(): void {
    if (this.ended) return;
    this.cancelInterim();
    this.ended = true;
    this.endedAt = Date.now();
    this.broadcast({ type: 'sessionEnd' }, true);
  }

  /** 송출자가 없거나 종료된 지 ROOM_TTL_MS가 지나면 만료 */
  isExpired(now = Date.now()): boolean {
    if (this.endedAt !== null) return now - this.endedAt > ROOM_TTL_MS;
    if (this.hosts.size > 0) return false;
    return now - this.lastHostSeenAt > ROOM_TTL_MS;
  }

  /** 만료 시 남은 수신자에게 종료를 알리고 정리 */
  dispose(): void {
    this.cancelInterim();
    if (!this.ended) this.broadcast({ type: 'sessionEnd' }, true);
    this.hosts.clear();
    this.viewers.clear();
  }

  private flushInterim(): void {
    this.interimTimer = null;
    if (this.pendingInterim === null) return;
    this.lastInterimSentAt = Date.now();
    this.currentInterim = this.pendingInterim;
    this.pendingInterim = null;
    this.broadcast({ type: 'interim', text: this.currentInterim }, false);
  }

  private cancelInterim(): void {
    if (this.interimTimer) clearTimeout(this.interimTimer);
    this.interimTimer = null;
    this.pendingInterim = null;
    this.currentInterim = '';
  }

  private broadcastViewerCount(): void {
    this.broadcast({ type: 'viewerCount', count: this.viewers.size }, true);
  }

  private broadcast(msg: ServerMessage, includeHosts: boolean): void {
    const data = JSON.stringify(msg);
    for (const v of this.viewers) v.send(data);
    if (includeHosts) for (const h of this.hosts) h.send(data);
  }
}

function send(peer: Peer, msg: ServerMessage): void {
  peer.send(JSON.stringify(msg));
}
