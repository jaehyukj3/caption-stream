// Windows 노트북용 배포 패키지를 만든다: release/caption-stream-windows.zip
//
//   caption-stream/
//     START.bat            ← 더블클릭
//     README.txt           사용법 (파일명은 영문: zip 호환성)
//     app/
//       node.exe           Node.js 실행 파일 (설치·관리자 권한 불필요)
//       server.mjs         서버 한 파일로 묶은 것
//       public/            송출·수신 화면
//       models/ko-streaming/  한국어 음성인식 모델
//       node_modules/      음성인식 엔진(sherpa-onnx) Windows용
//
// 인터넷 없는 노트북에서도 압축만 풀면 동작한다. 만들 때만 인터넷이 필요하다.
// 사용: npm run package:windows   (어느 OS에서나 만들 수 있다)
//       --target=linux-x64 로 이 OS에서 같은 구성을 시험해 볼 수 있다.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const target = process.argv.find((a) => a.startsWith('--target='))?.slice(9) ?? 'win-x64';
const isWin = target.startsWith('win');
const NODE_MAJOR = 22;

const OUT_ROOT = join(ROOT, 'release');
const PKG = join(OUT_ROOT, 'caption-stream');
const APP = join(PKG, 'app');
const ZIP = join(OUT_ROOT, `caption-stream-${isWin ? 'windows' : target}.zip`);

const step = (m) => console.log(`\n▶ ${m}`);
// Windows에서는 Git에 딸린 GNU tar가 PATH 앞에 있을 수 있는데, C:\ 경로를 원격 주소로 오해하고
// zip을 만들지 못한다. Windows 기본 tar.exe(bsdtar)를 직접 지정한다.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`실패(${r.status ?? r.error?.message}): ${cmd} ${args.join(' ')}`);
}
const npmCli = () => {
  const d = dirname(process.execPath);
  return [join(d, 'node_modules/npm/bin/npm-cli.js'), join(d, '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
};
const npm = (args, opts) => run(process.execPath, [npmCli(), ...args], { ...opts, shell: false });

/**
 * zip을 직접 만든다. OS 기본 도구(Windows tar 등)로 만든 zip은 Windows 탐색기·Expand-Archive에서
 * 제대로 안 풀리는 경우가 있어, 표준 형식(슬래시 경로, UTF-8 파일명)으로 쓴다.
 */
async function writeZip(dir, zipPath) {
  const yazl = require('yazl');
  const zip = new yazl.ZipFile();
  const top = basename(dir);
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = join(abs, name);
      const r = `${rel}/${name}`;
      const st = statSync(a);
      if (st.isDirectory()) walk(a, r);
      // 이미 압축된 모델·실행 파일도 deflate가 조금은 줄여 준다
      else zip.addFile(a, r, { mode: st.mode, compress: true });
    }
  };
  walk(dir, top);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(zipPath));
}

