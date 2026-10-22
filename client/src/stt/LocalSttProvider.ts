import { STT_PATH, STT_SAMPLE_RATE, type SttServerMessage } from '@caption/shared';
import type { SttDiag, SttError, SttProvider } from './SttProvider';

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

const FLUSH_TIMEOUT_MS = 1500;
const RECONNECT_DELAY_MS = 1000;

/**
 * 노트북 안의 음성인식 엔진(서버의 /stt)을 쓰는 구현.
 * 음성은 localhost로만 전송되며 노트북 밖으로 나가지 않는다.
 */
export class LocalSttProvider implements SttProvider {
  readonly isSupported = typeof AudioWorkletNode !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  private running = false;
  private ws: WebSocket | null = null;
  private media: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private lastInterim = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushWaiter: (() => void) | null = null;
  private deviceId: string | null = null;

  private interimCb: (t: string) => void = () => {};
  private finalCb: (t: string) => void = () => {};
  private errorCb: (e: SttError) => void = () => {};
  private diagCb: (e: SttDiag) => void = () => {};

  onInterim(cb: (text: string) => void) {
    this.interimCb = cb;
  }
  onFinal(cb: (text: string) => void) {
    this.finalCb = cb;
  }
  onError(cb: (err: SttError) => void) {
    this.errorCb = cb;
  }
  onDiag(cb: (e: SttDiag) => void) {
    this.diagCb = cb;
  }

  setDeviceId(deviceId: string | null) {
    this.deviceId = deviceId || null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // 엔진 연결을 먼저 확인해야 마이크를 켠 뒤에 실패하는 일이 없다
      await this.connect(true);
      await this.startAudio();
    } catch (e) {
      await this.cleanup();
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopAudio();

    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const flushed = new Promise<boolean>((resolve) => {
        this.flushWaiter = () => resolve(true);
        setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
      });
      ws.send(JSON.stringify({ type: 'flush' }));
      if (!(await flushed)) this.emitLeftoverAsFinal();
    } else {
      this.emitLeftoverAsFinal();
    }
    await this.cleanup();
  }

  /** initial=false(송출 중 재연결)이면 실패해도 멈추지 않고 계속 다시 시도한다 */
  private connect(initial: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${STT_PATH}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as SttServerMessage;
        switch (msg.type) {
          case 'ready':
            this.diagCb({ type: 'listening' });
            settled = true;
            resolve();
            break;
          case 'interim':
            this.lastInterim = msg.text;
            this.interimCb(msg.text);
            break;
          case 'final':
            this.lastInterim = '';
            this.finalCb(msg.text);
            break;
          case 'flushed':
            this.flushWaiter?.();
            this.flushWaiter = null;
            break;
          case 'error': {
            this.diagCb({ type: 'error', detail: msg.code });
            const fatal = msg.code !== 'ENGINE_ERROR';
            const err = { fatal, code: msg.code, message: msg.message };
            if (!settled) {
              settled = true;
              this.errorCb(err);
              reject(new Error(msg.message));
            } else {
              this.errorCb(err);
              if (fatal) void this.stop();
            }
            break;
          }
        }
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (settled) this.diagCb({ type: 'stopped', detail: this.running ? 'disconnected' : undefined });
        if (!settled && initial) {
          settled = true;
          const message = '음성인식 엔진에 연결하지 못했습니다. 자막 서버(실행기 창)가 켜져 있는지 확인해 주세요.';
          this.errorCb({ fatal: true, code: 'unreachable', message });
          reject(new Error(message));
          return;
        }
        if (!settled) reject(new Error('reconnect failed'));
        // 송출 중에 끊기면 다시 연결. 끊긴 동안의 소리는 버려진다.
        if (this.running) {
          this.errorCb({ fatal: false, code: 'reconnecting', message: '음성인식 엔진 연결이 끊겨 다시 연결하는 중…' });
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.running) this.connect(false).catch(() => {});
          }, RECONNECT_DELAY_MS);
        }
      };
    });
  }

  private async startAudio() {
    // 브라우저 잡음 제거·자동 음량은 인식률을 떨어뜨려 끈다 (실측: 끝음절 누락, 오인식 증가)
    this.media = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(ev.data);
    };
    // 그래프 끝(destination)에 이어져 있어야 처리가 돈다. 소리는 내지 않는다.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(this.media).connect(node).connect(mute).connect(ctx.destination);
  }

  private stopAudio() {
    this.media?.getTracks().forEach((t) => t.stop());
    this.media = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  private emitLeftoverAsFinal() {
    const t = this.lastInterim.trim();
    this.lastInterim = '';
    if (t) this.finalCb(t);
  }

  private async cleanup() {
    this.running = false;
    this.stopAudio();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
