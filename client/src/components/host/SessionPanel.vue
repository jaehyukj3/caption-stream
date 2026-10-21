<script setup lang="ts">
import QRCode from 'qrcode';
import { computed, onMounted, ref, watch } from 'vue';
import type { NetInfoResponse, ShareMessage } from '@caption/shared';

const props = withDefaults(
  defineProps<{
    code: string;
    share: ShareMessage | null;
    /** 같은 와이파이 접속을 지원하는지 (웹 송출은 노트북 서버가 없어 인터넷 주소만) */
    lan?: boolean;
  }>(),
  { lan: true },
);

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

interface Target {
  key: string;
  label: string;
  url: string;
}

/**
 * 참석자가 접속할 주소 후보.
 * - 인터넷(LTE): 중계 서버를 거쳐 어디서나. 중계가 연결돼 있을 때만.
 * - 같은 와이파이: 노트북의 LAN 주소 (핫스팟 192.168.137.x가 있으면 맨 앞).
 *   노트북 실행에서는 방화벽 창을 피하려고 이 접속을 처음엔 닫아 두고, 고를 때 연다.
 */
const net = ref<NetInfoResponse | null>(null);
const lanOpening = ref(false);
const lanError = ref('');
const selectedKey = ref<string>('');
const qrDataUrl = ref('');
const qrLarge = ref(false);
const copied = ref(false);

const lanOrigins = computed<string[]>(() => {
  if (!props.lan) return [];
  const info = net.value;
  if (!info) return LOCAL_HOSTS.includes(location.hostname) ? [] : [location.origin];
  const list: string[] = [];
  if (info.publicUrl) list.push(info.publicUrl);
  if (LOCAL_HOSTS.includes(location.hostname)) {
    const port = info.lanPort ?? (location.port ? Number(location.port) : null);
    list.push(...info.lanAddresses.map((ip) => `${location.protocol}//${ip}${port ? `:${port}` : ''}`));
  } else {
    list.push(location.origin);
  }
  return [...new Set(list)];
});

const targets = computed<Target[]>(() => {
  const list: Target[] = [];
  if (props.share?.relayViewerUrl) list.push({ key: 'relay', label: '인터넷(LTE) — 추천', url: props.share.relayViewerUrl });
  for (const o of lanOrigins.value) {
    list.push({ key: o, label: `같은 와이파이 (${new URL(o).hostname})`, url: `${o}/view/${props.code}` });
  }
  return list;
});

/** 중계 연결을 기다리는 중 (이때 와이파이 주소로 넘어가 버리면 매번 방화벽 창이 뜬다) */
const waitingRelay = computed(() => !props.share || (props.share.relay === 'connecting' && !props.share.relayViewerUrl));

// 중계가 연결되면 인터넷 주소를, 안 되면 와이파이 주소를 보여 준다 (직접 고른 경우는 유지)
let userPicked = false;
watch(
  [targets, waitingRelay],
  ([list, waiting]) => {
    const current = list.find((t) => t.key === selectedKey.value);
    if (current && userPicked) return;
    if (waiting && !list.some((t) => t.key === 'relay')) {
      selectedKey.value = '';
      return;
    }
    selectedKey.value = list[0]?.key ?? '';
  },
  { immediate: true },
);
function pick(key: string) {
  userPicked = true;
  selectedKey.value = key;
}

const target = computed(() => targets.value.find((t) => t.key === selectedKey.value) ?? null);
const isLanTarget = computed(() => !!target.value && target.value.key !== 'relay');
const isLocalOnly = computed(() => isLanTarget.value && LOCAL_HOSTS.includes(new URL(target.value!.url).hostname));

