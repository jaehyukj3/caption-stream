// 압축을 푼 배포 패키지를 실제로 켜서 확인한다 (GitHub Actions의 Windows에서 실행).
// 1) 서버가 뜨는지  2) 음성인식 엔진이 올라왔는지  3) 오디오를 넣으면 엔진이 처리하는지
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const pkg = process.argv[2];
const app = join(pkg, 'app');
const exe = join(app, process.platform === 'win32' ? 'node.exe' : 'node');
const server = spawn(exe, [join(app, 'server.mjs')], {
  cwd: app,
  env: { ...process.env, PORT: '3001', STATIC_DIR: join(app, 'public'), STT_MODEL_DIR: join(app, 'models/ko-streaming') },
  stdio: 'inherit',
});
const fail = (m) => {
  console.error('FAIL', m);
  server.kill();
  process.exit(1);
};

let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  ok = await fetch('http://localhost:3001/api/health').then((r) => r.ok, () => false);
  if (!ok) await new Promise((r) => setTimeout(r, 500));
}
if (!ok) fail('server did not start');

const status = await (await fetch('http://localhost:3001/api/stt-status')).json();
if (!status.available) fail(`stt unavailable: ${status.message}`);
const page = await fetch('http://localhost:3001/host');
if (!page.ok || !(await page.text()).includes('<div id="app">')) fail('host page not served');

// 1초 분량의 소리(사인파)를 보내고 flush → 엔진이 처리해 flushed로 답하는지
const ws = new WebSocket('ws://localhost:3001/stt');
const msgs = [];
await new Promise((resolve, reject) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m.type);
    if (m.type === 'ready') {
      const pcm = new Int16Array(16000);
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 8) * 8000;
      for (let o = 0; o < pcm.length; o += 1600) ws.send(pcm.slice(o, o + 1600).buffer);
      ws.send(JSON.stringify({ type: 'flush' }));
    }
    if (m.type === 'flushed') resolve();
    if (m.type === 'error') reject(new Error(m.message));
  };
  setTimeout(() => reject(new Error(`timeout, got ${msgs}`)), 15000);
}).catch((e) => fail(e.message));
ws.close();
console.log('OK: server, stt engine, audio decode', msgs.join(','));
server.kill();
process.exit(0);
