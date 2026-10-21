// 음성인식 모델을 models/ko-sensevoice/ 에 받는다 (인터넷 필요, 처음 한 번).
//  - SenseVoice (FunAudioLLM, int8): 한·중·영·일 음성인식. 문장 단위로 정확하게 받아 적는다.
//  - Silero VAD: 말하는 구간을 찾아 문장 단위로 끊는다.
// SenseVoice 원본 압축 파일(약 160MB)에서 쓰는 파일만 꺼낸다.
// 압축은 Windows 10 이상·macOS·Linux 기본 tar로 푼다.
import { spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const SENSEVOICE = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'models/ko-sensevoice');

// 압축 안 원본 파일명 → 저장 파일명
const FILES = {
  'model.int8.onnx': 'model.int8.onnx',
  'tokens.txt': 'tokens.txt',
  LICENSE: 'LICENSE-SenseVoice.txt',
};
const NEEDED = [...Object.values(FILES), 'silero_vad.onnx'];

if (NEEDED.every((f) => existsSync(join(OUT, f)))) {
  console.log('음성 모델이 이미 있습니다:', OUT);
  process.exit(0);
}

async function download(url, dest, label) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`다운로드 실패(${label}): HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let got = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (total > 5e6 && pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${label} ${pct}%\n`);
    }
  });
  await pipeline(body, createWriteStream(dest));
}

const work = join(tmpdir(), `caption-model-${Date.now()}`);
mkdirSync(work, { recursive: true });

try {
  mkdirSync(OUT, { recursive: true });
  console.log('음성 모델을 내려받습니다 (약 160MB, 처음 한 번만)…');
  await download(`${BASE}/silero_vad.onnx`, join(OUT, 'silero_vad.onnx'), 'VAD');

  const archive = join(work, 'sensevoice.tar.bz2');
  await download(`${BASE}/${SENSEVOICE}.tar.bz2`, archive, 'SenseVoice');

  console.log('압축을 풉니다…');
  // Windows: Git의 GNU tar 대신 기본 tar.exe(bsdtar) 사용 (C:\ 경로 문제)
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const members = Object.keys(FILES).map((f) => `${SENSEVOICE}/${f}`);
  const r = spawnSync(tar, ['-xjf', archive, '-C', work, ...members], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('압축 해제 실패 (tar)');

  // 임시 폴더와 대상이 다른 드라이브일 수 있어(C: → D:) rename 대신 복사한다
  for (const [src, dst] of Object.entries(FILES)) copyFileSync(join(work, SENSEVOICE, src), join(OUT, dst));
  console.log('완료:', OUT);
} catch (e) {
  console.error('✖', e.message);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=model:download::${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
