// 압축을 푼 배포 패키지를 실제로 켜서 확인한다 (GitHub Actions의 Windows에서 실행).
// 1) 서버가 뜨는지  2) 음성인식 엔진이 올라왔는지  3) 오디오를 넣으면 엔진이 처리하는지
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function annotate(title, msg) {
  console.error(`FAIL [${title}]`, msg);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=${title}::${String(msg).replace(/\r?\n/g, '%0A')}`);
}

// 인자가 zip이면 사용자가 하듯 압축을 푼다 (Windows: 탐색기 '압축 풀기'와 같은 Expand-Archive)
let pkg = process.argv[2];
if (pkg.endsWith('.zip')) {
  const dest = mkdtempSync(join(tmpdir(), 'smoke-'));
  const r =
    process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${pkg}' -DestinationPath '${dest}' -Force`], { encoding: 'utf8' })
      : spawnSync('unzip', ['-q', pkg, '-d', dest], { encoding: 'utf8' });
  if (r.status !== 0) {
    annotate('unzip', `${r.stderr}${r.stdout}`);
    process.exit(1);
  }
  pkg = join(dest, 'caption-stream');
}
const app = join(pkg, 'app');
const listing = existsSync(pkg) ? `${readdirSync(pkg).join(', ')} | app: ${existsSync(app) ? readdirSync(app).join(', ') : '(없음)'}` : '(패키지 폴더 없음)';
console.log('package contents:', listing);
const exe = join(app, process.platform === 'win32' ? 'node.exe' : 'node');
const server = spawn(exe, [join(app, 'server.mjs')], {
  cwd: app,
  env: { ...process.env, PORT: '3001', STATIC_DIR: join(app, 'public'), STT_MODEL_DIR: join(app, 'models/ko-streaming') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// 실패 시 원인을 보이도록 서버 출력을 모아 둔다
let output = '';
for (const s of [server.stdout, server.stderr]) {
  s.on('data', (d) => {
    output += d;
    process.stdout.write(d);
  });
}
server.on('exit', (code) => {
  if (code !== null && code !== 0) fail(`server exited with code ${code}`);
});
function fail(m) {
  const detail = `${m}\n--- contents ---\n${listing}\n--- server output ---\n${output.slice(-1500)}`;
  annotate('smoke test', detail);
  server.kill();
  process.exit(1);
}

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
