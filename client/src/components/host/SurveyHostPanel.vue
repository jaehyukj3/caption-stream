<script setup lang="ts">
/** 송출 화면의 설문 패널: 참석자에게 요청 보내기, 실시간 집계, CSV 저장 */
import { computed, ref } from 'vue';
import { SURVEY_QUESTIONS, susScore, type SurveyResponse } from '@caption/shared';
import { downloadSurvey } from '../../utils/download';

const props = defineProps<{ code: string; responses: SurveyResponse[]; ended: boolean; viewerCount: number }>();
const emit = defineEmits<{ request: []; saved: [] }>();

const requested = ref(false);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const experience = computed(() =>
  SURVEY_QUESTIONS.filter((q) => q.kind === 'likert' && q.group === 'experience').map((q) => ({
    text: q.text,
    mean: avg(props.responses.map((r) => r.answers[q.id]).filter((v): v is number => typeof v === 'number')),
  })),
);
const sus = computed(() => avg(props.responses.map((r) => susScore(r.answers)).filter((v): v is number => v !== null)));
/** SUS 68점이 업계 평균, 80.3점 이상이 상위 10% (Sauro, 2011) */
const susGrade = computed(() => (sus.value === null ? '' : sus.value >= 80.3 ? '우수' : sus.value >= 68 ? '평균 이상' : sus.value >= 51 ? '개선 필요' : '미흡'));
const comments = computed(() =>
  props.responses
    .filter((r) => typeof r.answers.comment === 'string' && r.answers.comment)
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .slice(0, 5)
    .map((r) => String(r.answers.comment)),
);

function request() {
  requested.value = true;
  emit('request');
}

function save() {
  downloadSurvey(props.responses, props.code);
  emit('saved');
}
</script>

<template>
  <section class="card survey">
    <h2>설문</h2>
    <p class="muted hint">
      아래 버튼을 누르면 참석자 휴대폰 자막 화면에 설문이 뜹니다. 누르지 않으면 설문은 나오지 않습니다(강의 종료 전후 모두 가능).
    </p>
    <button type="button" class="btn" @click="request">
      {{ requested ? '설문 요청 다시 보내기' : '참석자에게 설문 요청' }}
    </button>

    <div class="stats">
      <div class="stat">
        <span class="num">{{ responses.length }}</span>
        <span class="muted">응답{{ viewerCount ? ` / 접속 ${viewerCount}명` : '' }}</span>
      </div>
      <div class="stat">
        <span class="num">{{ sus === null ? '–' : sus.toFixed(1) }}</span>
        <span class="muted">SUS 평균{{ susGrade ? ` · ${susGrade}` : '' }}</span>
      </div>
    </div>

    <ul v-if="responses.length" class="bars">
      <li v-for="e in experience" :key="e.text">
        <span class="label">{{ e.text }}</span>
        <span class="bar"><span :style="{ width: `${((e.mean ?? 0) / 5) * 100}%` }" /></span>
        <span class="val">{{ e.mean?.toFixed(1) ?? '–' }}</span>
      </li>
    </ul>

    <div v-if="comments.length" class="comments">
      <strong>최근 의견</strong>
      <p v-for="(c, i) in comments" :key="i">“{{ c }}”</p>
    </div>

    <button type="button" class="btn" :disabled="!responses.length" @click="save">⤓ 설문 결과 저장(.csv, 엑셀)</button>
  </section>
</template>

<style scoped>
.survey {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.survey h2 {
  margin: 0;
}
.hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.stat {
  display: flex;
  flex-direction: column;
  padding: 10px;
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 12px;
}
.stat .num {
  font-size: 24px;
  font-weight: 800;
}
.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}
.bars li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px;
  gap: 2px 8px;
}
.label {
  grid-column: 1 / -1;
  color: var(--muted);
}
.bar {
  height: 8px;
  align-self: center;
  border-radius: 4px;
  background: var(--surface-2);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.val {
  text-align: right;
  font-weight: 700;
}
.comments {
  font-size: 13px;
}
.comments p {
  margin: 4px 0 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
