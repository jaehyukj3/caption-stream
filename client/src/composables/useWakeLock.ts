import { onBeforeUnmount, onMounted } from 'vue';

/** 자막을 보는 동안 휴대폰 화면이 꺼지지 않게 한다 (지원 브라우저만, HTTPS 필요). */
export function useWakeLock() {
  let lock: { release(): Promise<void> } | null = null;

  async function acquire() {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl || document.visibilityState !== 'visible') return;
    try {
      lock = await wl.request('screen');
    } catch {
      /* 배터리 절약 모드 등으로 거부될 수 있다 */
    }
  }

  // 탭을 벗어나면 자동 해제되므로 돌아올 때 다시 요청
  const onVisible = () => document.visibilityState === 'visible' && acquire();

  onMounted(() => {
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisible);
    void lock?.release().catch(() => {});
  });
}
