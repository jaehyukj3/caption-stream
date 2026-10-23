import { startMicCapture, type MicCapture } from './micCapture';
import type { SttDiag, SttError, SttProvider } from './SttProvider';

type WorkerOut =
  | { op: 'progress'; loaded: number; total: number }
  | { op: 'ready'; cached: boolean }
  | { op: 'error'; message: string }
  | { op: 'result'; kind: 'interim' | 'final'; text: string }
  | { op: 'flushed' }
  | { op: 'decode'; ms: number; audioMs: number };

/** 폰이 느리면 마지막 문장 인식에 시간이 걸린다 */
const FLUSH_TIMEOUT_MS = 8000;

// 모델(약 240MB)은 페이지가 살아 있는 동안 한 번만 읽어 들이도록 작업 스레드를 공유한다
let worker: Worker | null = null;
let ready: Promise<void> | null = null;
const listeners = new Set<(m: WorkerOut) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker('/stt-web/worker.js');
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => listeners.forEach((l) => l(ev.data));
  }
  return worker;
}

/**
 * 이 기기(폰·PC 브라우저) 안에서 도는 음성인식. 노트북 프로그램과 같은 모델(SenseVoice)을
 * WebAssembly로 돌리며, 음성은 기기 밖으로 나가지 않는다.
 * 처음 한 번 모델을 받아 브라우저 보관함에 두고, 다음부터는 보관분을 쓴다.
 */
export class OnDeviceSttProvider implements SttProvider {
  readonly isSupported =
    typeof WebAssembly === 'object' &&
    typeof Worker !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof caches !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  /** 모델 받기·준비. 여러 번 불러도 한 번만 받는다. 진행률은 onProgress로. */
  static prepare(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (!ready) ready = OnDeviceSttProvider.load();
    if (onProgress) {
      const l = (m: WorkerOut) => m.op === 'progress' && onProgress(m.loaded, m.total);
      listeners.add(l);
      ready.then(
        () => listeners.delete(l),
        () => listeners.delete(l),
      );
    }
    return ready;
  }

  private static load(): Promise<void> {
    // 브라우저가 저장 공간이 부족할 때 모델을 지우지 않도록 요청 (거절돼도 동작은 한다)
    void navigator.storage?.persist?.().catch(() => false);
    return new Promise<void>((resolve, reject) => {
      const l = (m: WorkerOut) => {
        if (m.op === 'ready') {
          listeners.delete(l);
          resolve();
        } else if (m.op === 'error') {
          listeners.delete(l);
          ready = null;
          reject(new Error(m.message));
        }
      };
      listeners.add(l);
      getWorker().postMessage({ op: 'init' });
    });
  }

  private running = false;
  private capture: MicCapture | null = null;
  private deviceId: string | null = null;
  private lastInterim = '';
  private flushWaiter: (() => void) | null = null;
  private readonly listener = (m: WorkerOut) => this.onWorker(m);

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
    try {
      await OnDeviceSttProvider.prepare();
    } catch (e) {
      const message = `음성인식 모델을 준비하지 못했습니다: ${(e as Error).message}`;
      this.errorCb({ fatal: true, code: 'model', message });
      throw new Error(message);
    }
    this.running = true;
    listeners.add(this.listener);
    const w = getWorker();
    w.postMessage({ op: 'reset' });
    try {
      this.capture = await startMicCapture(this.deviceId, (pcm) => w.postMessage({ op: 'audio', pcm }, [pcm]));
    } catch (e) {
      this.running = false;
      listeners.delete(this.listener);
      throw e;
    }
    this.diagCb({ type: 'listening' });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.capture?.stop();
    this.capture = null;
    // 말하던 문장까지 확정한 뒤 끝낸다
    const flushed = new Promise<boolean>((resolve) => {
      this.flushWaiter = () => resolve(true);
      setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
    });
    getWorker().postMessage({ op: 'flush' });
    if (!(await flushed)) this.emitLeftoverAsFinal();
    this.flushWaiter = null;
    listeners.delete(this.listener);
    this.diagCb({ type: 'stopped' });
  }

  private onWorker(m: WorkerOut) {
    switch (m.op) {
      case 'result':
        if (m.kind === 'interim') {
          this.lastInterim = m.text;
          this.interimCb(m.text);
        } else {
          this.lastInterim = '';
          this.finalCb(m.text);
        }
        break;
      case 'flushed':
        this.flushWaiter?.();
        break;
      case 'decode':
        // 기기 성능 기록 (테스트 기록에 남는다): 인식 시간 / 말소리 길이
        this.diagCb({ type: 'decode', detail: `${Math.round(m.ms)}/${Math.round(m.audioMs)}` });
        break;
      case 'error':
        this.diagCb({ type: 'error', detail: m.message });
        this.errorCb({ fatal: false, code: 'engine', message: `음성인식 오류: ${m.message}` });
        break;
    }
  }

  private emitLeftoverAsFinal() {
    const t = this.lastInterim.trim();
    this.lastInterim = '';
    if (t) this.finalCb(t);
  }
}
