import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * 노트북 실행용 동작 (OPEN_BROWSER=1일 때, START.bat이 켠다):
 * 서버가 뜨면 안내를 출력하고 크롬(없으면 엣지)으로 송출 화면을 연다.
 */
export const desktopMode = process.env.OPEN_BROWSER === '1';

/** 음성인식 화면은 크롬·엣지 기준으로 만들었으므로 그 둘을 우선 찾는다 */
export function openBrowser(url: string): void {
  const opts = { detached: true, stdio: 'ignore' as const };
  if (process.platform === 'win32') {
    const candidates = [
      [process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'],
      [process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'],
      [process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'],
      [process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'],
      [process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'],
    ].flatMap(([base, rel]) => (base ? [join(base, rel!)] : []));
    const exe = candidates.find(existsSync);
    if (exe) spawn(exe, [url], opts).unref();
    else spawn('cmd', ['/c', 'start', '""', url], opts).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], opts).unref();
  } else {
    spawn('xdg-open', [url], opts).on('error', () => {}).unref();
  }
}

export function printGuide(port: number): void {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a!.address}:${port}`);
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log('  ✅ 실시간 자막이 켜졌습니다.');
  console.log(`  송출 화면 : http://localhost:${port}/host  (자동으로 열립니다)`);
  if (lan.length) console.log(`  참석자    : 송출 화면의 QR 코드 (같은 와이파이)  예) ${lan[0]}`);
  console.log('');
  console.log('  ⚠ 이 창을 닫으면 자막이 꺼집니다. 강의 중에는 열어 두세요.');
  console.log('  ⚠ "Windows 보안 경고"가 뜨면 [액세스 허용]을 눌러야 휴대폰에서 접속됩니다.');
  console.log(`${line}\n`);
}

/** 이미 켜져 있으면(START.bat을 두 번 누른 경우) 화면만 다시 연다 */
export async function isAlreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}
