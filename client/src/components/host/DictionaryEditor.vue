<script setup lang="ts">
import { ref } from 'vue';
import type { DictEntry } from '../../composables/useDictionary';

defineProps<{ entries: readonly DictEntry[] }>();
const emit = defineEmits<{ add: [from: string, to: string]; remove: [index: number] }>();

const from = ref('');
const to = ref('');
const fromInput = ref<HTMLInputElement | null>(null);

function submit() {
  if (!from.value.trim()) return;
  emit('add', from.value, to.value);
  from.value = '';
  to.value = '';
  fromInput.value?.focus();
}
</script>

<template>
  <section class="card dict">
    <h2>용어 사전 <span class="muted count">{{ entries.length }}</span></h2>
    <form class="add" @submit.prevent="submit">
      <input ref="fromInput" v-model="from" type="text" placeholder="오인식 (예: 쿠버 내티스)" aria-label="오인식 단어" />
      <span class="arrow" aria-hidden="true">→</span>
      <input v-model="to" type="text" placeholder="교정어 (예: 쿠버네티스)" aria-label="교정어" />
      <button type="submit" class="btn" :disabled="!from.trim()">추가</button>
    </form>
    <ul v-if="entries.length" class="list">
      <li v-for="(e, i) in entries" :key="e.from">
        <span class="from">{{ e.from }}</span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="to">{{ e.to || '(삭제)' }}</span>
        <button type="button" class="btn btn-icon del" :aria-label="`${e.from} 삭제`" @click="emit('remove', i)">✕</button>
      </li>
    </ul>
    <p v-else class="muted hint">자주 틀리는 전문용어·이름을 등록하면 송출 전에 자동으로 고쳐집니다. 띄어쓰기 차이는 무시합니다.</p>
  </section>
</template>

<style scoped>
.count {
  font-weight: 400;
}
.add {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto;
  gap: 6px;
  align-items: center;
}
.arrow {
  color: var(--muted);
}
.list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
}
.list li {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 4px 0;
  border-top: 1px solid var(--border);
}
.from {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--danger) 60%, transparent);
}
.to {
  font-weight: 600;
}
.del {
  min-height: 32px;
  min-width: 32px;
  background: transparent;
  border-color: transparent;
  color: var(--muted);
}
.hint {
  margin: 10px 0 0;
  font-size: 13px;
}
@media (max-width: 480px) {
  .add {
    grid-template-columns: 1fr;
  }
  .add .arrow {
    display: none;
  }
}
</style>
