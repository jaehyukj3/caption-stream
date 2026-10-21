import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref, type WatchSource } from 'vue';

const BOTTOM_THRESHOLD_PX = 40;

/**
 * 새 내용이 오면 맨 아래로 스크롤. 사용자가 위로 올려 읽는 중이면 멈추고
 * `paused`가 true가 되어 "최신으로" 버튼을 띄울 수 있다.
 */
export function useAutoScroll(container: Ref<HTMLElement | null>, trigger: WatchSource) {
  const paused = ref(false);
  /** 부드러운 스크롤 애니메이션 중에는 중간 위치를 "사용자가 올림"으로 오인하지 않는다 */
  let programmatic = false;
  let programmaticTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | null = null;

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;

  function onScroll() {
    const el = container.value;
    if (!el) return;
    if (atBottom(el)) {
      paused.value = false;
      programmatic = false;
    } else if (!programmatic) {
      paused.value = true;
    }
  }

  /** 사용자가 직접 스크롤을 시작하면 진행 중인 자동 스크롤 판단을 끊는다 */
  function onUserScroll() {
    programmatic = false;
  }

  function scrollToBottom(smooth = false) {
    const el = container.value;
    if (!el) return;
    programmatic = true;
    clearTimeout(programmaticTimer);
    programmaticTimer = setTimeout(() => (programmatic = false), 1000);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    paused.value = false;
  }

  watch(trigger, async () => {
    if (paused.value) return;
    await nextTick();
    scrollToBottom();
  });

  onMounted(() => {
    const el = container.value;
    el?.addEventListener('scroll', onScroll, { passive: true });
    el?.addEventListener('wheel', onUserScroll, { passive: true });
    el?.addEventListener('touchstart', onUserScroll, { passive: true });
    // 안내 배너 등장, 화면 회전 등으로 영역 크기가 바뀌어도 맨 아래를 유지
    if (el) {
      resizeObserver = new ResizeObserver(() => !paused.value && scrollToBottom());
      resizeObserver.observe(el);
    }
    scrollToBottom();
  });
  onBeforeUnmount(() => resizeObserver?.disconnect());

  return { paused, scrollToBottom };
}
