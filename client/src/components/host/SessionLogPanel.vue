<script setup lang="ts">
/** 테스트 기록: 이용 통계와 음성인식 끊김을 보여 주고 파일로 저장 */
import { computed } from 'vue';
import type { RoomStats } from '@caption/shared';
import type { SessionLog } from '../../composables/useSessionLog';

const props = defineProps<{ log: SessionLog; stats: RoomStats | null }>();
const emit = defineEmits<{ save: [] }>();

const viewers = computed(() => props.log.viewerSummary(props.stats));
const stt = computed(() => props.log.sttSummary.value);
const sec = (ms: number) => (ms / 1000).toFixed(1);
</script>

<template>
  <section class="card log">
    <h2>테스트 기록</h2>
    <dl>
      <div>
        <dt>접속한 사람 (기기 기준)</dt>
        <dd>
          {{ viewers?.unique ?? '–' }}명
          <small v-if="viewers">· 1분 이상 {{ viewers.watched }}명</small>
        </dd>
      </div>
      <div>
        <dt>최대 동시 접속</dt>
        <dd>{{ viewers?.peak ?? '–' }}명</dd>
      </div>
      <div>
        <dt>평균 이용 시간 (1분 이상 본 사람)</dt>
        <dd>{{ viewers ? `${viewers.avgMinutes.toFixed(1)}분` : '–' }}</dd>
      </div>
      <div>
        <dt>음성인식 끊김</dt>
        <dd>
          {{ stt.restarts }}회
          <small v-if="stt.restarts">· 최장 {{ sec(stt.longestGapMs) }}초, 합계 {{ sec(stt.totalGapMs) }}초</small>
        </dd>
      </div>
    </dl>
    <button type="button" class="btn" @click="emit('save')">⤓ 테스트 기록 저장(.json)</button>
    <p class="muted hint">이용 통계, 끊김 기록, 자막 전체가 파일 하나로 저장됩니다. 참석자는 익명 무작위 ID로만 구분됩니다.</p>
  </section>
</template>

<style scoped>
.log {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.log h2 {
  margin: 0;
}
dl {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}
dl > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  font-weight: 700;
  text-align: right;
}
dd small {
  font-weight: 400;
  color: var(--muted);
}
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
</style>
