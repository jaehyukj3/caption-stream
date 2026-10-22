<script setup lang="ts">
/**
 * 참석자 설문. 응답은 자막과 같은 연결(중계 시 암호화)로 강사 화면에만 전달된다.
 * 작성 중인 내용은 이 휴대폰에만 임시 저장해 새로고침해도 이어서 쓸 수 있다.
 */
import { computed, reactive, ref, watch } from 'vue';
import { LIKERT_LABELS, randomId, SURVEY_QUESTIONS, SURVEY_REQUIRED, type SurveyQuestion } from '@caption/shared';
import { readJson, writeJson } from '../../utils/storage';

const props = defineProps<{ code: string; submitted: boolean; sending: boolean }>();
const emit = defineEmits<{ submit: [respondentId: string, answers: Record<string, number | string>]; close: [] }>();

const DRAFT_KEY = `caption.survey.${props.code}`;
const ID_KEY = 'caption.respondentId';

let respondentId = readJson<string>(localStorage, ID_KEY, '');
if (!/^[\w-]{8,64}$/.test(respondentId)) {
  respondentId = randomId(12);
  writeJson(localStorage, ID_KEY, respondentId);
}

const draft = readJson<{ consent: boolean; answers: Record<string, number | string> }>(localStorage, DRAFT_KEY, { consent: false, answers: {} });
const consent = ref(draft.consent);
const answers = reactive<Record<string, number | string>>({ ...draft.answers });
watch([consent, answers], () => writeJson(localStorage, DRAFT_KEY, { consent: consent.value, answers }), { deep: true });

const groups: { title: string; note?: string; questions: SurveyQuestion[] }[] = [
  { title: '자막 경험', questions: SURVEY_QUESTIONS.filter((q) => q.kind === 'likert' && q.group === 'experience') },
  { title: '사용 편의성', note: '"이 서비스" = 휴대폰으로 보는 실시간 자막', questions: SURVEY_QUESTIONS.filter((q) => q.kind === 'likert' && q.group === 'sus') },
  { title: '참고 정보 (선택)', questions: SURVEY_QUESTIONS.filter((q) => q.kind !== 'likert') },
];

const answeredCount = computed(() => SURVEY_REQUIRED.filter((id) => typeof answers[id] === 'number').length);
const missing = ref(false);

