import { dlog } from '../utils/debugLog';
import type { ModelPhase } from './OnDeviceSttProvider';
import type { SttDiag, SttError, SttProvider } from './SttProvider';

/** 안드로이드 앱(android/)이 화면에 넣어 주는 연결 */
interface CaptionNativeApi {
  version(): string;
  prepare(): void;
  start(): void;
  stop(): void;
  saveFile(name: string, mime: string, base64: string): void;
  /** 최근 10초 소리 (base64, 16kHz 16비트 PCM). 예전 앱에는 없다. */
  recentAudio?(): string;
}

type NativeEvent =
  | { op: 'progress'; loaded: number; total: number }
  | { op: 'loading' }
  | { op: 'ready' }
  | { op: 'error'; where?: 'prepare'; message: string }
  | { op: 'listening' }
  | { op: 'micError'; message: string }
  | { op: 'result'; kind: 'interim' | 'final'; text: string }
  | { op: 'flushed' }
  | { op: 'decode'; ms: number; audioMs: number }
  | { op: 'rx'; seconds: number; peak: number; speech: number; gain: number };

declare global {
  interface Window {
    CaptionNative?: CaptionNativeApi;
    __captionNative?: { emit(m: NativeEvent): void };
  }
}

/** 안드로이드 앱 안에서 열린 화면이면 앱 연결, 아니면 null */
export const nativeApp: CaptionNativeApi | null = typeof window !== 'undefined' ? (window.CaptionNative ?? null) : null;

const FLUSH_TIMEOUT_MS = 8000;
const listeners = new Set<(m: NativeEvent) => void>();
let ready: Promise<void> | null = null;

if (nativeApp) {
  let lastPct = -1;
  window.__captionNative = {
    emit(m) {
      if (m.op === 'progress') {
        const pct = Math.floor((m.loaded / m.total) * 10) * 10;
        if (pct !== lastPct) dlog(`모델 받기 ${(lastPct = pct)}%`);
      } else if (m.op === 'rx') dlog(`앱이 받은 소리: ${m.seconds.toFixed(1)}초, 최대 ${m.peak.toFixed(2)}, 말소리 감지 ${m.speech.toFixed(1)}초, 증폭 x${m.gain.toFixed(1)}`);
      else if (m.op !== 'result' && m.op !== 'decode') dlog(`앱: ${m.op}${'message' in m ? ` ${m.message}` : ''}`);
      listeners.forEach((l) => l(m));
    },
  };
}

/**
 * 안드로이드 앱 안 음성인식. 웹 '기기 안 인식'과 같은 모델(SenseVoice)을 앱이 폰 CPU 여러 코어로 돌리고,
 * 마이크도 안드로이드 음성인식용 입력으로 받는다. 음성은 폰 밖으로 나가지 않는다.
 */
export class NativeSttProvider implements SttProvider {
  readonly isSupported = !!nativeApp;

  /** 모델 받기·준비 (처음 한 번 약 240MB). 진행률은 onProgress로. */
  static prepare(onProgress?: (phase: ModelPhase, fraction: number) => void): Promise<void> {
    if (!ready) {
      ready = new Promise<void>((resolve, reject) => {
        const l = (m: NativeEvent) => {
          if (m.op === 'ready') {
            listeners.delete(l);
            resolve();
          } else if (m.op === 'error' && m.where === 'prepare') {
            listeners.delete(l);
            ready = null;
            reject(new Error(m.message));
          }
        };
        listeners.add(l);
        nativeApp!.prepare();
      });
    }
    if (onProgress) {
      const l = (m: NativeEvent) => {
        if (m.op === 'progress') onProgress('download', m.loaded / m.total);
        if (m.op === 'loading') onProgress('loading', 1);
      };
      listeners.add(l);
      const off = () => listeners.delete(l);
      ready.then(off, off);
    }
    return ready;
  }

  private running = false;
  private lastInterim = '';
  private readonly listener = (m: NativeEvent) => this.onNative(m);
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
  /** 최근 10초 동안 앱이 인식에 넣은 소리 (진단용) */
  recentAudio(): Int16Array | null {
    const b64 = nativeApp?.recentAudio?.();
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }
  onDiag(cb: (e: SttDiag) => void) {
    this.diagCb = cb;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      await NativeSttProvider.prepare();
    } catch (e) {
      const message = `음성인식 모델을 준비하지 못했습니다: ${(e as Error).message}`;
      this.errorCb({ fatal: true, code: 'model', message });
      throw new Error(message);
    }
    // 마이크 권한을 묻고(처음 한 번) 켠다
    await new Promise<void>((resolve, reject) => {
      const l = (m: NativeEvent) => {
        if (m.op === 'listening') {
          listeners.delete(l);
          resolve();
        } else if (m.op === 'micError') {
          listeners.delete(l);
          this.errorCb({ fatal: true, code: 'mic', message: m.message });
          reject(new Error(m.message));
        }
      };
      listeners.add(l);
      nativeApp!.start();
    });
    this.running = true;
    listeners.add(this.listener);
    this.diagCb({ type: 'listening' });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // 말하던 문장까지 확정한 뒤 끝낸다
    const flushed = await new Promise<boolean>((resolve) => {
      const l = (m: NativeEvent) => {
        if (m.op !== 'flushed') return;
        listeners.delete(l);
        resolve(true);
      };
      listeners.add(l);
      setTimeout(() => {
        listeners.delete(l);
        resolve(false);
      }, FLUSH_TIMEOUT_MS);
      nativeApp!.stop();
    });
    listeners.delete(this.listener);
    const t = this.lastInterim.trim();
    this.lastInterim = '';
    if (!flushed && t) this.finalCb(t); // 마무리가 늦으면 마지막 중간 결과를 그대로 확정
    this.diagCb({ type: 'stopped' });
  }

  private onNative(m: NativeEvent) {
    switch (m.op) {
      case 'result':
        if (m.kind === 'interim') {
          this.lastInterim = m.text;
          this.interimCb(m.text);
        } else {
          dlog(`인식 결과: "${m.text}"`);
          this.lastInterim = '';
          this.finalCb(m.text);
        }
        break;
      case 'decode':
        this.diagCb({ type: 'decode', detail: `${Math.round(m.ms)}/${Math.round(m.audioMs)}` });
        break;
      case 'micError':
        // 듣는 중에 마이크가 끊긴 경우
        this.running = false;
        listeners.delete(this.listener);
        this.diagCb({ type: 'error', detail: m.message });
        this.errorCb({ fatal: true, code: 'mic', message: m.message });
        break;
      case 'error':
        this.diagCb({ type: 'error', detail: m.message });
        this.errorCb({ fatal: false, code: 'engine', message: m.message });
        break;
    }
  }
}
