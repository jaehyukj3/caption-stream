import type { CaptionLine } from '@caption/shared';
import { nativeApp } from '../stt/NativeSttProvider';

const pad = (n: number) => String(n).padStart(2, '0');

function hms(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function captionsToText(lines: readonly CaptionLine[]): string {
  return lines.map((l) => `[${hms(l.ts)}] ${l.text}`).join('\r\n');
}

export function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 자막 전체를 .txt로 저장 */
export function downloadCaptions(lines: readonly CaptionLine[], code: string): void {
  saveText(`captions_${code}_${stamp()}.txt`, captionsToText(lines) + '\r\n', 'text/plain');
}

/** 파일 그대로 저장 */
export function saveBlob(filename: string, blob: Blob): void {
  if (nativeApp) {
    void saveInApp(filename, blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 텍스트는 BOM을 붙여 윈도우 메모장·엑셀에서도 한글이 깨지지 않게 한다 (JSON은 붙이지 않음) */
export function saveText(filename: string, text: string, mime: string): void {
  const blob = new Blob([mime === 'application/json' ? '' : '\ufeff', text], { type: `${mime};charset=utf-8` });
  if (nativeApp) {
    void saveInApp(filename, blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 안드로이드 앱 안에서는 브라우저식 내려받기가 동작하지 않아 앱이 다운로드 폴더에 저장한다 */
async function saveInApp(filename: string, blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  nativeApp!.saveFile(filename, blob.type.split(';')[0] || 'application/octet-stream', btoa(bin));
}
