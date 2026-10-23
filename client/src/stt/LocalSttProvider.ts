import { STT_PATH, type SttServerMessage } from '@caption/shared';
import { startMicCapture, type MicCapture } from './micCapture';
import type { SttDiag, SttError, SttProvider } from './SttProvider';

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
  private capture: MicCapture | null = null;
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
    this.capture = await startMicCapture(this.deviceId, (pcm) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
    });
  }

  private stopAudio() {
    this.capture?.stop();
    this.capture = null;
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
