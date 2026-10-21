<script setup lang="ts">
defineProps<{ level: number; active: boolean }>();
</script>

<template>
  <div class="meter" :class="{ 'is-active': active }" role="meter" aria-label="마이크 입력 레벨" :aria-valuenow="Math.round(level * 100)" aria-valuemin="0" aria-valuemax="100">
    <div class="fill" :style="{ transform: `scaleX(${level})` }" />
  </div>
</template>

<style scoped>
.meter {
  height: 8px;
  border-radius: 4px;
  background: var(--surface-2);
  overflow: hidden;
}
.fill {
  height: 100%;
  transform-origin: left;
  background: linear-gradient(90deg, var(--ok) 0 60%, var(--warn) 80%, var(--danger));
  opacity: 0.35;
}
.is-active .fill {
  opacity: 1;
}
</style>
