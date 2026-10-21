// 노트북 실행기: START-Windows.bat / START-Mac.command가 Node.js를 준비한 뒤 이 파일을 실행한다.
// 1) 필요한 패키지 설치  2) 화면 빌드  3) 서버 시작  4) 크롬(없으면 엣지)으로 송출 화면 열기
// 이미 설치·빌드되어 있으면 건너뛰므로 두 번째 실행부터는 몇 초 만에 켜진다.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3001);
const LOCAL_URL = `http://localhost:${PORT}`;
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const step = (msg) => console.log(`\n▶ ${msg}`);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

/** 실행 중인 node와 함께 설치된 npm을 셸 없이 직접 실행 */
function npm(args) {
  const nodeDir = dirname(process.execPath);
  const cli = [
    join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), // Windows 배포판
    join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'), // macOS/Linux 배포판
  ].find(existsSync);
  const r = cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', shell: isWin });
  return r.status === 0;
}

function installDeps() {
  const lock = readFileSync(join(ROOT, 'package-lock.json'));
  const hash = createHash('sha256').update(lock).digest('hex');
  const marker = join(ROOT, 'node_modules/.launcher-installed');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === hash) return;

  step('필요한 파일을 설치합니다 (처음 한 번, 1~3분 걸립니다)…');
  if (!npm(['ci', '--include=dev', '--no-audit', '--no-fund'])) {
    fail('설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.');
  }
  writeFileSync(marker, hash);
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((f) => newestMtime(join(path, f))));
}

function buildClient() {
  const built = join(ROOT, 'client/dist/index.html');
  const sources = ['client/src', 'client/index.html', 'client/vite.config.ts', 'shared/src'].map((p) => join(ROOT, p));
  if (existsSync(built) && statSync(built).mtimeMs >= Math.max(...sources.map(newestMtime))) return;

  step('화면을 준비합니다…');
  if (!npm(['run', 'build'])) fail('화면 빌드에 실패했습니다.');
}

async function isRunning() {
  try {
    const res = await fetch(`${LOCAL_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function startServer() {
  step('자막 서버를 시작합니다…');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT) },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  return child;
}

/** 음성인식(Web Speech API)은 크롬·엣지에서만 되므로 그 둘을 우선 찾는다 */
function openBrowser(url) {
  if (isWin) {
    const candidates = [
      [process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'],
      [process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'],
      [process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'],
      [process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'],
      [process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'],
    ]
      .filter(([base]) => base)
      .map(([base, rel]) => join(base, rel));
    const exe = candidates.find(existsSync);
    if (exe) spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (isMac) {
    const app = ['Google Chrome', 'Microsoft Edge'].find((a) => existsSync(`/Applications/${a}.app`));
    spawn('open', app ? ['-a', app, url] : [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function lanUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

function printGuide() {
  const line = '─'.repeat(56);
  console.log(`\n${line}`);
  console.log('  ✅ 자막 서버가 켜졌습니다.');
  console.log(`  송출 화면 : ${LOCAL_URL}/host  (크롬/엣지로 자동으로 열립니다)`);
  const lan = lanUrls();
  if (lan.length) console.log(`  참석자    : 송출 화면의 QR 코드 (같은 Wi‑Fi)  예) ${lan[0]}`);
  console.log('');
  console.log('  ⚠ 이 창을 닫으면 자막 서버가 꺼집니다. 강의 중에는 열어 두세요.');
  if (isWin) console.log('  ⚠ "Windows 보안 경고"가 뜨면 [액세스 허용]을 눌러야 휴대폰에서 접속됩니다.');
  console.log(`${line}\n`);
}

// ─────────────────────────────────────────────
if (await isRunning()) {
  console.log('이미 자막 서버가 실행 중입니다. 송출 화면을 엽니다.');
  openBrowser(`${LOCAL_URL}/host`);
  process.exit(0);
}

installDeps();
buildClient();
startServer();

for (let i = 0; i < 60 && !(await isRunning()); i++) await new Promise((r) => setTimeout(r, 500));
if (!(await isRunning())) fail(`서버가 시작되지 않았습니다. 포트 ${PORT}을(를) 다른 프로그램이 쓰고 있는지 확인해 주세요.`);
printGuide();
openBrowser(`${LOCAL_URL}/host`);
