// 폰(브라우저) 안 음성인식 엔진을 웹 송출 사이트에 올릴 수 있게 준비한다.
// sherpa-onnx 공식 WebAssembly 빌드(SenseVoice + Silero VAD)를 받아,
// Cloudflare 정적 파일 한 개 25MB 제한에 맞춰 모델 묶음(.data, 약 240MB)을 20MB씩 나눈다.
// 사용: node scripts/stage-web-stt.mjs <출력 폴더(client/dist/stt-web/engine)> [받아 둔 tar.bz2]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 이 버전은 sherpa-onnx 릴리스에 SenseVoice 웹 빌드가 올라와 있는 최신 버전이다
const VERSION = '1.12.30';
const NAME = `sherpa-onnx-wasm-simd-${VERSION}-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small`;
const URL_ = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/${NAME}.tar.bz2`;
const PART = 20 * 1024 * 1024;
const ENGINE_FILES = ['sherpa-onnx-wasm-main-vad-asr.js', 'sherpa-onnx-wasm-main-vad-asr.wasm', 'sherpa-onnx-asr.js', 'sherpa-onnx-vad.js'];

const [outDir, tarArg] = process.argv.slice(2);
if (!outDir) {
  console.error('사용: node scripts/stage-web-stt.mjs <출력 폴더> [tar.bz2]');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'web-stt-'));
try {
  let tar = tarArg;
  if (!tar || !existsSync(tar)) {
    tar = join(work, `${NAME}.tar.bz2`);
    console.log(`받는 중: ${URL_}`);
    const res = await fetch(URL_);
    if (!res.ok) throw new Error(`다운로드 실패 ${res.status}`);
    writeFileSync(tar, Buffer.from(await res.arrayBuffer()));
  }
  execFileSync('tar', ['xjf', tar, '-C', work]);
  const src = join(work, NAME);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const f of ENGINE_FILES) copyFileSync(join(src, f), join(outDir, f));

  const data = readFileSync(join(src, 'sherpa-onnx-wasm-main-vad-asr.data'));
  const parts = [];
  for (let i = 0, o = 0; o < data.length; i++, o += PART) {
    const name = `model.data.part${String(i).padStart(3, '0')}`;
    const chunk = data.subarray(o, o + PART);
    writeFileSync(join(outDir, name), chunk);
    parts.push({ name, size: chunk.length });
  }
  // 묶음 안 파일 위치 (안드로이드 앱이 조각을 받아 모델 파일로 바로 나눠 쓴다)
  const loader = readFileSync(join(src, 'sherpa-onnx-wasm-main-vad-asr.js'), 'utf8');
  const files = [...loader.matchAll(/\{"filename":"\/([^"]+)","start":(\d+),"end":(\d+)\}/g)].map((m) => ({ name: m[1], start: +m[2], end: +m[3] }));
  if (!files.length || files.at(-1).end !== data.length) throw new Error('모델 묶음 안 파일 위치를 찾지 못했습니다');
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ version: VERSION, size: data.length, parts, files }, null, 2));
  writeFileSync(
    join(outDir, 'NOTICE.txt'),
    [
      `sherpa-onnx ${VERSION} WebAssembly build (Apache-2.0) — https://github.com/k2-fsa/sherpa-onnx`,
      'SenseVoice Small (FunAudioLLM, FunASR Model License 1.1) — https://github.com/FunAudioLLM/SenseVoice',
      'Silero VAD (MIT) — https://github.com/snakers4/silero-vad',
      '',
    ].join('\n'),
  );
  console.log(`웹 음성인식 엔진 ${VERSION}: 모델 ${(data.length / 1e6).toFixed(0)}MB → ${parts.length}개 조각 (${outDir})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
