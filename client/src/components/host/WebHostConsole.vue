<script setup lang="ts">
/**
 * 웹 송출: 노트북 프로그램 없이 브라우저(PC·폰)에서 바로 송출한다.
 * 노트북 서버가 하던 일(방 관리·암호화·중계 연결)을 이 탭이 맡는다.
 * 음성인식은 브라우저 내장 기능(구글·애플 서버) 또는 이 기기 안 엔진(WebAssembly, 음성 외부 전송 없음).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { randomId, RelayBridge, Room, type RoomDirectory, type RoomStats, type ServerMessage, type ShareMessage } from '@caption/shared';
import { createCaptionStore } from '../../composables/useCaptionStore';
import { useDictionary } from '../../composables/useDictionary';
import { useSessionLog } from '../../composables/useSessionLog';
import { usePreferences } from '../../composables/usePreferences';
import { useWakeLock } from '../../composables/useWakeLock';
import { createSttProvider } from '../../stt';
import { OnDeviceSttProvider, type ModelPhase } from '../../stt/OnDeviceSttProvider';
import { downloadCaptions } from '../../utils/download';
import CaptionView from '../caption/CaptionView.vue';
import DictionaryEditor from './DictionaryEditor.vue';
import MicControls, { type MicState } from './MicControls.vue';
import SessionLogPanel from './SessionLogPanel.vue';
import SessionPanel from './SessionPanel.vue';

const props = withDefaults(defineProps<{ engine?: 'webspeech' | 'ondevice' }>(), { engine: 'webspeech' });
const emit = defineEmits<{ newSession: [] }>();

const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
const room = new Room(code, randomId(24));
const directory: RoomDirectory = { get: (c) => (c === code ? room : undefined), verifyHost: () => false };

const store = createCaptionStore();
const share = ref<ShareMessage | null>(null);
// 이 화면 자신도 방의 송출자로 붙어 확정 문장(번호 포함)과 접속자 수를 받는다
room.setShare('connecting', null);
room.addPeer(
  {
    send(data) {
      const msg = JSON.parse(data) as ServerMessage;
      if (msg.type === 'share') share.value = msg;
      store.apply(msg);
    },
  },
  'host',
);
// 참석자는 이 사이트의 중계 서버를 거쳐 접속한다 (내용은 이 탭에서 암호화)
const bridge = new RelayBridge(location.origin, room, directory);

const dict = useDictionary();
const { prefs, biggerFont, smallerFont } = usePreferences(26);
useWakeLock(); // 폰 화면이 꺼지면 마이크가 멈추므로 켜 둔다

const sttMessage = ref('');
const stt = createSttProvider(props.engine);
const micState = ref<MicState>('idle');

// 기기 안 인식: 화면을 열자마자 모델을 받아 두어(처음 한 번) 마이크 시작을 기다리지 않게 한다
const modelState = ref<'idle' | 'loading' | 'ready' | 'error'>(props.engine === 'ondevice' ? 'loading' : 'idle');
const modelProgress = ref(0);
const modelPhase = ref<ModelPhase>('download');
function prepareModel() {
  modelState.value = 'loading';
  OnDeviceSttProvider.prepare((phase, fraction) => {
    modelPhase.value = phase;
    modelProgress.value = fraction;
  }).then(
    () => (modelState.value = 'ready'),
    (e: Error) => {
      modelState.value = 'error';
      sttMessage.value = `음성인식 모델을 준비하지 못했습니다: ${e.message} (‘마이크 시작’을 누르면 다시 시도합니다)`;
    },
  );
}
if (props.engine === 'ondevice') prepareModel();

// 테스트 기록: 이 탭이 곧 방이라 통계를 바로 읽는다
const sessionLog = useSessionLog({ code, mode: 'web', engine: props.engine === 'ondevice' ? 'sensevoice-wasm' : 'webspeech' });
stt.onDiag?.(sessionLog.stt);
watch(micState, (s) => sessionLog.mic(s));
const stats = ref<RoomStats>(room.getStats());
const statsTimer = setInterval(() => (stats.value = room.getStats()), 5_000);
function saveLog() {
  stats.value = room.getStats();
  sessionLog.download(stats.value, store.state.lines);
}
const localInterim = ref('');

stt.onInterim((raw) => {
  const text = dict.apply(raw);
  localInterim.value = text;
  room.pushInterim(text); // 방이 참석자 전송을 초당 4회로 조절한다
  sttMessage.value = '';
});
stt.onFinal((raw) => {
  localInterim.value = '';
  room.pushFinal(dict.apply(raw));
});
// 음성인식이 방금 문장을 고쳐 다시 보내면 새 줄 대신 마지막 줄을 바꾼다
stt.onRevise?.((raw) => room.reviseLast(dict.apply(raw)));
stt.onError((err) => {
  sttMessage.value = err.message;
  if (err.fatal && micState.value !== 'ended') micState.value = 'paused';
});

async function start() {
  if (!stt.isSupported) {
    sttMessage.value = '이 브라우저는 음성인식을 지원하지 않습니다. 안드로이드·PC는 크롬, 아이폰은 사파리를 사용해 주세요.';
    return;
  }
  micState.value = 'starting';
  sttMessage.value = '';
  if (modelState.value === 'error') prepareModel(); // 실패했던 준비를 진행률 표시와 함께 다시
  try {
    await stt.start();
    modelState.value = props.engine === 'ondevice' ? 'ready' : 'idle';
    micState.value = 'running';
  } catch {
    micState.value = 'paused';
  }
}

async function pause() {
  micState.value = 'paused';
  await stt.stop();
  localInterim.value = '';
  room.pushInterim('');
}

async function end() {
  if (!window.confirm('세션을 종료할까요? 참석자 화면에 종료 안내가 표시됩니다.')) return;
  if (micState.value === 'running') await pause();
  room.end();
  micState.value = 'ended';
}

/** 브라우저 내장 음성인식은 마이크를 고를 수 없다 (기기 기본 마이크) */
const noDevice = ref('');
const connLabel = computed(
  () =>
    ({
      off: '중계 미사용',
      connecting: '중계 서버 연결 중…',
      online: '참석자 접속 가능',
      offline: '인터넷 끊김 — 다시 연결하는 중',
    })[share.value?.relay ?? 'connecting'],
);
watch(
  () => store.state.ended,
  (ended) => ended && (micState.value = 'ended'),
);

