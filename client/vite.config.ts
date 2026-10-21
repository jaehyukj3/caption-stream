import basicSsl from '@vitejs/plugin-basic-ssl';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const SERVER = `http://localhost:${process.env.SERVER_PORT ?? 3001}`;
const https = process.env.HTTPS === '1';

export default defineConfig({
  plugins: [vue(), ...(https ? [basicSsl()] : [])],
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER, ws: true },
      '/stt': { target: SERVER, ws: true },
    },
  },
});
