import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 지금 열린 화면이 최신 버전인지 확인한다. 휴대폰 크롬은 탭을 다시 열 때 예전 화면을
 * 그대로 보여 주는 경우가 많아, 열 때와 다시 볼 때마다 서버의 /version.json과 비교한다.
 */
export function useUpdateCheck() {
  const latest = ref<string | null>(null);
  const outdated = ref(false);
  /** 노트북 프로그램이면 새 버전 받을 주소 (새로고침으로는 바뀌지 않으므로) */
  const download = ref<string | null>(null);

  async function check() {
    try {
      // 노트북 프로그램: 웹 송출 사이트의 최신 빌드와 비교 (자기 /version.json은 늘 자기 버전이라 소용없다)
      const app = await fetch('/api/latest', { cache: 'no-store' }).catch(() => null);
      if (app?.ok && app.headers.get('content-type')?.includes('json')) {
        const v = (await app.json()) as { build: string | null; download: string };
        if (!v.build) return;
        latest.value = v.build;
        download.value = v.download;
        outdated.value = v.build !== __BUILD__ && __BUILD__ !== 'dev';
        return;
      }
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

  return { outdated, latest, download, reload: () => location.reload() };
}
