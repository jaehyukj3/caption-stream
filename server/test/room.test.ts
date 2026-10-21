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

test('늦게 들어온 수신자는 이력을, 재연결 수신자는 sinceSeq 이후만 받는다', () => {
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
  assert.deepEqual(rejoin.of('history')[0]!.lines.map((l) => l.seq), [3]);
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