// 같은 와이파이 주소를 보여 줘야 할 때 그 접속을 연다 (이때 Windows 방화벽 창이 한 번 뜰 수 있다)
watch(
  isLanTarget,
  async (lanNeeded) => {
    if (!lanNeeded || !net.value || net.value.lanEnabled || lanOpening.value) return;
    lanOpening.value = true;
    lanError.value = '';
    try {
      const res = await fetch('/api/lan', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      net.value = (await res.json()) as NetInfoResponse;
    } catch (e) {
      lanError.value = `같은 와이파이 접속을 열지 못했습니다 (${(e as Error).message}).`;
    } finally {
      lanOpening.value = false;
    }
  },
);

const relayLabel = computed(
  () =>
    ({
      off: null,
      connecting: '인터넷(LTE) 접속 준비 중…',
      online: null,
      offline: props.lan
        ? '인터넷(LTE) 접속 끊김 — 다시 연결하는 중. 지금은 같은 와이파이로만 접속됩니다.'
        : '인터넷 연결이 끊겨 다시 연결하는 중입니다.',
    })[props.share?.relay ?? 'off'],
);

/** QR을 보여 줄 수 있는 상태인지 (와이파이 주소는 접속이 열린 뒤에) */
const qrReady = computed(() => !!target.value && !(isLanTarget.value && net.value && !net.value.lanEnabled));

onMounted(async () => {
  if (!props.lan) return;
  try {
    const res = await fetch('/api/net-info');
    if (res.headers.get('content-type')?.includes('json')) net.value = (await res.json()) as NetInfoResponse;
  } catch {
    /* net-info 실패 시 현재 주소 사용 */
  }
});

watch(
  () => (qrReady.value ? target.value!.url : ''),
  async (url) => {
    qrDataUrl.value = url ? await QRCode.toDataURL(url, { width: 512, margin: 1, errorCorrectionLevel: 'M' }) : '';
  },
  { immediate: true },
);

async function copy() {
  if (!target.value) return;
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
      <button type="button" class="qr" title="QR 크게 보기" :disabled="!qrDataUrl" @click="qrLarge = true">
        <img v-if="qrDataUrl" :src="qrDataUrl" alt="수신 페이지 QR 코드" />
        <span v-else class="qr-wait">{{ lanOpening ? '와이파이 접속 여는 중…' : '접속 주소 준비 중…' }}</span>
      </button>
      <div class="info">
        <div class="code-label muted">방 코드</div>
        <div class="code">{{ code.slice(0, 3) }} {{ code.slice(3) }}</div>
        <a v-if="target && qrReady" class="url" :href="target.url" target="_blank" rel="noopener">{{ target.key === 'relay' ? '인터넷 주소 (QR로 접속)' : target.url }}</a>
        <div class="row">
          <button type="button" class="btn" :disabled="!qrReady" @click="copy">{{ copied ? '복사됨 ✓' : '링크 복사' }}</button>
          <select v-if="targets.length > 1" :value="selectedKey" class="origin" aria-label="참석자 접속 방법" @change="pick(($event.target as HTMLSelectElement).value)">
            <option v-for="t in targets" :key="t.key" :value="t.key">{{ t.label }}</option>
          </select>
        </div>
      </div>
    </div>
    <p v-if="relayLabel" class="notice relay-note">{{ relayLabel }}</p>
    <p v-if="lanOpening" class="notice">같은 와이파이 접속을 여는 중입니다. Windows 보안 경고가 뜨면 [액세스 허용]을 눌러 주세요.</p>
    <p v-if="lanError" class="notice is-error">{{ lanError }}</p>
    <p v-if="isLocalOnly" class="notice">
      지금 주소는 이 PC에서만 열립니다. 휴대폰에서 접속하려면 같은 Wi‑Fi의 LAN 주소를 선택하거나 서버에
      <code>PUBLIC_URL</code>을 설정하세요.
    </p>

    <Teleport to="body">
      <div v-if="qrLarge && target" class="qr-overlay" @click="qrLarge = false">
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
.qr-wait {
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 12px;
  color: #5d6773;
  text-align: center;
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
