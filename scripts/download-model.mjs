// 한국어 스트리밍 음성인식 모델을 models/ko-streaming/ 에 받는다 (인터넷 필요, 처음 한 번).
// 원본 압축 파일(약 420MB)에서 실제로 쓰는 int8 모델 파일(약 140MB)만 꺼낸다.
// Windows 10 이상, macOS, Linux에 기본으로 있는 tar로 압축을 푼다.
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const NAME = 'sherpa-onnx-streaming-zipformer-korean-2024-06-16';
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'models/ko-streaming');

// 원본 파일명 → 저장 파일명
const FILES = {
  'encoder-epoch-99-avg-1.int8.onnx': 'encoder.int8.onnx',
  'decoder-epoch-99-avg-1.onnx': 'decoder.onnx',
  'joiner-epoch-99-avg-1.int8.onnx': 'joiner.int8.onnx',
  'tokens.txt': 'tokens.txt',
};

if (Object.values(FILES).every((f) => existsSync(join(OUT, f)))) {
  console.log('음성 모델이 이미 있습니다:', OUT);
  process.exit(0);
}

const work = join(tmpdir(), `caption-model-${Date.now()}`);
mkdirSync(work, { recursive: true });
const archive = join(work, 'model.tar.bz2');

try {
  console.log('음성 모델을 내려받습니다 (약 420MB, 처음 한 번만)…');
  const res = await fetch(URL);
  if (!res.ok || !res.body) throw new Error(`다운로드 실패: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let got = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${pct}%\n`);
    }
  });
  await pipeline(body, createWriteStream(archive));

  console.log('압축을 풉니다…');
  const members = Object.keys(FILES).map((f) => `${NAME}/${f}`);
  // Windows: Git의 GNU tar 대신 기본 tar.exe(bsdtar) 사용 (C:\ 경로 문제)
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tar, ['-xjf', archive, '-C', work, ...members], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('압축 해제 실패 (tar)');

  mkdirSync(OUT, { recursive: true });
  for (const [src, dst] of Object.entries(FILES)) renameSync(join(work, NAME, src), join(OUT, dst));
  console.log('완료:', OUT);
} catch (e) {
  console.error('✖', e.message);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=model:download::${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
