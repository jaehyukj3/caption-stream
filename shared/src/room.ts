import {
  INTERIM_MIN_INTERVAL_MS,
  MAX_HISTORY_LINES,
  ROOM_TTL_MS,
  type CaptionLine,
  type RelayState,
  type Role,
  type RoomStats,
  type ServerMessage,
  type ShareMessage,
} from './protocol.js';
import { MAX_SURVEY_RESPONSES, type SurveyResponse } from './survey.js';

/** 방에 붙는 연결. ws.WebSocket을 그대로 넘겨도 되고 테스트에서는 가짜 객체를 쓴다. */
export interface Peer {
  send(data: string): void;
}

export class Room {
  readonly lines: CaptionLine[] = [];
  ended = false;

  private readonly hosts = new Set<Peer>();
  /** 중계 서버 상태와 참석자용 주소(복호화 키 포함). 송출자에게만 보낸다. */
  private share: ShareMessage = { type: 'share', relay: 'off', relayViewerUrl: null };
  private readonly viewers = new Set<Peer>();
  private nextSeq = 1;
  /** 설문 응답 (참석자 기기별 익명 ID → 마지막 응답). 송출자에게만 보낸다. */
  private readonly surveys = new Map<string, SurveyResponse>();
  /** 송출자가 설문을 요청했는지 (이후 들어오는 참석자에게도 알린다) */
  surveyRequested = false;

  // 이용 통계 (테스트 기록용): 접속 중인 수신자 → 익명 ID와 접속 시각, 익명 ID → 누적 기록
  readonly createdAt = Date.now();
  private readonly viewerSessions = new Map<Peer, { id: string; since: number }>();
  private readonly viewerStats = new Map<string, { firstJoinAt: number; lastSeenAt: number; totalMs: number; sessions: number }>();
  private readonly timeline: [number, number][] = [];
  private anonCount = 0;

  /** 송출자가 마지막으로 접속해 있었던 시각 (만료 계산 기준) */
  private lastHostSeenAt = Date.now();
  private endedAt: number | null = null;

  // interim 쓰로틀 상태
  private lastInterimSentAt = 0;
  private pendingInterim: string | null = null;
  /** 마지막으로 내보낸 중간 결과. 늦게 들어온 수신자에게 바로 보여준다. */
  private currentInterim = '';
  private interimTimer: ReturnType<typeof setTimeout> | null = null;

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

  addPeer(peer: Peer, role: Role, sinceSeq = 0, clientId?: string): void {
    (role === 'host' ? this.hosts : this.viewers).add(peer);
    if (role === 'host') this.lastHostSeenAt = Date.now();
    else this.trackJoin(peer, clientId);

    send(peer, { type: 'joined', role, code: this.code, ended: this.ended });
    if (role === 'host') {
      send(peer, this.share);
      send(peer, { type: 'surveyResponses', responses: [...this.surveys.values()] });
    }
    send(peer, { type: 'history', lines: sinceSeq > 0 ? this.lines.filter((l) => l.seq > sinceSeq) : this.lines });
    if (this.ended) {
      send(peer, { type: 'sessionEnd' });
    } else if (role === 'viewer' && this.currentInterim) {
      send(peer, { type: 'interim', text: this.currentInterim });
    }
    if (role === 'viewer' && this.surveyRequested) send(peer, { type: 'surveyPrompt' });
    this.broadcastViewerCount();
  }

  removePeer(peer: Peer): void {
    if (this.hosts.delete(peer)) this.lastHostSeenAt = Date.now();
    if (this.viewers.delete(peer)) {
      this.trackLeave(peer);
      this.broadcastViewerCount();
    }
  }

  /** 이용 통계. 수신자는 기기별 익명 ID로만 구분된다. */
  getStats(now = Date.now()): RoomStats {
    const open = new Map<string, number>();
    for (const { id, since } of this.viewerSessions.values()) open.set(id, (open.get(id) ?? 0) + now - since);
    return {
      createdAt: this.createdAt,
      now,
      viewers: [...this.viewerStats].map(([id, v]) => ({
        id,
        firstJoinAt: v.firstJoinAt,
        lastSeenAt: open.has(id) ? now : v.lastSeenAt,
        totalMs: v.totalMs + (open.get(id) ?? 0),
        sessions: v.sessions,
        connected: open.has(id),
      })),
      timeline: [...this.timeline],
    };
  }

  private trackJoin(peer: Peer, clientId: string | undefined): void {
    const now = Date.now();
    const id = clientId ?? `anon-${++this.anonCount}`;
    this.viewerSessions.set(peer, { id, since: now });
    const v = this.viewerStats.get(id);
    if (v) v.sessions++;
    else if (this.viewerStats.size < MAX_TRACKED_VIEWERS) this.viewerStats.set(id, { firstJoinAt: now, lastSeenAt: now, totalMs: 0, sessions: 1 });
  }

  private trackLeave(peer: Peer): void {
    const s = this.viewerSessions.get(peer);
    if (!s) return;
    this.viewerSessions.delete(peer);
    const v = this.viewerStats.get(s.id);
    if (!v) return;
    const now = Date.now();
    v.totalMs += now - s.since;
    v.lastSeenAt = now;
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

  /** 설문 응답 저장 후 송출자에게 전달. 같은 참석자가 다시 내면 덮어쓴다. */
  addSurvey(from: Peer, respondentId: string, answers: SurveyResponse['answers']): void {
    if (!this.surveys.has(respondentId) && this.surveys.size >= MAX_SURVEY_RESPONSES) return;
    const response: SurveyResponse = { respondentId, answers, submittedAt: Date.now() };
    this.surveys.set(respondentId, response);
    send(from, { type: 'surveyAck', respondentId });
    const data = JSON.stringify({ type: 'surveyResponses', responses: [response] } satisfies ServerMessage);
    for (const h of this.hosts) h.send(data);
  }

  /** 접속해 있는 참석자 모두에게 설문 참여를 요청 */
  requestSurvey(): void {
    this.surveyRequested = true;
    this.broadcast({ type: 'surveyPrompt' }, false);
  }

  setShare(relay: RelayState, relayViewerUrl: string | null): void {
    this.share = { type: 'share', relay, relayViewerUrl };
    const data = JSON.stringify(this.share);
    for (const h of this.hosts) h.send(data);
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
    const last = this.timeline.at(-1);
    if (last?.[1] !== this.viewers.size && this.timeline.length < MAX_TIMELINE) this.timeline.push([Date.now(), this.viewers.size]);
    this.broadcast({ type: 'viewerCount', count: this.viewers.size }, true);
  }

  private broadcast(msg: ServerMessage, includeHosts: boolean): void {
    const data = JSON.stringify(msg);
    for (const v of this.viewers) v.send(data);
    if (includeHosts) for (const h of this.hosts) h.send(data);
  }
}

const MAX_TRACKED_VIEWERS = 2000;
const MAX_TIMELINE = 50_000;

function send(peer: Peer, msg: ServerMessage): void {
  peer.send(JSON.stringify(msg));
}
