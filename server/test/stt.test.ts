// 로컬 음성인식 통합 테스트: 실제 모델로 /stt 에 음성을 흘려 확정 문장이 오는지 확인.
// 모델(models/ko-streaming)과 STT_TEST_WAV(16kHz mono 한국어 wav)가 있을 때만 실행된다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { SttServerMessage } from '@caption/shared';
import { MODEL_DIR } from '../src/stt/SttEngine.js';

const WAV = process.env.STT_TEST_WAV;
const PORT = 3199;
const skip = !existsSync(MODEL_DIR) || !WAV ? '모델 또는 STT_TEST_WAV 없음' : false;

/** 44바이트 헤더의 16bit PCM wav에서 샘플만 꺼낸다 */
function readPcm16(path: string): Buffer {
  const buf = readFileSync(path);
  const dataAt = buf.indexOf('data') + 8;
  return buf.subarray(dataAt);
}

async function withServer(fn: () => Promise<void>) {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) {
      if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await fn();
  } finally {
    proc.kill();
  }
}

function open(headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}/stt`, { headers });
  const msgs: SttServerMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  return { ws, msgs };
}

const until = async (cond: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !cond(); t += 50) await new Promise((r) => setTimeout(r, 50));
};

test('로컬 음성인식: 음성을 흘려보내면 interim과 띄어쓰기가 있는 final이 온다', { skip }, () =>
  withServer(async () => {
    // 엔진(모델) 로딩은 서버 시작 후 몇 초 걸린다
    let status = { available: false };
    for (let i = 0; i < 60 && !status.available; i++) {
      status = (await fetch(`http://localhost:${PORT}/api/stt-status`).then((r) => r.json())) as { available: boolean };
      if (!status.available) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(status.available, true);

    const { ws, msgs } = open();
    await until(() => msgs.some((m) => m.type === 'ready'));
    const pcm = readPcm16(WAV!);
    // 실제 마이크처럼 시간 간격을 두고 보낸다 (4배속: 100ms 분량을 25ms마다)
    for (let o = 0; o < pcm.length; o += 3200) {
      ws.send(pcm.subarray(o, o + 3200));
      await new Promise((r) => setTimeout(r, 25));
    }
    ws.send(JSON.stringify({ type: 'flush' }));
    await until(() => msgs.some((m) => m.type === 'flushed'), 15000);
    ws.close();

    const finals = msgs.filter((m) => m.type === 'final').map((m) => (m as { text: string }).text);
    assert.ok(msgs.some((m) => m.type === 'interim'), 'interim 결과가 있어야 함');
    assert.ok(finals.length >= 1, `final 결과가 있어야 함: ${JSON.stringify(msgs)}`);
    assert.match(finals[0]!, /\S \S/, `띄어쓰기가 있어야 함: ${finals[0]}`);
    console.log('  인식 결과:', finals[0]);
  }));

test('로컬 음성인식: localhost가 아닌 주소로 온 연결은 거부한다', { skip }, () =>
  withServer(async () => {
    const { msgs } = open({ Host: `192.168.0.10:${PORT}` });
    await until(() => msgs.length > 0);
    assert.equal(msgs[0]?.type, 'error');
    assert.equal((msgs[0] as { code: string }).code, 'NOT_LOCAL');
  }));
