<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, toRef, watch } from 'vue';
import { INTERIM_MIN_INTERVAL_MS, type RoomStats, type ShareMessage } from '@caption/shared';
import { createCaptionStore } from '../../composables/useCaptionStore';
import { useDictionary } from '../../composables/useDictionary';
import { useMicLevel } from '../../composables/useMicLevel';
import { usePreferences } from '../../composables/usePreferences';
import { useRoomSocket } from '../../composables/useRoomSocket';
import { useSessionLog } from '../../composables/useSessionLog';
import { createSttProvider, sttKindFromUrl } from '../../stt';
import { micErrorMessage } from '../../stt/micCapture';
import { downloadCaptions } from '../../utils/download';
import { throttle } from '../../utils/throttle';
import CaptionView from '../caption/CaptionView.vue';
import DictionaryEditor from './DictionaryEditor.vue';
import FloatingCaptionButton from './FloatingCaptionButton.vue';
import MicControls, { type MicDevice, type MicState } from './MicControls.vue';
import { readJson, writeJson } from '../../utils/storage';
import SessionLogPanel from './SessionLogPanel.vue';
import SessionPanel from './SessionPanel.vue';

const props = defineProps<{ code: string; hostToken: string }>();
const emit = defineEmits<{ newSession: []; invalid: [] }>();

const store = createCaptionStore();
/** 중계 서버 상태와 LTE 참석자용 주소 (서버가 송출자에게만 알려 줌) */
const share = ref<ShareMessage | null>(null);
/** 방 이용 통계 (테스트 기록). 서버에 주기적으로 물어본다. */
const stats = ref<RoomStats | null>(null);
let saveWhenStats = false;
const socket = useRoomSocket({
  code: props.code,
  role: 'host',
  hostToken: props.hostToken,
  getSinceSeq: () => store.lastSeq.value,
  onMessage: (msg) => {
    if (msg.type === 'share') share.value = msg;
    if (msg.type === 'stats') {
      stats.value = msg.stats;
      if (saveWhenStats) saveLog();
    }
    store.apply(msg);
  },
});
const dict = useDictionary();
const { prefs, biggerFont, smallerFont } = usePreferences(26);
const mic = useMicLevel();

// STT 엔진 교체 지점: 기본은 노트북 안의 로컬 엔진 (stt/index.ts)
const stt = createSttProvider();
const sessionLog = useSessionLog({ code: props.code, mode: 'laptop', engine: sttKindFromUrl() === 'local' ? 'sensevoice' : 'webspeech' });
stt.onDiag?.(sessionLog.stt);

const micState = ref<MicState>('idle');
watch(micState, (s) => sessionLog.mic(s));

const statsTimer = setInterval(() => socket.status.value === 'live' && socket.send({ type: 'statsRequest' }), 15_000);
watch(socket.status, (s) => s === 'live' && socket.send({ type: 'statsRequest' }));

/** 최신 통계를 받아서 저장 (연결이 끊겨 있으면 마지막으로 받은 통계로) */
function requestSaveLog() {
  if (socket.status.value !== 'live') return saveLog();
  saveWhenStats = true;
  socket.send({ type: 'statsRequest' });
}
function saveLog() {
  saveWhenStats = false;
  sessionLog.download(stats.value, store.state.lines);
}

// 마이크 선택 (USB 오디오 어댑터로 앰프 출력을 받는 경우 등). 기기별로 기억한다.
const MIC_KEY = 'caption.micDeviceId';
const micDeviceId = ref<string>(readJson(localStorage, MIC_KEY, ''));
const micDevices = ref<MicDevice[]>([]);
watch(micDeviceId, (v) => writeJson(localStorage, MIC_KEY, v));

async function refreshDevices() {
  const all = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
  // Windows 크롬의 'default'/'communications'는 실제 장치의 별칭이라 뺀다
  micDevices.value = all
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `마이크 ${i + 1}` }));
  // 뽑혀 있는 장치를 기억하고 있으면 기본 마이크로 되돌린다
  if (micDeviceId.value && micDevices.value.length && !micDevices.value.some((d) => d.deviceId === micDeviceId.value)) {
    micDeviceId.value = '';
  }
}
const sttMessage = ref('');
/** 송출자 화면의 중간 결과는 로컬 STT 결과를 바로 보여준다(서버 왕복 없음) */
const localInterim = ref('');

const sendInterim = throttle((text: string) => socket.send({ type: 'interim', text }), INTERIM_MIN_INTERVAL_MS);

stt.onInterim((raw) => {
  const text = dict.apply(raw);
  localInterim.value = text;
  sendInterim(text);
  sttMessage.value = '';
});

stt.onFinal((raw) => {
  sendInterim.cancel();
  localInterim.value = '';
  // 확정 문장은 용어 사전 치환 후 송출. 화면에는 서버가 seq를 붙여 돌려준 것을 표시한다.
  socket.send({ type: 'final', text: dict.apply(raw) });
});

// 음성인식이 방금 문장을 고쳐 다시 보내면 새 줄 대신 마지막 줄을 바꾼다
stt.onRevise?.((raw) => socket.send({ type: 'revise', text: dict.apply(raw) }));

stt.onError((err) => {
  sttMessage.value = err.message;
  if (err.fatal) {
    mic.stop();
    if (micState.value !== 'ended') micState.value = 'paused';
  }
});

