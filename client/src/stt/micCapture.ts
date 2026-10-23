import { STT_SAMPLE_RATE } from '@caption/shared';

/**
 * 마이크 소리를 16kHz PCM(Int16)으로 100ms씩 잘라 보내는 AudioWorklet.
 * AudioContext를 16kHz로 만들면 브라우저가 리샘플링해 준다.
 *
 * 입력 음량 자동 맞춤: 앰프 출력(크게 들어옴)이든 스피커 소리를 내장 마이크로
 * 받는 경우(작게 들어옴)든 인식에 알맞은 크기로 천천히 맞춘다.
 * 말소리 구간만 기준으로 삼아 조용할 때 잡음을 키우지 않는다.
 */
const WORKLET_SOURCE = `
const CHUNK = ${STT_SAMPLE_RATE / 10};
const TARGET = 0.08, FLOOR = 0.004, MIN_GAIN = 0.5, MAX_GAIN = 8;
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(CHUNK); this.n = 0; this.env = TARGET; this.gain = 1; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / ch.length);
      if (rms > FLOOR) this.env = this.env * 0.995 + rms * 0.005;
      const want = Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET / this.env));
      this.gain += (want - this.gain) * 0.01;
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i] * this.gain));
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === CHUNK) {
          // 버퍼를 넘기면(transfer) 원래 배열은 길이 0이 되므로 새로 만든다
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(CHUNK);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export interface MicCapture {
  stop(): void;
}

/** 마이크를 켜고 16kHz Int16 PCM을 100ms마다 onChunk로 넘긴다 */
export async function startMicCapture(deviceId: string | null, onChunk: (pcm: ArrayBuffer) => void): Promise<MicCapture> {
  // 브라우저 잡음 제거·자동 음량은 인식률을 떨어뜨려 끈다 (실측: 끝음절 누락, 오인식 증가)
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
  const stop = () => {
    media.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => onChunk(ev.data);
    // 그래프 끝(destination)에 이어져 있어야 처리가 돈다. 소리는 내지 않는다.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(media).connect(node).connect(mute).connect(ctx.destination);
  } catch (e) {
    stop();
    throw e;
  }
  return { stop };
}
