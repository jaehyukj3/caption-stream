// 노트북 프로그램 zip을 웹 송출 사이트(Cloudflare)에서 받을 수 있게 준비한다.
// Cloudflare 정적 파일은 한 개 25MB 제한이라 20MB씩 나눠 두고, 중계 서버(/download)가 이어 붙여 내려 준다.
// 사용: node scripts/stage-download.mjs <zip 경로> <출력 폴더(client/dist/dl)>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [zipPath, outDir] = process.argv.slice(2);
if (!zipPath || !outDir) {
  console.error('사용: node scripts/stage-download.mjs <zip> <출력 폴더>');
  process.exit(1);
}
const PART = 20 * 1024 * 1024;
const data = readFileSync(zipPath);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const name = basename(zipPath);
const parts = [];
for (let i = 0, o = 0; o < data.length; i++, o += PART) {
  const part = `${name}.part${String(i).padStart(3, '0')}`;
  writeFileSync(join(outDir, part), data.subarray(o, o + PART));
  parts.push(part);
}
const manifest = {
  file: name,
  size: data.length,
  sha256: createHash('sha256').update(data).digest('hex'),
  parts,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${name}: ${(data.length / 1e6).toFixed(0)}MB → ${parts.length}개 조각 (${outDir})`);