async function start() {
  if (!stt.isSupported) {
    sttMessage.value = '이 브라우저는 마이크 음성 처리를 지원하지 않습니다. 크롬 또는 엣지를 사용해 주세요.';
    return;
  }
  micState.value = 'starting';
  sttMessage.value = '';
  try {
    await mic.start(micDeviceId.value);
    stt.setDeviceId?.(micDeviceId.value);
    await stt.start();
    micState.value = 'running';
    void refreshDevices(); // 권한을 받은 뒤에야 장치 이름이 보인다
  } catch (e) {
    mic.stop();
    await stt.stop();
    micState.value = 'paused';
    sttMessage.value ||= micErrorMessage(e);
  }
}

async function pause() {
  mic.stop();
  micState.value = 'paused';
  await stt.stop(); // 말하던 문장까지 확정(onFinal)된 뒤 끝난다
  sendInterim.cancel();
  localInterim.value = '';
  socket.send({ type: 'interim', text: '' });
}

async function end() {
  if (!window.confirm('세션을 종료할까요? 수신자 화면에 종료 안내가 표시되고 더 이상 자막을 보낼 수 없습니다.')) return;
  if (micState.value === 'running') await pause();
  socket.send({ type: 'end' });
  micState.value = 'ended';
}

// 다른 탭에서 종료했거나 이미 끝난 방으로 재접속한 경우
watch(
  () => store.state.ended,
  (ended) => {
    if (!ended) return;
    if (micState.value === 'running' || micState.value === 'starting') void pause();
    micState.value = 'ended';
  },
);
watch(socket.status, (s) => {
  if (s === 'failed') emit('invalid');
});

/** PiP 창과 공유하는 반응형 소스 */
const pipSource = reactive({ lines: toRef(store.state, 'lines'), interim: localInterim });

const connLabel = computed(
  () =>
    ({
      connecting: '연결 중…',
      live: '서버 연결됨',
      reconnecting: '재연결 중… (문장은 보관 후 전송)',
      failed: socket.error.value?.message ?? '연결 실패',
      closed: '연결 종료',
    })[socket.status.value],
);

// 송출 중 실수로 탭을 닫지 않도록
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  if (micState.value === 'running') e.preventDefault();
};
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload);
  navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
  void refreshDevices();
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  void stt.stop();
  clearInterval(statsTimer);
});
</script>

<template>
  <div class="console">
    <main class="stage card">
      <div class="stage-bar">
        <span class="conn">
          <span class="dot" :class="{ 'is-live': socket.status.value === 'live', 'is-wait': socket.status.value === 'connecting' || socket.status.value === 'reconnecting', 'is-off': socket.status.value === 'failed' }" />
          {{ connLabel }}
        </span>
        <span class="viewers" title="현재 접속자 수">👥 {{ store.state.viewerCount }}명</span>
        <span class="spacer" />
        <button type="button" class="btn btn-icon" aria-label="글자 작게" @click="smallerFont">A−</button>
        <button type="button" class="btn btn-icon" aria-label="글자 크게" @click="biggerFont">A+</button>
      </div>
      <div class="stage-captions">
        <CaptionView
          :lines="store.state.lines"
          :pending-lines="socket.pendingFinals.value"
          :interim="localInterim"
          :font-size="prefs.fontSize"
        >
          <template #empty>‘마이크 시작’을 누르고 말씀하시면 자막이 여기에 표시됩니다.</template>
        </CaptionView>
      </div>
      <p v-if="sttMessage" class="notice" :class="{ 'is-error': micState !== 'running' }">{{ sttMessage }}</p>
    </main>

    <aside class="side">
      <MicControls
        v-model:device-id="micDeviceId"
        :state="micState"
        :level="mic.level.value"
        :devices="micDevices"
        @start="start"
        @pause="pause"
        @end="end"
      />

      <div v-if="micState === 'ended'" class="card ended">
        <strong>세션이 종료되었습니다.</strong>
        <p class="muted">수신자는 2시간 동안 자막 이력을 계속 보고 다운로드할 수 있습니다.</p>
        <button type="button" class="btn btn-primary" @click="emit('newSession')">새 세션 만들기</button>
      </div>

      <SessionPanel :code="code" :share="share" />

      <div class="tools">
        <FloatingCaptionButton :source="pipSource" :font-size="prefs.fontSize" />
        <button type="button" class="btn" :disabled="!store.state.lines.length" @click="downloadCaptions(store.state.lines, code)">⤓ 자막 저장(.txt)</button>
      </div>

      <SessionLogPanel :log="sessionLog" :stats="stats" @save="requestSaveLog" />

      <DictionaryEditor :entries="dict.entries.value" @add="dict.add" @remove="dict.remove" />
    </aside>
  </div>
</template>

<style scoped>
.console {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 16px;
  height: 100%;
  min-height: 0;
}
.stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}
.stage-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.conn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.viewers {
  font-weight: 700;
}
.spacer {
  flex: 1;
}
.stage-captions {
  flex: 1;
  min-height: 0;
  padding: 8px 8px 0;
}
.stage > .notice {
  margin: 0 12px 12px;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 8px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tools > .btn {
  flex: 1;
}
.ended {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-color: var(--accent);
}
.ended p {
  margin: 0 0 8px;
  font-size: 14px;
}
@media (max-width: 900px) {
  .console {
    grid-template-columns: 1fr;
    height: auto;
  }
  .stage {
    height: 60vh;
  }
  .side {
    overflow: visible;
  }
}
</style>
