<script setup lang="ts">
import MicLevelMeter from './MicLevelMeter.vue';

export type MicState = 'idle' | 'starting' | 'running' | 'paused' | 'ended';
export interface MicDevice {
  deviceId: string;
  label: string;
}

defineProps<{ state: MicState; level: number; devices: MicDevice[] }>();
defineEmits<{ start: []; pause: []; end: [] }>();
/** '' = Windows 기본 마이크 */
const deviceId = defineModel<string>('deviceId', { required: true });

const LABEL: Record<MicState, string> = {
  idle: '대기',
  starting: '마이크 준비 중…',
  running: '인식 중',
  paused: '일시정지',
  ended: '종료됨',
};
</script>

<template>
  <section class="card mic">
    <div class="status">
      <span class="dot" :class="{ 'is-live': state === 'running', 'is-wait': state === 'paused' || state === 'starting', 'is-off': state === 'ended' }" />
      <span>{{ LABEL[state] }}</span>
    </div>
    <select v-model="deviceId" class="device" aria-label="마이크 선택" :disabled="state === 'running' || state === 'starting' || state === 'ended'">
      <option value="">Windows 기본 마이크</option>
      <option v-for="d in devices" :key="d.deviceId" :value="d.deviceId">{{ d.label }}</option>
    </select>
    <MicLevelMeter :level="level" :active="state === 'running'" />
    <div class="buttons">
      <button v-if="state !== 'running'" type="button" class="btn btn-primary" :disabled="state === 'ended' || state === 'starting'" @click="$emit('start')">
        ● {{ state === 'paused' ? '다시 시작' : '마이크 시작' }}
      </button>
      <button v-else type="button" class="btn" @click="$emit('pause')">❚❚ 일시정지</button>
      <button type="button" class="btn btn-danger" :disabled="state === 'ended'" @click="$emit('end')">■ 세션 종료</button>
    </div>
  </section>
</template>

<style scoped>
.mic {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.device {
  min-height: 40px;
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  padding: 0 8px;
}
.buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.buttons .btn {
  flex: 1;
}
</style>
