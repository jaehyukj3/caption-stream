<script setup lang="ts">
import QRCode from 'qrcode';
import { computed, onMounted, ref, watch } from 'vue';
import type { NetInfoResponse, ShareMessage } from '@caption/shared';

const props = defineProps<{ code: string; share: ShareMessage | null }>();

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

interface Target {
  key: string;
  label: string;
  url: string;
}

/**
 * 참석자가 접속할 주소 후보.
 * - 중계(LTE): 인터넷만 되면 어디서나. 노트북이 중계 서버에 연결되어 있을 때만.
 * - 같은 와이파이: 노트북의 LAN 주소 (핫스팟 192.168.137.x가 있으면 맨 앞)
 */
const lanOrigins = ref<string[]>([location.origin]);
const selectedKey = ref<string>('');
const qrDataUrl = ref('');
const qrLarge = ref(false);
const copied = ref(false);

const targets = computed<Target[]>(() => {
  const list: Target[] = [];
  if (props.share?.relayViewerUrl) list.push({ key: 'relay', label: '인터넷(LTE) — 추천', url: props.share.relayViewerUrl });
  for (const o of lanOrigins.value) {
    list.push({ key: o, label: `같은 와이파이 (${new URL(o).hostname})`, url: `${o}/view/${props.code}` });
  }
  return list;
});

// 중계가 연결되면 자동으로 중계 주소를, 끊기면 와이파이 주소를 보여 준다 (직접 고른 경우는 유지)
let userPicked = false;
watch(
  targets,
  (list) => {
    const current = list.find((t) => t.key === selectedKey.value);
    if (!current || !userPicked) selectedKey.value = list[0]?.key ?? '';
  },
  { immediate: true },
);
function pick(key: string) {
  userPicked = true;
  selectedKey.value = key;
}

const target = computed(() => targets.value.find((t) => t.key === selectedKey.value) ?? targets.value[0]!);
const isLocalOnly = computed(() => target.value.key !== 'relay' && LOCAL_HOSTS.includes(new URL(target.value.url).hostname));
const relayLabel = computed(
  () =>
    ({
      off: null,
      connecting: '인터넷(LTE) 접속 준비 중…',
      online: null,
      offline: '인터넷(LTE) 접속 끊김 — 다시 연결하는 중. 지금은 같은 와이파이로만 접속됩니다.',
    })[props.share?.relay ?? 'off'],
);

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
    lanOrigins.value = [...new Set(list)];
  } catch {
    /* net-info 실패 시 현재 주소 사용 */
  }
});

watch(
  () => target.value.url,
  async (url) => {
    qrDataUrl.value = await QRCode.toDataURL(url, { width: 512, margin: 1, errorCorrectionLevel: 'M' });
  },
  { immediate: true },
);

async function copy() {
  try {
    await navigator.clipboard.writeText(target.value.url);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    window.prompt('아래 주소를 복사하세요', target.value.url);
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
        <a class="url" :href="target.url" target="_blank" rel="noopener">{{ target.key === 'relay' ? '인터넷 주소 (QR로 접속)' : target.url }}</a>
        <div class="row">
          <button type="button" class="btn" @click="copy">{{ copied ? '복사됨 ✓' : '링크 복사' }}</button>
          <select v-if="targets.length > 1" :value="selectedKey" class="origin" aria-label="참석자 접속 방법" @change="pick(($event.target as HTMLSelectElement).value)">
            <option v-for="t in targets" :key="t.key" :value="t.key">{{ t.label }}</option>
          </select>
        </div>
      </div>
    </div>
    <p v-if="relayLabel" class="notice relay-note">{{ relayLabel }}</p>
    <p v-if="isLocalOnly" class="notice">
      지금 주소는 이 PC에서만 열립니다. 휴대폰에서 접속하려면 같은 Wi‑Fi의 LAN 주소를 선택하거나 서버에
      <code>PUBLIC_URL</code>을 설정하세요.
    </p>

    <Teleport to="body">
      <div v-if="qrLarge" class="qr-overlay" @click="qrLarge = false">
        <img :src="qrDataUrl" alt="수신 페이지 QR 코드 (확대)" />
        <div class="qr-overlay-code">방 코드 {{ code }}</div>
        <div v-if="target.key !== 'relay'" class="qr-overlay-url">{{ target.url }}</div>
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
