import { onBeforeUnmount, ref } from 'vue';
import { openConnection, type Connection, type Room, type RoomDirectory } from '@caption/shared';
import { nativeApp, onNativeEvent } from '../stt/NativeSttProvider';
import { dlog } from '../utils/debugLog';

/** 틀린 방 코드로 이만큼 들어오려 하면 같은 와이파이 접속을 닫는다 (방 코드 맞히기 막기) */
const MAX_BAD_JOINS = 20;
const REFRESH_MS = 5_000;

/**
 * 안드로이드 앱: 인터넷 없이 같은 와이파이(이 폰의 핫스팟 등)로 참석자를 받는다.
 * 앱의 작은 서버(LocalServer)가 참석자 화면을 주고, 들어온 연결을 이 방의 일반 참석자로 붙인다
 * (노트북 프로그램의 '같은 와이파이' 접속, 중계 서버의 RelayBridge와 같은 방식).
 * 글은 이 와이파이 안에서만 오간다. 참석자는 볼 수만 있다(송출 권한 없음).
 */
export function useNativeLan(room: Room) {
  /** 참석자가 열 주소들 (http://폰주소:포트). 핫스팟을 켜면 몇 초 안에 생긴다 */
  const origins = ref<string[]>([]);
  const available = !!nativeApp?.lanStart;
  if (!available) return { available, origins, closed: ref(false) };
  const api = nativeApp!;
  const closed = ref(false);
  let bad = 0;
  const directory: RoomDirectory = {
    get: (c) => {
      if (c === room.code) return room;
      if (++bad >= MAX_BAD_JOINS && !closed.value) {
        closed.value = true;
        dlog('같은 와이파이: 틀린 방 코드 접속이 많아 닫음');
        queueMicrotask(stop);
      }
      return undefined;
    },
    verifyHost: () => false,
  };
  const conns = new Map<number, Connection>();
  const off = onNativeEvent((m) => {
    if (m.op === 'lanOpen') conns.set(m.id, openConnection({ send: (data) => api.lanSend?.(m.id, data) }, directory, { allowHost: false }));
    else if (m.op === 'lanMsg') conns.get(m.id)?.handleRaw(m.data);
    else if (m.op === 'lanClose') {
      conns.get(m.id)?.close();
      conns.delete(m.id);
    }
  });

  const read = (json: string | undefined) => {
    try {
      const info = JSON.parse(json ?? '{}') as { port?: number; addresses?: string[] };
      const next = info.port ? (info.addresses ?? []).map((a) => `http://${a}:${info.port}`) : [];
      if (next.join() !== origins.value.join()) {
        origins.value = next;
        dlog(`같은 와이파이 주소: ${next.join(', ') || '(없음 — 핫스팟·와이파이 꺼짐)'}`);
      }
    } catch {
      /* 앱이 답하지 않으면 그대로 */
    }
  };
  read(api.lanStart!());
  const timer = setInterval(() => !closed.value && read(api.lanInfo?.()), REFRESH_MS);

  function stop() {
    clearInterval(timer);
    off();
    for (const c of conns.values()) c.close();
    conns.clear();
    origins.value = [];
    api.lanStop?.();
  }
  onBeforeUnmount(stop);
  return { available, origins, closed };
}
