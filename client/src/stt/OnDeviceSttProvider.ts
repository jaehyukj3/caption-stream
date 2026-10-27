import { dlog } from '../utils/debugLog';
import { startMicCapture, type MicCapture } from './micCapture';
import type { SttDiag, SttError, SttProvider } from './SttProvider';

type WorkerOut =
  | { op: 'progress'; loaded: number; total: number }
  | { op: 'loading' }
  | { op: 'ready'; cached: boolean }
  | { op: 'error'; message: string }
  | { op: 'result'; kind: 'interim' | 'final'; text: string }
  | { op: 'flushed' }
  | { op: 'decode'; ms: number; audioMs: number };

/** 폰이 느리면 마지막 문장 인식에 시간이 걸린다 */
const FLUSH_TIMEOUT_MS = 8000;
/** 받은 모델을 엔진에 읽어 들이는 데 이보다 오래 걸리면 멈춘 것으로 본다 */
const LOAD_TIMEOUT_MS = 180_000;

export type ModelPhase = 'download' | 'loading';

// 모델(약 240MB)은 페이지가 살아 있는 동안 한 번만 읽어 들이도록 작업 스레드를 공유한다
let worker: Worker | null = null;
let ready: Promise<void> | null = null;
const listeners = new Set<(m: WorkerOut) => void>();

function getWorker(): Worker {
  if (!worker) {
    const w = new Worker('/stt-web/worker.js');
    let lastPct = -1;
    w.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      if (m.op === 'progress') {
        const pct = Math.floor((m.loaded / m.total) * 10) * 10;
        if (pct !== lastPct) dlog(`모델 받기 ${(lastPct = pct)}%`);
      } else if (m.op === 'loading' || m.op === 'error' || m.op === 'flushed') dlog(`엔진: ${m.op}${m.op === 'error' ? ` ${m.message}` : ''}`);
      else if (m.op === 'ready') dlog(`엔진: 준비 완료 (보관분 사용: ${m.cached})`);
      listeners.forEach((l) => l(m));
    };
    // 메모리 부족 등으로 작업 스레드가 죽으면 기다리지 말고 알린다. 다음 시도는 새 스레드로.
    w.onerror = (ev) => {
      ev.preventDefault();
      if (worker === w) worker = null;
      w.terminate();
      const message = ev.message || '음성인식 엔진이 멈췄습니다 (기기 메모리가 부족할 수 있습니다)';
      dlog(`엔진 스레드 오류: ${message}`);
      listeners.forEach((l) => l({ op: 'error', message }));
    };
    worker = w;
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
  static prepare(onProgress?: (phase: ModelPhase, fraction: number) => void): Promise<void> {
    if (!ready) ready = OnDeviceSttProvider.load();
    if (onProgress) {
      const l = (m: WorkerOut) => {
        if (m.op === 'progress') onProgress('download', m.loaded / m.total);
        if (m.op === 'loading') onProgress('loading', 1);
      };
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
    dlog('엔진 준비 시작');
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        listeners.delete(l);
        if (timer) clearTimeout(timer);
      };
      const fail = (message: string) => {
        done();
        ready = null;
        // 멈춘 스레드는 버리고 다음 시도는 새로 시작
        worker?.terminate();
        worker = null;
        reject(new Error(message));
      };
      const l = (m: WorkerOut) => {
        if (m.op === 'ready') {
          done();
          resolve();
        } else if (m.op === 'error') {
          fail(m.message);
        } else if (m.op === 'loading') {
          timer = setTimeout(() => fail('모델을 읽어 들이다 멈췄습니다 (기기 메모리가 부족할 수 있습니다)'), LOAD_TIMEOUT_MS);
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
    dlog('기기 안 인식 시작');
    this.running = true;
    // 마이크는 버튼을 누른 그 순간에 켠다 (모델 준비를 기다린 뒤 켜면 브라우저가 소리 처리를 막을 수 있다).
    // 모델이 준비되기 전의 소리는 버린다.
    let engineReady = false;
    try {
      this.capture = await startMicCapture(this.deviceId, (pcm) => engineReady && worker?.postMessage({ op: 'audio', pcm }, [pcm]));
    } catch (e) {
      this.running = false;
      throw e;
    }
    try {
      await OnDeviceSttProvider.prepare();
    } catch (e) {
      this.running = false;
      this.capture?.stop();
      this.capture = null;
      const message = `음성인식 모델을 준비하지 못했습니다: ${(e as Error).message}`;
      this.errorCb({ fatal: true, code: 'model', message });
      throw new Error(message);
    }
    listeners.add(this.listener);
    getWorker().postMessage({ op: 'reset' });
    engineReady = true;
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