async function main() {
  rmSync(OUT_ROOT, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });

  step('화면 빌드');
  npm(['run', 'build']);
  cpSync(join(ROOT, 'client/dist'), join(APP, 'public'), { recursive: true });

  step('서버를 한 파일로 묶기');
  await require('esbuild').build({
    entryPoints: [join(ROOT, 'server/src/index.ts')],
    outfile: join(APP, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: `node${NODE_MAJOR}`,
    // 네이티브 모듈은 묶지 않고 node_modules에서 불러온다
    external: ['sherpa-onnx-node', 'bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });

  step(`음성인식 엔진 설치 (${target})`);
  const sherpaVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules/sherpa-onnx-node/package.json'), 'utf8')).version;
  const [os, cpu] = target.split('-');
  writeFileSync(join(APP, 'package.json'), JSON.stringify({ name: 'caption-stream-app', private: true, type: 'module' }));
  npm(['install', `sherpa-onnx-node@${sherpaVersion}`, `--os=${os === 'win' ? 'win32' : os}`, `--cpu=${cpu}`, '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: APP });

  step('음성 모델');
  npm(['run', 'model:download']);
  cpSync(join(ROOT, 'models/ko-streaming'), join(APP, 'models/ko-streaming'), { recursive: true });

  step(`Node.js ${NODE_MAJOR} (${target})`);
  const base = `https://nodejs.org/dist/latest-v${NODE_MAJOR}.x`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const ext = isWin ? 'zip' : 'tar.gz';
  const [sum, file] = sums.split('\n').find((l) => l.endsWith(`-${target}.${ext}`))?.split(/\s+/) ?? [];
  if (!file) throw new Error(`Node.js ${target} 배포 파일을 찾지 못했습니다`);
  const archive = join(OUT_ROOT, file);
  const buf = Buffer.from(await (await fetch(`${base}/${file}`)).arrayBuffer());
  if (createHash('sha256').update(buf).digest('hex') !== sum) throw new Error('Node.js 파일 체크섬 불일치');
  writeFileSync(archive, buf);
  const folder = file.replace(`.${ext}`, '');
  if (isWin) {
    // node.exe만 꺼낸다 (npm 등은 실행에 필요 없음)
    if (process.platform === 'win32') run(TAR, ['-xf', archive, '-C', OUT_ROOT, `${folder}/node.exe`]);
    else run('unzip', ['-q', archive, `${folder}/node.exe`, '-d', OUT_ROOT]);
    cpSync(join(OUT_ROOT, folder, 'node.exe'), join(APP, 'node.exe'));
  } else {
    run('tar', ['-xzf', archive, '-C', OUT_ROOT, `${folder}/bin/node`]);
    cpSync(join(OUT_ROOT, folder, 'bin/node'), join(APP, 'node'));
  }
  rmSync(archive);
  rmSync(join(OUT_ROOT, folder), { recursive: true, force: true });

  // 중계 서버 주소 (있으면 와이파이 없이 LTE로도 접속 가능). 나중에 app/config.json을 직접 고쳐도 된다.
  const relayUrl = process.env.RELAY_URL?.trim() || null;
  writeFileSync(join(APP, 'config.json'), JSON.stringify({ relayUrl }, null, 2));
  console.log(relayUrl ? `  중계 서버: ${relayUrl}` : '  중계 서버 없음 (같은 와이파이 접속만)');

  step('실행 파일과 사용법');
  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
  // .bat은 영어만 쓴다 (코드페이지에 따라 한글이 깨질 수 있음). 한글 안내는 서버가 출력한다.
  writeFileSync(
    join(PKG, 'START.bat'),
    crlf(`@echo off
  title Caption Server - close this window to stop
  cd /d "%~dp0app"
  set "STATIC_DIR=%~dp0app\\public"
  set "STT_MODEL_DIR=%~dp0app\\models\\ko-streaming"
  set "OPEN_BROWSER=1"
  "%~dp0app\\node.exe" "%~dp0app\\server.mjs"
  if errorlevel 1 pause
  `),
  );
  if (!isWin) {
    writeFileSync(
      join(PKG, 'start.sh'),
      `#!/bin/sh\ncd "$(dirname "$0")/app"\nSTATIC_DIR="$PWD/public" STT_MODEL_DIR="$PWD/models/ko-streaming" OPEN_BROWSER=1 exec ./node server.mjs\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(join(PKG, 'README.txt'), '﻿' + crlf(readFileSync(join(ROOT, 'scripts/package-readme.txt'), 'utf8')));

  step('압축');
  rmSync(ZIP, { force: true });
  await writeZip(PKG, ZIP);
  const mb = (readFileSync(ZIP).length / 1e6).toFixed(0);
  console.log(`\n✅ 완료: ${ZIP} (${mb}MB)`);
}

try {
  await main();
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  // GitHub Actions에서는 실패 사유를 주석(annotation)으로도 남긴다
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=package:windows::${e.message.replace(/\r?\n/g, '%0A')}`);
  process.exit(1);
}
