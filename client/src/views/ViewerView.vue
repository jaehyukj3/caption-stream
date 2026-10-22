<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { isValidRoomCode } from '@caption/shared';
import CaptionView from '../components/caption/CaptionView.vue';
import SurveyForm from '../components/viewer/SurveyForm.vue';
import ViewerToolbar from '../components/viewer/ViewerToolbar.vue';
import { createCaptionStore } from '../composables/useCaptionStore';
import { usePreferences } from '../composables/usePreferences';
import { useRoomSocket } from '../composables/useRoomSocket';
import { useWakeLock } from '../composables/useWakeLock';
import { downloadCaptions } from '../utils/download';
import { readJson, writeJson } from '../utils/storage';

const props = defineProps<{ code: string }>();

const validCode = isValidRoomCode(props.code);
// 중계 서버로 접속한 경우(QR 주소에 ?r=방ID#k=키): 키는 # 뒤라 서버로 전송되지 않는다
const relayRid = new URLSearchParams(location.search).get('r');
const relayKey = new URLSearchParams(location.hash.slice(1)).get('k');
const relay = relayRid && relayKey ? { rid: relayRid, key: relayKey } : undefined;
const store = createCaptionStore();
const { prefs, biggerFont, smallerFont, toggleTheme } = usePreferences(22);
const socket = validCode
  ? useRoomSocket({
      code: props.code,
      role: 'viewer',
      getSinceSeq: () => store.lastSeq.value,
      onMessage: store.apply,
      relay,
    })
  : null;
useWakeLock();

const banner = computed<{ kind: 'info' | 'error'; text: string } | null>(() => {
  if (!socket) return { kind: 'error', text: `올바르지 않은 방 코드입니다: ${props.code}` };
  if (socket.status.value === 'failed') return { kind: 'error', text: socket.error.value?.message ?? '방에 접속할 수 없습니다.' };
  if (store.state.ended) return { kind: 'info', text: '강의가 종료되었습니다. 자막 전체를 저장할 수 있습니다.' };
  if (socket.status.value === 'reconnecting') return { kind: 'info', text: '연결이 끊겨 다시 연결하는 중입니다…' };
  return null;
});

// 설문: 강사가 요청했을 때만 안내한다(종료만으로는 띄우지 않음). 요청이 오면 한 번 자동으로 연다.
const surveyOpen = ref(false);
const surveySending = ref(false);
const surveyOffered = computed(() => !!socket && socket.status.value !== 'failed' && store.state.surveyRequested);
watch(
  () => store.state.surveyRequested,
  (req) => req && !store.state.surveySubmitted && (surveyOpen.value = true),
);
const SURVEY_DONE_KEY = `caption.survey.${props.code}.done`;
store.state.surveySubmitted = readJson(localStorage, SURVEY_DONE_KEY, false);
watch(
  () => store.state.surveySubmitted,
  (done) => {
    surveySending.value = false;
    if (done) writeJson(localStorage, SURVEY_DONE_KEY, true);
  },
);
function submitSurvey(respondentId: string, answers: Record<string, number | string>) {
  surveySending.value = true;
  store.state.surveySubmitted = false;
  socket?.send({ type: 'survey', respondentId, answers });
}

const statusDot = computed(() => {
  const s = socket?.status.value;
  if (store.state.ended || s === 'failed' || !s) return 'is-off';
  return s === 'live' ? 'is-live' : 'is-wait';
});
</script>

<template>
  <div class="viewer">
    <header class="top">
      <div class="room">
        <span class="dot" :class="statusDot" />
        <span>방 {{ code }}</span>
        <span v-if="!store.state.ended && socket?.status.value === 'live'" class="muted count">· {{ store.state.viewerCount }}명 시청</span>
      </div>
      <ViewerToolbar
        :theme="prefs.theme"
        :can-download="store.state.lines.length > 0"
        @smaller="smallerFont"
        @bigger="biggerFont"
        @toggle-theme="toggleTheme"
        @download="downloadCaptions(store.state.lines, code)"
      />
    </header>

    <p v-if="banner" class="notice banner" :class="{ 'is-error': banner.kind === 'error' }" role="status">{{ banner.text }}</p>

    <button v-if="surveyOffered && !surveyOpen" type="button" class="survey-cta" :class="{ done: store.state.surveySubmitted }" @click="surveyOpen = true">
      {{ store.state.surveySubmitted ? '✓ 설문 응답 완료 (수정하기)' : '📝 2분 설문에 참여해 주세요 — 자막 개선에 쓰입니다' }}
    </button>

    <SurveyForm
      v-if="surveyOpen"
      :code="code"
      :submitted="store.state.surveySubmitted"
      :sending="surveySending"
      @submit="submitSurvey"
      @close="surveyOpen = false"
    />

    <main class="captions">
      <CaptionView :lines="store.state.lines" :interim="store.state.interim" :font-size="prefs.fontSize">
        <template #empty>
          {{
            socket?.status.value === 'live'
              ? '강사가 말을 시작하면 자막이 표시됩니다.'
              : relay
                ? '강사 노트북에 연결하는 중…'
                : '연결 중…'
          }}
        </template>
      </CaptionView>
    </main>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 모바일 주소창 높이 변화 대응 */
  height: 100dvh;
  max-width: 900px;
  margin: 0 auto;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}
.top {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.room {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 15px;
  white-space: nowrap;
  min-width: 0;
}
.count {
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
}
.banner {
  margin: 8px 12px 0;
}
.survey-cta {
  margin: 8px 12px 0;
  min-height: 48px;
  padding: 10px 14px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-text);
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
}
.survey-cta.done {
  background: var(--surface-2);
  color: var(--muted);
  font-weight: 600;
}
.captions {
  flex: 1;
  min-height: 0;
}
@media (max-width: 380px) {
  .count {
    display: none;
  }
}
</style>
