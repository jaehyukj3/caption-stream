import type { CaptionLine } from '@caption/shared';

const pad = (n: number) => String(n).padStart(2, '0');

function hms(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function captionsToText(lines: readonly CaptionLine[]): string {
  return lines.map((l) => `[${hms(l.ts)}] ${l.text}`).join('\r\n');
}

/** 자막 전체를 .txt로 저장. BOM을 붙여 윈도우 메모장에서도 한글이 깨지지 않게 한다. */
export function downloadCaptions(lines: readonly CaptionLine[], code: string): void {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const blob = new Blob(['﻿', captionsToText(lines), '\r\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `captions_${code}_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
