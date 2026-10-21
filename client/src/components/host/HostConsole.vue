<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, toRef, watch } from 'vue';
import { INTERIM_MIN_INTERVAL_MS } from '@caption/shared';
import { createCaptionStore } from '../../composables/useCaptionStore';
import { useDictionary } from '../../composables/useDictionary';
import { useMicLevel } from '../../composables/useMicLevel';
import { usePreferences } from '../../composables/usePreferences';
import { useRoomSocket } from '../../composables/useRoomSocket';
import { createSttProvider } from '../../stt';
import { downloadCaptions } from '../../utils/download';
import { throttle } from '../../utils/throttle';
import CaptionView from '../caption/CaptionView.vue';
import DictionaryEditor from './DictionaryEditor.vue';
import FloatingCaptionButton from './FloatingCaptionButton.vue';
import MicControls, { type MicState } from './MicControls.vue';
import SessionPanel from './SessionPanel.vue';

const props = defineProps<{ code: string; hostToken: string }>();
const emit = defineEmits<{ newSession: []; invalid: [] }>();

const store = createCaptionStore();
const socket = useRoomSocket({
  code: props.code,
  role: 'host',
  hostToken: props.hostToken,
  getSinceSeq: () => store.lastSeq.value,
  onMessage: store.apply,
});
const dict = useDictionary();
const { prefs, biggerFont, smallerFont } = usePreferences(26);
const mic = useMicLevel();

// STT 엔진 교체 지점: 기본은 노트북 안의 로컬 엔진 (stt/index.ts)
const stt = createSttProvider();

const micState = ref<MicState>('idle');
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
    await mic.start();
    await stt.start();
    micState.value = 'running';
  } catch (e) {
    mic.stop();
    await stt.stop();
    micState.value = 'paused';
    const name = (e as DOMException).name;
    sttMessage.value ||=
      name === 'NotAllowedError'
        ? '마이크 권한이 거부되었습니다. 주소창 왼쪽의 아이콘에서 마이크를 허용해 주세요.'
        : name === 'NotFoundError'
          ? '마이크를 찾을 수 없습니다.'
          : `마이크를 시작하지 못했습니다: ${(e as Error).message}`;
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
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  void stt.stop();
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
      <MicControls :state="micState" :level="mic.level.value" @start="start" @pause="pause" @end="end" />

      <div v-if="micState === 'ended'" class="card ended">
        <strong>세션이 종료되었습니다.</strong>
        <p class="muted">수신자는 2시간 동안 자막 이력을 계속 보고 다운로드할 수 있습니다.</p>
        <button type="button" class="btn btn-primary" @click="emit('newSession')">새 세션 만들기</button>
      </div>

      <SessionPanel :code="code" />

      <div class="tools">
        <FloatingCaptionButton :source="pipSource" :font-size="prefs.fontSize" />
        <button type="button" class="btn" :disabled="!store.state.lines.length" @click="downloadCaptions(store.state.lines, code)">⤓ 자막 저장(.txt)</button>
      </div>

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
