import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WorkerIn, WorkerOut } from './sttWorker.js';

/**
 * 노트북 안에서 도는 한국어 음성인식 (sherpa-onnx + SenseVoice + Silero VAD).
 * 인식은 작업 스레드(sttWorker)에서 하고, 여기서는 연결별 세션과 결과 전달만 맡는다.
 * 모델은 models/ko-sensevoice/ 에 둔다 (scripts/download-model.mjs가 받아 준다).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const MODEL_DIR = resolve(process.env.STT_MODEL_DIR ?? join(here, '../../../models/ko-sensevoice'));
const MODEL_FILES = ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'] as const;

// 소스 실행(tsx)이면 .ts, 배포 패키지(esbuild 묶음)면 server.mjs 옆의 stt-worker.mjs
const WORKER_URL = import.meta.url.endsWith('.ts')
  ? new URL('./sttWorker.ts', import.meta.url)
  : new URL('./stt-worker.mjs', import.meta.url);

let worker: Worker | null = null;
let ready = false;
let loadError: string | null = null;
const sessions = new Map<number, SttSession>();

/** 엔진을 띄운다(모델 로딩 약 2~4초, 비동기). 모델 파일이 없으면 false. */
export function loadSttEngine(): boolean {
  if (worker) return !loadError;
  const missing = MODEL_FILES.filter((f) => !existsSync(join(MODEL_DIR, f)));
  if (missing.length) {
    loadError = `음성 모델 파일이 없습니다 (${MODEL_DIR}). 배포 패키지라면 압축을 다시 풀어 주세요. (개발 환경: "npm run model:download")`;
    return false;
  }
  worker = new Worker(WORKER_URL, { workerData: { modelDir: MODEL_DIR } });
  worker.on('message', (m: WorkerOut) => {
    switch (m.op) {
      case 'ready':
        ready = true;
        loadError = null;
        console.log('[stt] 음성인식 엔진 준비됨');
        break;
      case 'error':
        loadError = `음성인식 엔진 오류: ${m.message}`;
        console.error(`[stt] ${loadError}`);
        break;
      case 'result': {
        const s = sessions.get(m.id);
        if (m.kind === 'final') s?.onFinal(m.text);
        else s?.onInterim(m.text);
        break;
      }
      case 'flushed':
        sessions.get(m.id)?.resolveFlush();
        break;
    }
  });
  worker.on('error', (e) => {
    loadError = `음성인식 엔진이 멈췄습니다: ${e.message}`;
    ready = false;
    console.error(`[stt] ${loadError}`);
  });
  worker.unref();
  return true;
}

export function sttStatus(): { available: boolean; message?: string } {
  if (ready) return { available: true };
  return { available: false, message: loadError ?? '음성인식 엔진을 준비하는 중입니다. 잠시 후 다시 시도해 주세요.' };
}

export function stopSttEngine(): void {
  void worker?.terminate();
}

let nextId = 1;

/** 연결(송출 화면) 하나당 하나. PCM을 넣으면 중간/확정 결과를 콜백으로 준다. */
export class SttSession {
  private readonly id = nextId++;
  private flushWaiters: (() => void)[] = [];

  constructor(
    readonly onInterim: (text: string) => void,
    readonly onFinal: (text: string) => void,
  ) {
    if (!worker || !ready) throw new Error('STT engine not ready');
    sessions.set(this.id, this);
    this.post({ op: 'open', id: this.id });
  }

  /** 16kHz mono Int16 LE PCM */
  acceptPcm16(buf: Buffer): void {
    // 작업 스레드로 넘기기 위해 정렬된 새 버퍼로 복사 (Buffer는 큰 풀의 일부일 수 있음)
    const copy = new ArrayBuffer(buf.byteLength & ~1);
    new Uint8Array(copy).set(buf.subarray(0, copy.byteLength));
    worker!.postMessage({ op: 'audio', id: this.id, pcm: copy } satisfies WorkerIn, [copy]);
  }

  /** 말하던 문장까지 확정한 뒤 끝난다 */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      this.post({ op: 'flush', id: this.id });
    });
  }

  close(): void {
    this.post({ op: 'close', id: this.id });
    sessions.delete(this.id);
    this.resolveFlush();
  }

  resolveFlush(): void {
    const ws = this.flushWaiters;
    this.flushWaiters = [];
    ws.forEach((r) => r());
  }

  private post(m: WorkerIn) {
    worker?.postMessage(m);
  }
}