// 이 탭이 곧 송출 서버라서, 닫거나 새로고침하면 자막이 끝난다
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  if (!store.state.ended) e.preventDefault();
};
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  void stt.stop();
  clearInterval(statsTimer);
  bridge.dispose();
  room.dispose();
});
</script>

<template>
  <div class="console">
    <main class="stage card">
      <div class="stage-bar">
        <span class="conn">
          <span class="dot" :class="{ 'is-live': share?.relay === 'online', 'is-wait': !share || share.relay === 'connecting', 'is-off': share?.relay === 'offline' }" />
          {{ connLabel }}
        </span>
        <span class="viewers" title="현재 접속자 수">👥 {{ store.state.viewerCount }}명</span>
        <span class="spacer" />
        <button type="button" class="btn btn-icon" aria-label="글자 작게" @click="smallerFont">A−</button>
        <button type="button" class="btn btn-icon" aria-label="글자 크게" @click="biggerFont">A+</button>
      </div>
      <div class="stage-captions">
        <CaptionView :lines="store.state.lines" :interim="localInterim" :font-size="prefs.fontSize">
          <template #empty>‘마이크 시작’을 누르고 말씀하시면 자막이 여기에 표시됩니다.</template>
        </CaptionView>
      </div>
      <p v-if="sttMessage" class="notice" :class="{ 'is-error': micState !== 'running' }">{{ sttMessage }}</p>
    </main>

    <aside class="side">
      <p v-if="engine === 'ondevice'" class="notice web-note">
        <b>웹 송출 · 기기 안 인식</b> — 음성은 이 기기 안에서 글자로 바뀌고 밖으로 나가지 않습니다.
        이 화면을 닫거나 새로고침하면 자막이 끝납니다.
      </p>
      <p v-else class="notice web-note">
        <b>웹 송출</b> — 브라우저 내장 음성인식을 써서 음성이 구글·애플 서버로 전송됩니다.
        이 화면을 닫거나 새로고침하면 자막이 끝납니다. 음성이 밖으로 나가면 안 되는 강의는 노트북 프로그램(음성 외부 전송 없음)을 쓰세요.
      </p>
      <p v-if="modelState === 'loading' && modelPhase === 'download'" class="notice model">
        음성인식 모델 받는 중… {{ Math.round(modelProgress * 100) }}%
        <small>처음 한 번만 약 240MB를 받고, 다음부터는 이 기기에 보관된 것을 씁니다.</small>
      </p>
      <p v-else-if="modelState === 'loading'" class="notice model">
        음성인식 모델 불러오는 중…
        <small>폰에서는 30초~1분쯤 걸릴 수 있습니다. 화면을 켜 둔 채 기다려 주세요.</small>
      </p>

      <MicControls v-model:device-id="noDevice" :state="micState" :level="0" :devices="[]" simple @start="start" @pause="pause" @end="end" />

      <div v-if="micState === 'ended'" class="card ended">
        <strong>세션이 종료되었습니다.</strong>
        <p class="muted">이 화면을 열어 두는 동안 참석자는 자막을 계속 보고 저장할 수 있습니다.</p>
        <button type="button" class="btn btn-primary" @click="emit('newSession')">새 세션 만들기</button>
      </div>

      <SessionPanel :code="code" :share="share" :lan="false" />

      <div class="tools">
        <button type="button" class="btn" :disabled="!store.state.lines.length" @click="downloadCaptions(store.state.lines, code)">⤓ 자막 저장(.txt)</button>
      </div>

      <SessionLogPanel :log="sessionLog" :stats="stats" @save="saveLog" />

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
.model small {
  display: block;
  margin-top: 2px;
  color: var(--muted);
}
.side > .notice.model {
  margin: 0;
}
.web-note {
  margin: 0;
  line-height: 1.5;
}
.tools {
  display: flex;
  gap: 8px;
}
.tools > .btn {
  flex: 1;
}
.ended {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-color: var(--accent);
}
.ended p {
  margin: 0;
  font-size: 14px;
}
.side > .notice {
  margin: 0;
}
@media (max-width: 900px) {
  .console {
    grid-template-columns: 1fr;
    height: auto;
  }
  .stage {
    height: 45vh;
  }
  .side {
    overflow: visible;
  }
}
</style>
