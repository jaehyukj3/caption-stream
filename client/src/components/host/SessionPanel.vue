<script setup lang="ts">
import QRCode from 'qrcode';
import { computed, onMounted, ref, watch } from 'vue';
import type { NetInfoResponse } from '@caption/shared';

const props = defineProps<{ code: string }>();

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * 수신자가 접속할 주소. 송출자가 localhost로 열었으면 휴대폰이 접근할 수 없으므로
 * 서버가 알려준 LAN IP(또는 PUBLIC_URL)로 바꿔서 QR을 만든다.
 */
const origins = ref<string[]>([location.origin]);
const origin = ref(location.origin);
const qrDataUrl = ref('');
const qrLarge = ref(false);
const copied = ref(false);

const viewerUrl = computed(() => `${origin.value}/view/${props.code}`);
const isLocalOnly = computed(() => LOCAL_HOSTS.includes(new URL(origin.value).hostname));

onMounted(async () => {
  try {
    const info = (await fetch('/api/net-info').then((r) => r.json())) as NetInfoResponse;
    const list: string[] = [];
    if (info.publicUrl) list.push(info.publicUrl);
    if (LOCAL_HOSTS.includes(location.hostname)) {
      const port = location.port ? `:${location.port}` : '';
      list.push(...info.lanAddresses.map((ip) => `${location.protocol}//${ip}${port}`));
    }
    list.push(location.origin);
    origins.value = [...new Set(list)];
    origin.value = origins.value[0]!;
  } catch {
    /* net-info 실패 시 현재 주소 사용 */
  }
});

watch(
  viewerUrl,
  async (url) => {
    qrDataUrl.value = await QRCode.toDataURL(url, { width: 512, margin: 1, errorCorrectionLevel: 'M' });
  },
  { immediate: true },
);

async function copy() {
  try {
    await navigator.clipboard.writeText(viewerUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    window.prompt('아래 주소를 복사하세요', viewerUrl.value);
  }
}
</script>

<template>
  <section class="card session">
    <h2>수신 안내</h2>
    <div class="session-body">
      <button type="button" class="qr" title="QR 크게 보기" @click="qrLarge = true">
        <img v-if="qrDataUrl" :src="qrDataUrl" alt="수신 페이지 QR 코드" />
      </button>
      <div class="info">
        <div class="code-label muted">방 코드</div>
        <div class="code">{{ code.slice(0, 3) }} {{ code.slice(3) }}</div>
        <a class="url" :href="viewerUrl" target="_blank" rel="noopener">{{ viewerUrl }}</a>
        <div class="row">
          <button type="button" class="btn" @click="copy">{{ copied ? '복사됨 ✓' : '링크 복사' }}</button>
          <select v-if="origins.length > 1" v-model="origin" class="origin" aria-label="수신 주소 선택">
            <option v-for="o in origins" :key="o" :value="o">{{ o }}</option>
          </select>
        </div>
      </div>
    </div>
    <p v-if="isLocalOnly" class="notice">
      지금 주소는 이 PC에서만 열립니다. 휴대폰에서 접속하려면 같은 Wi‑Fi의 LAN 주소를 선택하거나 서버에
      <code>PUBLIC_URL</code>을 설정하세요.
    </p>

    <Teleport to="body">
      <div v-if="qrLarge" class="qr-overlay" @click="qrLarge = false">
        <img :src="qrDataUrl" alt="수신 페이지 QR 코드 (확대)" />
        <div class="qr-overlay-code">방 코드 {{ code }}</div>
        <div class="qr-overlay-url">{{ viewerUrl }}</div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.session-body {
  display: flex;
  gap: 16px;
  align-items: center;
}
.qr {
  flex: none;
  width: 132px;
  height: 132px;
  padding: 6px;
  border: 0;
  border-radius: 10px;
  background: #fff;
  cursor: zoom-in;
}
.qr img {
  width: 100%;
  height: 100%;
  display: block;
  image-rendering: pixelated;
}
.info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.code-label {
  font-size: 13px;
}
.code {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
}
.url {
  color: var(--muted);
  font-size: 13px;
  word-break: break-all;
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.origin {
  min-height: 40px;
  max-width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  padding: 0 8px;
}
.notice {
  margin: 12px 0 0;
}
.qr-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: #fff;
  color: #111;
  cursor: zoom-out;
}
.qr-overlay img {
  width: min(70vh, 80vw);
  height: auto;
  image-rendering: pixelated;
}
.qr-overlay-code {
  font-size: clamp(28px, 5vw, 56px);
  font-weight: 800;
  letter-spacing: 0.08em;
}
.qr-overlay-url {
  font-size: clamp(16px, 2.4vw, 28px);
}
</style>
