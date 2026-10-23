import type { CaptionLine } from '@caption/shared';

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

/** 텍스트는 BOM을 붙여 윈도우 메모장·엑셀에서도 한글이 깨지지 않게 한다 (JSON은 붙이지 않음) */
export function saveText(filename: string, text: string, mime: string): void {
  const blob = new Blob([mime === 'application/json' ? '' : '\ufeff', text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
