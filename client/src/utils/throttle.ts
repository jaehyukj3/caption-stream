/**
 * 최대 interval마다 한 번 호출. 간격 안의 호출은 마지막 인자만 남겨 간격이 끝날 때 보낸다(trailing).
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, interval: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const run = () => {
    timer = null;
    if (!pending) return;
    last = Date.now();
    const args = pending;
    pending = null;
    fn(...args);
  };

  const call = (...args: A) => {
    pending = args;
    if (timer) return;
    const wait = last + interval - Date.now();
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };

  /** 대기 중인 호출을 버린다 (예: final이 오면 interim 대기분은 의미 없음) */
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return call;
}
