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

test('설문: 종료 후에도 참석자 응답을 받아 송출자에게만 전달하고, 형식이 틀리면 거부한다', async () => {
  const { openConnection, susScore } = await import('@caption/shared');
  const room = new Room('123456', 'tok');
  const rooms = { get: (c: string) => (c === '123456' ? room : undefined), verifyHost: (_r: Room, t?: string) => t === 'tok' };
  const host = new FakePeer();
  const viewer = new FakePeer();
  const other = new FakePeer();
  const h = openConnection(host, rooms, { allowHost: true });
  const v = openConnection(viewer, rooms, { allowHost: true });
  const o = openConnection(other, rooms, { allowHost: true });
  h.handleRaw(JSON.stringify({ type: 'join', code: '123456', role: 'host', hostToken: 'tok' }));
  v.handleRaw(JSON.stringify({ type: 'join', code: '123456', role: 'viewer' }));
  h.handleRaw(JSON.stringify({ type: 'end' }));
  h.handleRaw(JSON.stringify({ type: 'surveyPrompt' }));
  assert.equal(viewer.of('surveyPrompt').length, 1);
  // 요청 이후 들어온 참석자도 요청을 받는다
  o.handleRaw(JSON.stringify({ type: 'join', code: '123456', role: 'viewer' }));
  assert.equal(other.of('surveyPrompt').length, 1);

  const answers: Record<string, number | string> = { comment: '좋아요', hearing: 1 };
  for (let i = 1; i <= 5; i++) answers[`e${i}`] = 4;
  for (let i = 1; i <= 10; i++) answers[`s${i}`] = i % 2 ? 5 : 1;
  v.handleRaw(JSON.stringify({ type: 'survey', respondentId: 'abcdefgh12', answers: { ...answers, s3: 9 } }));
  assert.equal(viewer.of('error').at(-1)!.code, 'BAD_MESSAGE');
  v.handleRaw(JSON.stringify({ type: 'survey', respondentId: 'abcdefgh12', answers }));
  v.handleRaw(JSON.stringify({ type: 'survey', respondentId: 'abcdefgh12', answers })); // 다시 내면 덮어쓴다
  assert.equal(viewer.of('surveyAck').length, 2);
  assert.equal(other.of('surveyResponses').length, 0);
  const got = host.of('surveyResponses').flatMap((m) => m.responses);
  assert.equal(got.at(-1)!.answers.comment, '좋아요');
  assert.equal(susScore(got.at(-1)!.answers), 100);

  // 송출자가 다시 접속하면 응답 전체(중복 없이)를 받는다
  const host2 = new FakePeer();
  room.addPeer(host2, 'host');
  assert.equal(host2.of('surveyResponses')[0]!.responses.length, 1);
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
