import { onBeforeUnmount, ref, shallowRef } from 'vue';
import {
  e2eDecrypt,
  e2eEncrypt,
  importE2eKey,
  RELAY_WS_PATH,
  WS_PATH,
  type ClientMessage,
  type ErrorCode,
  type Role,
  type ServerMessage,
} from '@caption/shared';

export type SocketStatus = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'closed';

export interface RoomSocketOptions {
  code: string;
  role: Role;
  hostToken?: string;
  /** 재연결 시 이미 받은 마지막 seq (그 이후 문장만 다시 받음) */
  getSinceSeq: () => number;
  onMessage: (msg: ServerMessage) => void;
  /**
   * 중계 서버를 거쳐 접속 (와이파이 없이 LTE). 모든 메시지를 이 키로 암호화·복호화한다.
   * 키는 주소의 # 뒤에서 오며 서버로 전송되지 않는다.
   */
  relay?: { rid: string; key: string };
}

const RELAY_PING_MS = 30_000;

/** 재시도해도 소용없는 오류: 재연결을 멈춘다 */
const FATAL: ErrorCode[] = ['ROOM_NOT_FOUND', 'NOT_HOST'];
const MAX_BACKOFF_MS = 10_000;

/**
 * 방 WebSocket 연결. 끊기면 지수 백오프(1s→2s→4s…최대 10s)로 자동 재연결한다.
 * 연결이 없는 동안 보낸 final/end는 큐에 모았다가 재입장 후 보낸다. interim은 버린다.
 */
export function useRoomSocket(opts: RoomSocketOptions) {
  const status = ref<SocketStatus>('connecting');
  const error = ref<{ code: ErrorCode; message: string } | null>(null);
  /** 아직 서버로 못 보낸 확정 문장 (송출자 화면에 흐리게 표시) */
  const pendingFinals = shallowRef<string[]>([]);

  let ws: WebSocket | null = null;
  let joined = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let queue: ClientMessage[] = [];

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = () =>
    opts.relay
      ? `${wsProto}://${location.host}${RELAY_WS_PATH}/${opts.relay.rid}?role=sub`
      : `${wsProto}://${location.host}${WS_PATH}`;

  // 중계 모드: 암호화·복호화는 비동기라 순서가 섞이지 않도록 한 줄로 처리한다
  const keyPromise = opts.relay ? importE2eKey(opts.relay.key) : null;
  let outChain: Promise<void> = Promise.resolve();
  let inChain: Promise<void> = Promise.resolve();
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function rawSend(sock: WebSocket, msg: ClientMessage) {
    const text = JSON.stringify(msg);
    if (!keyPromise) return sock.send(text);
    outChain = outChain.then(async () => {
      const sealed = await e2eEncrypt(await keyPromise, text);
      if (sock.readyState === WebSocket.OPEN) sock.send(sealed);
    });
  }

  function receive(data: string, handle: (msg: ServerMessage) => void) {
    if (!keyPromise) {
      try {
        handle(JSON.parse(data));
      } catch {
        /* 잘못된 메시지 무시 */
      }
      return;
    }
    if (data === 'pong') return;
    inChain = inChain.then(async () => {
      try {
        handle(JSON.parse(await e2eDecrypt(await keyPromise, data)));
      } catch {
        /* 키가 맞지 않거나 손상된 메시지 무시 */
      }
    });
  }

  function connect() {
    if (disposed) return;
    status.value = attempt === 0 ? 'connecting' : 'reconnecting';
    const sock = new WebSocket(url());
    ws = sock;
    joined = false;

    sock.onopen = () => {
      rawSend(sock, {
        type: 'join',
        code: opts.code,
        role: opts.role,
        hostToken: opts.hostToken,
        sinceSeq: opts.getSinceSeq(),
      });
      if (keyPromise) {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('ping'), RELAY_PING_MS);
      }
    };

    sock.onmessage = (ev) => receive(ev.data as string, (msg) => onServerMessage(sock, msg));

    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      joined = false;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      if (disposed) {
        if (status.value !== 'failed') status.value = 'closed';
        return;
      }
      scheduleReconnect();
    };
    // onerror 뒤에는 항상 onclose가 오므로 따로 처리하지 않는다
  }

  function onServerMessage(sock: WebSocket, msg: ServerMessage) {
    if (msg.type === 'joined') {
      joined = true;
      attempt = 0;
      status.value = 'live';
      error.value = null;
      flushQueue();
    } else if (msg.type === 'error') {
      error.value = { code: msg.code, message: msg.message };
      if (FATAL.includes(msg.code)) {
        status.value = 'failed';
        disposed = true;
        sock.close();
      }
    }
    opts.onMessage(msg);
  }

  function scheduleReconnect() {
    if (retryTimer || disposed) return;
    status.value = 'reconnecting';
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS) * (0.8 + Math.random() * 0.4);
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  /** 화면 복귀·네트워크 복구 시 백오프를 기다리지 않고 바로 재연결 */
  function reconnectNow() {
    if (disposed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    connect();
  }

  function send(msg: ClientMessage) {
    if (ws && joined && ws.readyState === WebSocket.OPEN) {
      rawSend(ws, msg);
      return;
    }
    if (msg.type === 'final' || msg.type === 'end') {
      queue.push(msg);
      syncPending();
    }
  }

  function flushQueue() {
    const items = queue;
    queue = [];
    for (const m of items) rawSend(ws!, m);
    syncPending();
  }

  function syncPending() {
    pendingFinals.value = queue.flatMap((m) => (m.type === 'final' ? [m.text] : []));
  }

  function close() {
    disposed = true;
    if (pingTimer) clearInterval(pingTimer);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    ws?.close();
    window.removeEventListener('online', reconnectNow);
    document.removeEventListener('visibilitychange', onVisible);
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnectNow();
  };
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', onVisible);

  connect();
  onBeforeUnmount(close);

  return { status, error, pendingFinals, send, close };
}
