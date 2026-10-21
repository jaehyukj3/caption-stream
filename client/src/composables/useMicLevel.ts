import { onBeforeUnmount, ref } from 'vue';

/**
 * 마이크 입력 레벨(0~1). Web Speech API는 레벨을 알려주지 않으므로
 * 별도로 getUserMedia + AnalyserNode로 측정한다(크롬은 같은 마이크를 동시에 열 수 있다).
 */
export function useMicLevel() {
  const level = ref(0);
  const active = ref(false);

  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let raf = 0;

  async function start(deviceId?: string | null) {
    if (active.value) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    active.value = true;

    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      // 말소리 RMS는 대략 0.01~0.3 → 로그 스케일로 0~1에 매핑
      const db = 20 * Math.log10(rms || 1e-8);
      const target = Math.min(1, Math.max(0, (db + 60) / 50));
      // 올라갈 때는 빠르게, 내려갈 때는 천천히
      level.value = target > level.value ? target : level.value * 0.9 + target * 0.1;
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stop() {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    stream = null;
    ctx = null;
    active.value = false;
    level.value = 0;
  }

  onBeforeUnmount(stop);
  return { level, active, start, stop };
}
