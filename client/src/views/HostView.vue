<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { CreateRoomResponse, SttStatusResponse } from '@caption/shared';
import HostConsole from '../components/host/HostConsole.vue';
import { usePreferences } from '../composables/usePreferences';
import { createSttProvider, sttKindFromUrl } from '../stt';
import { readJson, writeJson } from '../utils/storage';

/** 탭을 새로고침해도 같은 방을 이어서 송출할 수 있도록 탭 단위로 보관 */
const KEY = 'caption.host';

const { prefs, toggleTheme } = usePreferences(26);
const session = ref<CreateRoomResponse | null>(null);
const checking = ref(true);
const creating = ref(false);
const error = ref('');
const sttKind = sttKindFromUrl();
const sttSupported = createSttProvider(sttKind).isSupported;
const secure = window.isSecureContext;
/** 로컬 음성인식은 이 노트북에서 localhost로 연 화면에서만 동작한다 */
const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const sttStatus = ref<SttStatusResponse | null>(null);

onMounted(async () => {
  if (sttKind === 'local') {
    sttStatus.value = await fetch('/api/stt-status')
      .then((r) => r.json() as Promise<SttStatusResponse>)
      .catch(() => null);
  }
  const saved = readJson<CreateRoomResponse | null>(sessionStorage, KEY, null);
  if (saved) {
    // 서버 재시작 등으로 방이 사라졌으면 버린다
    const res = await fetch(`/api/rooms/${saved.code}`).catch(() => null);
    if (res?.ok) session.value = saved;
    else writeJson(sessionStorage, KEY, null);
  }
  checking.value = false;
});

async function createSession() {
  creating.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(res.status === 503 ? '서버의 방 개수가 한도에 도달했습니다.' : `HTTP ${res.status}`);
    const data = (await res.json()) as CreateRoomResponse;
    writeJson(sessionStorage, KEY, data);
    session.value = data;
  } catch (e) {
    error.value = `세션을 만들지 못했습니다. 서버가 실행 중인지 확인해 주세요. (${(e as Error).message})`;
  } finally {
    creating.value = false;
  }
}

function resetSession() {
  writeJson(sessionStorage, KEY, null);
  session.value = null;
}

function onInvalid() {
  resetSession();
  error.value = '이전 세션이 만료되었거나 송출 권한이 없습니다. 새 세션을 만들어 주세요.';
}
</script>

<template>
  <div class="host">
    <header class="top">
      <RouterLink to="/" class="brand">실시간 자막 · 송출</RouterLink>
      <button type="button" class="btn btn-icon" :aria-label="prefs.theme === 'dark' ? '라이트 모드' : '다크 모드'" @click="toggleTheme">
        {{ prefs.theme === 'dark' ? '☀' : '☾' }}
      </button>
    </header>

    <HostConsole
      v-if="session"
      :key="session.code"
      :code="session.code"
      :host-token="session.hostToken"
      class="body"
      @new-session="resetSession"
      @invalid="onInvalid"
    />

    <main v-else-if="!checking" class="start">
      <div class="card start-card">
        <h1>강의 자막 송출 시작</h1>
        <p class="muted">세션을 만들면 6자리 방 코드와 QR 코드가 생성됩니다. 참석자는 휴대폰으로 QR을 찍어 설치 없이 자막을 볼 수 있습니다.</p>
        <p v-if="!sttSupported" class="notice is-error">이 브라우저에서는 음성인식을 쓸 수 없습니다. 크롬 또는 엣지를 사용해 주세요.</p>
        <p v-else-if="sttKind === 'local' && !isLocalhost" class="notice is-error">
          송출은 강사 노트북에서 <code>http://localhost:3001/host</code> 로 열어야 합니다. (음성은 노트북 밖으로 나가지 않도록 다른 주소에서는 막혀 있습니다)
        </p>
        <p v-else-if="!secure" class="notice is-error">
          마이크는 HTTPS 또는 <code>http://localhost</code>에서만 동작합니다. 송출 노트북에서 localhost로 열어 주세요.
        </p>
        <p v-else-if="sttStatus && !sttStatus.available" class="notice is-error">{{ sttStatus.message }}</p>
        <p v-if="sttKind === 'webspeech'" class="notice">개발용 모드: 크롬 음성인식(Google 서버)을 사용합니다. 음성이 외부로 전송됩니다.</p>
        <p v-if="error" class="notice is-error">{{ error }}</p>
        <button type="button" class="btn btn-primary big" :disabled="creating" @click="createSession">
          {{ creating ? '만드는 중…' : '세션 만들기' }}
        </button>
      </div>
    </main>
  </div>
</template>

<style scoped>
.host {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0 16px 16px;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
}
.brand {
  font-weight: 800;
  color: var(--text);
  text-decoration: none;
}
.body {
  flex: 1;
  min-height: 0;
}
.start {
  flex: 1;
  display: grid;
  place-items: center;
}
.start-card {
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px;
}
.start-card h1 {
  margin: 0;
  font-size: 24px;
}
.start-card p {
  margin: 0;
}
.big {
  min-height: 52px;
  font-size: 18px;
  margin-top: 8px;
}
</style>
