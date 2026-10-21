<script setup lang="ts">
/**
 * 자막 표시 전용 컴포넌트 (재사용 대상).
 * 소켓·STT를 전혀 모르고 props만으로 그린다. 송출자 화면, 수신자 화면,
 * PiP 플로팅 창, 그리고 이후 Electron 투명 오버레이 창에서 그대로 쓴다.
 *
 * - variant="panel":   스크롤되는 전체 이력 + 자동 스크롤/"최신으로" 버튼
 * - variant="overlay": 최근 maxLines줄만, 배경 투명·외곽선 글자 (플로팅/오버레이용)
 */
import { computed, ref } from 'vue';
import type { CaptionLine } from '@caption/shared';
import { useAutoScroll } from '../../composables/useAutoScroll';

const props = withDefaults(
  defineProps<{
    lines: readonly CaptionLine[];
    /** 아직 서버에 전달되지 않은 확정 문장 (송출자 화면용) */
    pendingLines?: readonly string[];
    interim?: string;
    fontSize?: number;
    highlightLatest?: boolean;
    variant?: 'panel' | 'overlay';
    maxLines?: number;
  }>(),
  {
    pendingLines: () => [],
    interim: '',
    fontSize: 22,
    highlightLatest: true,
    variant: 'panel',
    maxLines: 2,
  },
);

interface Row {
  key: string;
  text: string;
  kind: 'final' | 'latest' | 'pending' | 'interim';
}

const rows = computed<Row[]>(() => {
  const finals = props.variant === 'overlay' ? props.lines.slice(-props.maxLines) : props.lines;
  const lastSeq = props.lines.at(-1)?.seq;
  const out: Row[] = finals.map((l) => ({
    key: `s${l.seq}`,
    text: l.text,
    kind: props.highlightLatest && l.seq === lastSeq && !props.pendingLines.length ? 'latest' : 'final',
  }));
  props.pendingLines.forEach((text, i) => out.push({ key: `p${i}`, text, kind: 'pending' }));
  if (props.interim) out.push({ key: 'interim', text: props.interim, kind: 'interim' });
  return props.variant === 'overlay' ? out.slice(-(props.maxLines + 1)) : out;
});

const scroller = ref<HTMLElement | null>(null);
const { paused, scrollToBottom } = useAutoScroll(scroller, () => [rows.value.length, props.interim, props.fontSize]);
</script>

<template>
  <div class="caption-view" :class="`is-${variant}`" :style="{ '--cap-font-size': `${fontSize}px` }">
    <div ref="scroller" class="cap-scroll" aria-live="polite" aria-relevant="additions">
      <p v-if="!rows.length" class="cap-empty">
        <slot name="empty">자막이 여기에 표시됩니다.</slot>
      </p>
      <p v-for="row in rows" :key="row.key" class="cap-line" :class="`is-${row.kind}`">{{ row.text }}</p>
    </div>
    <button v-if="variant === 'panel' && paused" type="button" class="cap-jump" @click="scrollToBottom(true)">
      최신 자막으로 ↓
    </button>
  </div>
</template>

<style scoped>
.caption-view {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  font-size: var(--cap-font-size);
  line-height: 1.5;
  color: var(--cap-text, #f2f4f7);
  word-break: keep-all;
  overflow-wrap: anywhere;
}

.cap-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.6em 0.8em 1.2em;
  scroll-padding-bottom: 1em;
}

.cap-line {
  margin: 0 0 0.45em;
  transition: color 0.3s, opacity 0.3s;
}
.cap-line.is-final {
  color: var(--cap-muted-text, color-mix(in srgb, currentColor 72%, transparent));
}
.cap-line.is-latest {
  color: var(--cap-text, #f2f4f7);
  font-weight: 600;
  border-left: 0.18em solid var(--cap-accent, #ffd54a);
  padding-left: 0.45em;
  margin-left: -0.63em;
}
.cap-line.is-pending {
  opacity: 0.55;
  font-style: italic;
}
.cap-line.is-interim {
  color: var(--cap-interim, color-mix(in srgb, currentColor 45%, transparent));
}

.cap-empty {
  margin: 0;
  color: var(--cap-interim, color-mix(in srgb, currentColor 45%, transparent));
  font-size: 0.8em;
}

.cap-jump {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  border: 0;
  border-radius: 999px;
  padding: 8px 16px;
  font: 600 14px/1 system-ui, sans-serif;
  color: var(--cap-jump-text, #111418);
  background: var(--cap-accent, #ffd54a);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.3);
  cursor: pointer;
}

/* ── overlay: 배경 없이 영상/슬라이드 위에 얹는 형태 ── */
.is-overlay {
  justify-content: flex-end;
  color: #fff;
}
.is-overlay .cap-scroll {
  flex: 0 1 auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 0.3em 0.6em;
}
.is-overlay .cap-line {
  margin: 0 0 0.15em;
  color: #fff;
  font-weight: 600;
  border: 0;
  padding: 0;
  text-shadow:
    0 0 3px #000,
    0 0 3px #000,
    0 1px 2px #000;
}
.is-overlay .cap-line.is-final {
  color: rgb(255 255 255 / 0.85);
}
.is-overlay .cap-line.is-interim {
  color: rgb(255 255 255 / 0.65);
}
</style>
