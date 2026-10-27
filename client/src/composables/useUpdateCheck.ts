import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 지금 열린 화면이 최신 버전인지 확인한다. 휴대폰 크롬은 탭을 다시 열 때 예전 화면을
 * 그대로 보여 주는 경우가 많아, 열 때와 다시 볼 때마다 서버의 /version.json과 비교한다.
 */
export function useUpdateCheck() {
  const latest = ref<string | null>(null);
  const outdated = ref(false);

  async function check() {
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok || !res.headers.get('content-type')?.includes('json')) return; // 노트북 프로그램 등 파일이 없는 곳
      const { build } = (await res.json()) as { build: string };
      latest.value = build;
      outdated.value = !!build && build !== __BUILD__ && __BUILD__ !== 'dev';
    } catch {
      /* 오프라인이면 확인하지 않는다 */
    }
  }
  const onVisible = () => document.visibilityState === 'visible' && void check();
  onMounted(() => {
    void check();
    document.addEventListener('visibilitychange', onVisible);
  });
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible));

  return { outdated, latest, reload: () => location.reload() };
}
