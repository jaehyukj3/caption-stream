import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Room, ROOM_TTL_MS, type ServerMessage } from '@caption/shared';

class FakePeer {
  received: ServerMessage[] = [];
  send(data: string) {
    this.received.push(JSON.parse(data));
  }
  of<T extends ServerMessage['type']>(type: T) {
    return this.received.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
}

test('늦게 들어온 수신자는 이력을, 재연결 수신자는 sinceSeq부터 받는다', () => {
  const room = new Room('123456', 'tok');
  const host = new FakePeer();
  room.addPeer(host, 'host');
  room.pushFinal('하나');
  room.pushFinal('둘');
  room.pushFinal('셋');

  const late = new FakePeer();
  room.addPeer(late, 'viewer');
  assert.deepEqual(late.of('history')[0]!.lines.map((l) => l.text), ['하나', '둘', '셋']);

  const rejoin = new FakePeer();
  room.addPeer(rejoin, 'viewer', 2);
  assert.deepEqual(rejoin.of('history')[0]!.lines.map((l) => l.seq), [2, 3]);
});

test('final은 송출자에게도 seq와 함께 전달되고 viewerCount가 갱신된다', () => {
  const room = new Room('123456', 'tok');
  const host = new FakePeer();
  const viewer = new FakePeer();
  room.addPeer(host, 'host');
  room.addPeer(viewer, 'viewer');
  room.pushFinal('안녕하세요');
  assert.equal(host.of('final')[0]!.line.seq, 1);
  assert.equal(viewer.of('final')[0]!.line.text, '안녕하세요');
  assert.equal(host.of('viewerCount').at(-1)!.count, 1);
  room.removePeer(viewer);
  assert.equal(host.of('viewerCount').at(-1)!.count, 0);
});

test('interim은 초당 4회로 쓰로틀되고 마지막 값은 반드시 전달된다', async () => {
  const room = new Room('123456', 'tok');
  const viewer = new FakePeer();
  room.addPeer(viewer, 'viewer');
  for (let i = 0; i < 20; i++) room.pushInterim(`t${i}`);
  assert.deepEqual(viewer.of('interim').map((m) => m.text), ['t0']);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(viewer.of('interim').map((m) => m.text), ['t0', 't19']);
});

test('final이 오면 대기 중인 interim은 버린다', async () => {
  const room = new Room('123456', 'tok');
  const viewer = new FakePeer();
  room.addPeer(viewer, 'viewer');
  room.pushInterim('a');
  room.pushInterim('ab');
  room.pushFinal('abc');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(viewer.of('interim').map((m) => m.text), ['a']);
});

test('송출자가 없거나 종료 후 2시간이 지나면 만료', () => {
  const room = new Room('123456', 'tok');
  const host = new FakePeer();
  room.addPeer(host, 'host');
  const now = Date.now();
  assert.equal(room.isExpired(now + ROOM_TTL_MS + 1), false); // 송출자 접속 중
  room.removePeer(host);
  assert.equal(room.isExpired(now + ROOM_TTL_MS - 1000), false);
  assert.equal(room.isExpired(now + ROOM_TTL_MS + 1000), true);

  const ended = new Room('654321', 'tok');
  ended.addPeer(new FakePeer(), 'host');
  ended.end();
  assert.equal(ended.isExpired(Date.now() + ROOM_TTL_MS + 1000), true);
  assert.equal(ended.pushFinal('무시'), null);
});

test('revise: 송출자가 마지막 문장을 고치면 같은 번호로 모두에게 바뀌고, 재접속하면 고친 문장을 다시 받는다', () => {
  const room = new Room('123456', 'tok');
  const host = new FakePeer();
  const viewer = new FakePeer();
  room.addPeer(host, 'host');
  room.addPeer(viewer, 'viewer');
  room.pushFinal('우리 2조에만 다른 동기 다 오셨나요');
  room.pushFinal('강의를 시작하겠습니다');
  room.reviseLast('강의를 좀 시작해 보겠습니다');
  const rev = viewer.of('revise');
  assert.equal(rev.length, 1);
  assert.deepEqual([rev[0]!.line.seq, rev[0]!.line.text], [2, '강의를 좀 시작해 보겠습니다']);
  assert.equal(host.of('revise').length, 1);
  assert.equal(room.lines.at(-1)!.text, '강의를 좀 시작해 보겠습니다');
  // 마지막으로 받은 seq가 2인 수신자가 재접속하면 고친 2번 문장부터 받는다
  const back = new FakePeer();
  room.addPeer(back, 'viewer', 2);
  assert.deepEqual(back.of('history')[0]!.lines.map((l) => l.text), ['강의를 좀 시작해 보겠습니다']);
  room.end();
  assert.equal(room.reviseLast('종료 후에는 안 바뀜'), null);
});

test('이용 통계: 같은 기기의 재접속은 한 사람으로 세고, 접속 시간과 동시 접속자 변화를 기록한다', () => {
  const room = new Room('123456', 'tok');
  const a1 = new FakePeer();
  const a2 = new FakePeer();
  const b = new FakePeer();
  room.addPeer(new FakePeer(), 'host');
  room.addPeer(a1, 'viewer', 0, 'device-aaaa');
  room.addPeer(b, 'viewer'); // ID 없이 접속 → 익명으로 따로 센다
  room.removePeer(a1);
  room.addPeer(a2, 'viewer', 0, 'device-aaaa'); // 같은 기기 재접속
  const s = room.getStats();
  assert.equal(s.viewers.length, 2);
  const a = s.viewers.find((v) => v.id === 'device-aaaa')!;
  assert.equal(a.sessions, 2);
  assert.equal(a.connected, true);
  assert.deepEqual(s.timeline.map(([, n]) => n), [0, 1, 2, 1, 2]);
});
