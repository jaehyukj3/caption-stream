import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 설정: 환경 변수가 우선, 없으면 실행 폴더의 config.json (배포 패키지는 app/config.json).
 *  - relayUrl: 중계 서버 주소 (예: https://caption-relay.xxx.workers.dev). 없으면 같은 네트워크 직접 접속만.
 */
interface Config {
  relayUrl: string | null;
}

function load(): Config {
  let file: Partial<Config> = {};
  const path = join(process.cwd(), 'config.json');
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      console.warn(`[config] ${path} 형식이 잘못되어 무시합니다.`);
    }
  }
  const relayUrl = (process.env.RELAY_URL ?? file.relayUrl ?? '').trim().replace(/\/$/, '');
  return { relayUrl: relayUrl || null };
}

export const config = load();
