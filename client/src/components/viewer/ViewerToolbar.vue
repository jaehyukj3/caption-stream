<script setup lang="ts">
import type { Theme } from '../../composables/usePreferences';

defineProps<{ theme: Theme; canDownload: boolean }>();
defineEmits<{ smaller: []; bigger: []; toggleTheme: []; download: [] }>();
</script>

<template>
  <div class="toolbar">
    <button type="button" class="btn btn-icon" aria-label="글자 작게" @click="$emit('smaller')">A−</button>
    <button type="button" class="btn btn-icon" aria-label="글자 크게" @click="$emit('bigger')">A+</button>
    <button type="button" class="btn btn-icon" :aria-label="theme === 'dark' ? '라이트 모드' : '다크 모드'" @click="$emit('toggleTheme')">
      {{ theme === 'dark' ? '☀' : '☾' }}
    </button>
    <button type="button" class="btn btn-icon" aria-label="자막 텍스트 다운로드" title="자막 저장(.txt)" :disabled="!canDownload" @click="$emit('download')">⤓</button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 6px;
  flex: none;
}
.toolbar .btn {
  min-height: 38px;
  min-width: 38px;
  padding: 0 8px;
  font-size: 15px;
}
</style>
