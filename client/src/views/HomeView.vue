<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { isValidRoomCode } from '@caption/shared';
import { usePreferences } from '../composables/usePreferences';

usePreferences();
const router = useRouter();
const code = ref('');
const normalized = computed(() => code.value.replace(/\D/g, ''));

function join() {
  if (isValidRoomCode(normalized.value)) router.push(`/view/${normalized.value}`);
}
</script>

<template>
  <main class="home">
    <h1>실시간 자막</h1>
    <form class="card join" @submit.prevent="join">
      <label for="code">방 코드 6자리</label>
      <input id="code" v-model="code" type="text" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="123 456" />
      <button type="submit" class="btn btn-primary" :disabled="!isValidRoomCode(normalized)">자막 보기</button>
    </form>
    <RouterLink to="/host" class="muted host-link">강사이신가요? 송출하기 →</RouterLink>
  </main>
</template>

<style scoped>
.home {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 24px 16px;
}
h1 {
  margin: 0;
}
.join {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.join input {
  font-size: 28px;
  min-height: 56px;
  text-align: center;
  letter-spacing: 0.15em;
  font-variant-numeric: tabular-nums;
}
.join .btn {
  min-height: 48px;
}
.host-link {
  font-size: 14px;
}
</style>
