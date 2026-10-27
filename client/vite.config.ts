import basicSsl from '@vitejs/plugin-basic-ssl';
import vue from '@vitejs/plugin-vue';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

const SERVER = `http://localhost:${process.env.SERVER_PORT ?? 3001}`;
const https = process.env.HTTPS === '1';

/** 화면에 작게 보여 줄 빌드 버전 (폰에 최신 화면이 떴는지 확인용) */
function buildVersion(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

const BUILD = buildVersion();

export default defineConfig({
  plugins: [
    vue(),
    ...(https ? [basicSsl()] : []),
    // 화면이 예전 버전인지 알 수 있게 최신 버전 번호를 파일로 둔다 (/version.json)
    {
      name: 'version-file',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) });
      },
    },
  ],
  define: { __BUILD__: JSON.stringify(BUILD) },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER, ws: true },
      '/stt': { target: SERVER, ws: true },
    },
  },
});