function submit() {
  if (!consent.value) return;
  if (answeredCount.value < SURVEY_REQUIRED.length) {
    missing.value = true;
    const first = SURVEY_REQUIRED.find((id) => typeof answers[id] !== 'number');
    document.getElementById(`q-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  missing.value = false;
  const clean: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(answers)) if (v !== '' && v !== undefined) clean[k] = typeof v === 'string' ? v.trim() : v;
  emit('submit', respondentId, clean);
}
</script>

<template>
  <div class="survey" role="dialog" aria-modal="true" aria-labelledby="survey-title">
    <header class="survey-top">
      <h2 id="survey-title">강의 자막 설문</h2>
      <button type="button" class="btn" @click="emit('close')">{{ submitted ? '닫기' : '나중에' }}</button>
    </header>

    <div v-if="submitted" class="done">
      <p class="big">응답해 주셔서 감사합니다.</p>
      <p class="muted">고치고 싶으면 아래에서 수정 후 다시 보내면 마지막 응답으로 바뀝니다.</p>
    </div>

    <section class="card consent">
      <p>
        자막 서비스 개선과 효과 분석을 위한 <b>익명 설문</b>입니다(약 2분). 이름·연락처는 묻지 않으며, 응답은 강사 화면으로만 전달되고
        서버에 저장되지 않습니다. 원하지 않으면 언제든 그만두실 수 있습니다.
      </p>
      <label class="check">
        <input v-model="consent" type="checkbox" />
        <span>위 내용을 이해했으며 참여에 동의합니다.</span>
      </label>
    </section>

    <fieldset :disabled="!consent" class="groups">
      <section v-for="g in groups" :key="g.title" class="card group">
        <h3>{{ g.title }}</h3>
        <p v-if="g.note" class="muted note">{{ g.note }}</p>

        <div v-for="(q, i) in g.questions" :id="`q-${q.id}`" :key="q.id" class="q" :class="{ 'is-missing': missing && q.kind === 'likert' && typeof answers[q.id] !== 'number' }">
          <p class="q-text">
            <span v-if="q.kind === 'likert'" class="q-num">{{ i + 1 }}.</span>
            {{ q.text }}
          </p>

          <div v-if="q.kind === 'likert'" class="likert" role="radiogroup" :aria-label="q.text">
            <label v-for="(label, idx) in LIKERT_LABELS" :key="idx" class="opt" :class="{ on: answers[q.id] === idx + 1 }">
              <input v-model="answers[q.id]" type="radio" :name="q.id" :value="idx + 1" />
              <span class="n">{{ idx + 1 }}</span>
              <span class="l">{{ label }}</span>
            </label>
          </div>

          <div v-else-if="q.kind === 'choice'" class="choices">
            <label v-for="(opt, idx) in q.options" :key="idx" class="chip" :class="{ on: answers[q.id] === idx }">
              <input v-model="answers[q.id]" type="radio" :name="q.id" :value="idx" />
              {{ opt }}
            </label>
          </div>

          <textarea v-else v-model="answers[q.id]" :maxlength="q.maxLength" rows="4" placeholder="자유롭게 적어 주세요" />
        </div>
      </section>
    </fieldset>

    <footer class="survey-bottom">
      <p v-if="missing && answeredCount < SURVEY_REQUIRED.length" class="notice is-error">아직 고르지 않은 문항이 있습니다. ({{ answeredCount }}/{{ SURVEY_REQUIRED.length }})</p>
      <button type="button" class="btn btn-primary send" :disabled="!consent || sending" @click="submit">
        {{ sending ? '보내는 중…' : submitted ? '수정해서 다시 보내기' : `보내기 (${answeredCount}/${SURVEY_REQUIRED.length})` }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.survey {
  position: fixed;
  inset: 0;
  z-index: 50;
  overflow-y: auto;
  background: var(--bg);
  padding: 0 12px calc(16px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.survey > * {
  width: 100%;
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}
.survey-top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(10px + env(safe-area-inset-top)) 0 10px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.survey-top h2 {
  margin: 0;
  font-size: 18px;
}
.done .big {
  margin: 4px 0;
  font-size: 18px;
  font-weight: 700;
}
.done .muted {
  margin: 0;
  font-size: 14px;
}
.consent p {
  margin: 0 0 12px;
  line-height: 1.6;
  font-size: 15px;
}
.check {
  display: flex;
  gap: 10px;
  align-items: center;
  font-weight: 700;
  font-size: 16px;
}
.check input {
  width: 22px;
  height: 22px;
  accent-color: var(--accent);
}
.groups {
  border: 0;
  padding: 0;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.groups:disabled {
  opacity: 0.5;
}
.group h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.note {
  margin: 0 0 8px;
  font-size: 13px;
}
.q {
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.q:first-of-type {
  border-top: 0;
}
.q.is-missing .q-text {
  color: var(--danger);
}
.q-text {
  margin: 0 0 10px;
  font-size: 16px;
  line-height: 1.5;
}
.q-num {
  color: var(--muted);
  margin-right: 2px;
}
input[type='radio'] {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.likert {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.opt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 2px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  cursor: pointer;
  text-align: center;
}
.opt .n {
  font-size: 18px;
  font-weight: 800;
}
.opt .l {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.2;
  word-break: keep-all;
}
.opt.on,
.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.opt.on .l {
  color: var(--accent-text);
}
.opt:has(input:focus-visible),
.chip:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 14px;
  cursor: pointer;
}
textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 16px;
  resize: vertical;
}
.survey-bottom {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.survey-bottom .notice {
  margin: 0;
}
.send {
  min-height: 52px;
  font-size: 17px;
}
</style>
