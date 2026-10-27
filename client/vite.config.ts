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

export default defineConfig({
  plugins: [vue(), ...(https ? [basicSsl()] : [])],
  define: { __BUILD__: JSON.stringify(buildVersion()) },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER, ws: true },
      '/stt': { target: SERVER, ws: true },
    },
  },
});
