<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { CreateRoomResponse, SttStatusResponse } from '@caption/shared';
import HostConsole from '../components/host/HostConsole.vue';
import WebHostConsole from '../components/host/WebHostConsole.vue';
import { usePreferences } from '../composables/usePreferences';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { createSttProvider, sttKindFromUrl } from '../stt';
import { nativeApp } from '../stt/NativeSttProvider';
import { readJson, writeJson } from '../utils/storage';

/** 탭을 새로고침해도 같은 방을 이어서 송출할 수 있도록 탭 단위로 보관 */
const KEY = 'caption.host';

const { prefs, toggleTheme } = usePreferences(26);
const update = useUpdateCheck();
const session = ref<CreateRoomResponse | null>(null);
const checking = ref(true);
const creating = ref(false);
const error = ref('');
/**
 * 송출 방식
 *  - laptop: 노트북 프로그램(START.bat)이 띄운 화면. 노트북 안에서 음성인식(음성 외부 전송 없음)
 *  - web:    노트북 프로그램 없이 웹 주소로 접속. 브라우저 내장 음성인식
 */
const mode = ref<'laptop' | 'web' | null>(null);
const webSession = ref(0);
const sttKind = sttKindFromUrl();
/** 웹 송출 음성인식: 브라우저 내장(구글·애플) 또는 이 기기 안(모델을 받아 직접 인식) */
const WEB_ENGINE_KEY = 'caption.webEngine';
const webEngine = ref<'webspeech' | 'ondevice' | 'native'>(nativeApp ? 'native' : readJson(localStorage, WEB_ENGINE_KEY, 'webspeech'));
// 안드로이드 앱 안에서는 항상 앱 인식 (브라우저 방식 선택은 브라우저에서만 기억)
watch(webEngine, (v) => !nativeApp && writeJson(localStorage, WEB_ENGINE_KEY, v));
/** 안드로이드 브라우저로 연 경우 앱 받기 안내 */
const offerApp = !nativeApp && /Android/i.test(navigator.userAgent);
const sttSupported = computed(() => createSttProvider(mode.value === 'web' ? webEngine.value : sttKind).isSupported);
const secure = window.isSecureContext;
/** 로컬 음성인식은 이 노트북에서 localhost로 연 화면에서만 동작한다 */
const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const sttStatus = ref<SttStatusResponse | null>(null);

/** 노트북 프로그램이 있으면 /api/health가 JSON으로 답한다 (중계 사이트는 화면 파일만 준다) */
async function detectMode(): Promise<'laptop' | 'web'> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok && res.headers.get('content-type')?.includes('json') ? 'laptop' : 'web';
  } catch {
    return 'web';
  }
}

onMounted(async () => {
  mode.value = await detectMode();
  if (mode.value === 'web') {
    checking.value = false;
    return;
  }
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
  if (mode.value === 'web') {
    webSession.value++;
    return;
  }
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
  webSession.value = 0;
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
    <p v-if="update.outdated.value && update.download.value" class="notice update" role="status">
      노트북 프로그램 새 버전({{ update.latest.value }})이 있습니다. 받은 zip을 풀어 지금 폴더 대신 쓰세요.
      <a class="btn btn-primary" :href="update.download.value" target="_blank" rel="noopener">새 버전 받기</a>
    </p>
    <p v-else-if="update.outdated.value" class="notice is-error update" role="alert">
      새 버전({{ update.latest.value }})이 있습니다. 지금 화면은 예전 버전입니다.
      <button type="button" class="btn btn-primary" @click="update.reload">새로고침</button>
    </p>

    <HostConsole
      v-if="session"
      :key="session.code"
      :code="session.code"
      :host-token="session.hostToken"
      class="body"
      @new-session="resetSession"
      @invalid="onInvalid"
    />

    <WebHostConsole v-else-if="mode === 'web' && webSession" :key="webSession" :engine="webEngine" class="body" @new-session="resetSession" />

    <main v-else-if="!checking && mode === 'web'" class="start">
      <div class="card start-card">
        <h1>웹 송출</h1>
        <p class="muted">프로그램 설치 없이 이 브라우저(PC·휴대폰)에서 송출합니다. 참석자는 QR을 찍어 자막을 봅니다.</p>
        <p v-if="nativeApp" class="notice">
          <b>폰 안 인식</b> — 음성은 이 휴대폰 안에서 글자로 바뀌고 밖으로 나가지 않습니다.
          처음 한 번 모델 약 240MB를 받습니다(와이파이 권장).
        </p>
        <fieldset v-else class="engines">
          <legend>음성인식 방식</legend>
          <p class="engine-note">음성 데이터는 말하는 목소리를 뜻합니다. 자막 글자는 어느 방식이든 암호화되어 전달됩니다.</p>
          <label class="engine" :class="{ on: webEngine === 'webspeech' }">
            <input v-model="webEngine" type="radio" value="webspeech" />
            <span>
              <b>브라우저 음성인식</b>
              <small>자막: 구글·애플 서버가 만듦<br />음성 데이터: <b>외부로 나감</b></small>
              <small>공개 강의처럼 내용이 나가도 될 때. 가장 정확하고 바로 시작됩니다.</small>
            </span>
          </label>
          <label class="engine" :class="{ on: webEngine === 'ondevice' }">
            <input v-model="webEngine" type="radio" value="ondevice" />
            <span>
              <b>이 기기 안에서 인식 (베타)</b>
              <small>자막: 이 기기의 로컬 모델이 만듦<br />음성 데이터: <b>외부로 안 나감</b></small>
              <small>내부 교육처럼 내용이 나가면 안 될 때. 정확도는 조금 낮고, 처음 한 번 약 240MB를 받습니다(와이파이 권장).</small>
            </span>
          </label>
        </fieldset>
        <p v-if="nativeApp" class="notice">앱을 닫으면 자막이 멈춥니다. 송출하는 동안 화면은 켜진 채로 유지됩니다.</p>
        <p v-else class="notice">이 화면을 닫거나 휴대폰 화면이 꺼지면 자막이 멈춥니다.</p>
        <p v-if="!sttSupported" class="notice is-error">이 브라우저는 이 음성인식 방식을 지원하지 않습니다. 안드로이드·PC는 크롬, 아이폰은 사파리를 사용해 주세요.</p>
        <button type="button" class="btn btn-primary big" :disabled="!sttSupported" @click="createSession">세션 만들기</button>
        <a v-if="offerApp" class="download" href="/download/android">안드로이드 앱 받기 — 폰 안에서 더 빠르고 정확하게 인식합니다 (음성 외부 전송 없음)</a>
        <a v-if="!nativeApp" class="download" href="/download">기관용 노트북 프로그램 받기 (Windows · 약 200MB) — 음성이 외부로 나가지 않습니다</a>
      </div>
    </main>

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
.update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 12px;
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
.engines {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
.engines legend {
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--muted);
}
.engine {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
}
.engine.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.engine input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.engine span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.engine small {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
}
.engine small b {
  color: var(--text);
}
.engine-note {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--muted);
}
.download {
  margin-top: 4px;
  font-size: 14px;
  color: var(--muted);
  text-align: center;
}
.big {
  min-height: 52px;
  font-size: 18px;
  margin-top: 8px;
}
</style>
