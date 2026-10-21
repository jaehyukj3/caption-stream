<script setup lang="ts">
/**
 * Document Picture-in-Picture로 항상 위에 떠 있는 작은 자막 창을 연다.
 * 같은 Vue 런타임에서 별도 앱을 PiP 문서에 마운트하므로 반응형 상태가 그대로 공유된다.
 */
import { createApp, h, onBeforeUnmount, ref, type App } from 'vue';
import type { CaptionLine } from '@caption/shared';
import CaptionView from '../caption/CaptionView.vue';

const props = defineProps<{
  /** reactive 객체를 그대로 넘겨야 PiP 창이 실시간으로 갱신된다 */
  source: { lines: CaptionLine[]; interim: string };
  fontSize: number;
}>();

interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}
const dpip = (window as Window & { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture;
const supported = !!dpip;

const isOpen = ref(false);
const message = ref('');
let pipApp: App | null = null;
let pipWindow: Window | null = null;

/** 메인 문서의 스타일을 PiP 문서로 복사 (Vite가 주입한 컴포넌트 CSS 포함) */
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      const style = target.createElement('style');
      style.textContent = css;
      target.head.appendChild(style);
    } catch {
      // 다른 출처 스타일시트는 cssRules 접근이 막혀 있으니 link로 연결
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
}

async function open() {
  if (!dpip) {
    message.value = '이 브라우저는 플로팅 자막(Document Picture-in-Picture)을 지원하지 않습니다. 데스크톱 크롬 116 이상(또는 엣지)에서 사용해 주세요.';
    return;
  }
  if (pipWindow) {
    pipWindow.focus();
    return;
  }
  try {
    const win = await dpip.requestWindow({ width: 720, height: 170 });
    pipWindow = win;
    copyStyles(win.document);
    win.document.title = '실시간 자막';
    win.document.documentElement.dataset.theme = 'dark';
    Object.assign(win.document.body.style, { margin: '0', background: '#000', height: '100vh', overflow: 'hidden' });

    const root = win.document.createElement('div');
    root.style.height = '100%';
    win.document.body.appendChild(root);

    pipApp = createApp({
      render: () =>
        h(CaptionView, {
          lines: props.source.lines,
          interim: props.source.interim,
          fontSize: props.fontSize,
          variant: 'overlay',
          maxLines: 2,
        }),
    });
    pipApp.mount(root);
    isOpen.value = true;
    message.value = '';

    win.addEventListener('pagehide', cleanup, { once: true });
  } catch (e) {
    message.value = `플로팅 창을 열지 못했습니다: ${(e as Error).message}`;
    cleanup();
  }
}

function cleanup() {
  pipApp?.unmount();
  pipApp = null;
  pipWindow = null;
  isOpen.value = false;
}

function close() {
  pipWindow?.close();
  cleanup();
}

onBeforeUnmount(close);
</script>

<template>
  <div class="floating">
    <button type="button" class="btn" :title="supported ? '항상 위에 떠 있는 작은 자막 창' : '이 브라우저에서는 지원되지 않음'" @click="isOpen ? close() : open()">
      ⧉ {{ isOpen ? '플로팅 자막 닫기' : '플로팅 자막' }}
    </button>
    <p v-if="message" class="notice">{{ message }}</p>
  </div>
</template>

<style scoped>
.floating {
  display: contents;
}
.notice {
  margin: 0;
  flex-basis: 100%;
}
</style>
