import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STT_SAMPLE_RATE } from '@caption/shared';

/**
 * 노트북 안에서 도는 한국어 스트리밍 음성인식 (sherpa-onnx, Apache-2.0).
 * 모델은 models/ko-streaming/ 에 둔다 (scripts/download-model.mjs가 받아 준다).
 */

// sherpa-onnx-node는 타입 정의가 없어 쓰는 부분만 선언
interface SherpaStream {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}
interface SherpaResult {
  text: string;
  tokens: string[];
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  isReady(s: SherpaStream): boolean;
  decode(s: SherpaStream): void;
  getResult(s: SherpaStream): SherpaResult;
  isEndpoint(s: SherpaStream): boolean;
  reset(s: SherpaStream): void;
}

const here = dirname(fileURLToPath(import.meta.url));
export const MODEL_DIR = resolve(process.env.STT_MODEL_DIR ?? join(here, '../../../models/ko-streaming'));
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'] as const;

let recognizer: SherpaRecognizer | null = null;
let loadError: string | null = null;

/** 모델을 한 번만 올린다(약 1~2초). 실패 사유는 sttStatus()로 확인. */
export function loadSttEngine(): boolean {
  if (recognizer) return true;
  const missing = MODEL_FILES.filter((f) => !existsSync(join(MODEL_DIR, f)));
  if (missing.length) {
    loadError = `음성 모델 파일이 없습니다 (${MODEL_DIR}). 배포 패키지라면 압축을 다시 풀어 주세요. (개발 환경: "npm run model:download")`;
    return false;
  }
  try {
    const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
    recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(MODEL_DIR, 'encoder.int8.onnx'),
          decoder: join(MODEL_DIR, 'decoder.onnx'),
          joiner: join(MODEL_DIR, 'joiner.int8.onnx'),
        },
        tokens: join(MODEL_DIR, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      // 말을 멈추고 이 시간(초)이 지나면 문장 확정
      rule1MinTrailingSilence: 2.0, // 아무 말도 없었을 때
      rule2MinTrailingSilence: 0.9, // 말한 뒤 쉼
      rule3MinUtteranceLength: 15, // 쉬지 않고 계속 말해도 15초마다 끊어서 확정
    }) as SherpaRecognizer;
    loadError = null;
    return true;
  } catch (e) {
    loadError = `음성인식 엔진을 불러오지 못했습니다: ${(e as Error).message}`;
    return false;
  }
}

export function sttStatus(): { available: boolean; message?: string } {
  return recognizer ? { available: true } : { available: false, message: loadError ?? '음성인식 엔진이 준비되지 않았습니다.' };
}

/**
 * 연결(송출 화면) 하나당 하나. PCM을 넣으면 중간/확정 결과를 콜백으로 준다.
 * 디코딩은 100ms 오디오당 수 ms 수준이라 메인 스레드에서 처리한다.
 */
export class SttSession {
  private stream: SherpaStream;
  private lastText = '';

  constructor(
    private readonly onInterim: (text: string) => void,
    private readonly onFinal: (text: string) => void,
  ) {
    if (!recognizer) throw new Error('STT engine not loaded');
    this.stream = recognizer.createStream();
  }

  /** 16kHz mono Int16 PCM */
  acceptPcm16(pcm: Int16Array): void {
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768;
    this.stream.acceptWaveform({ samples, sampleRate: STT_SAMPLE_RATE });
    this.decode();
  }

  /** 말하던 문장을 확정. 남은 오디오를 마저 처리하기 위해 짧은 무음을 붙인다. */
  flush(): void {
    const r = recognizer!;
    this.stream.acceptWaveform({ samples: new Float32Array(STT_SAMPLE_RATE * 0.5), sampleRate: STT_SAMPLE_RATE });
    this.stream.inputFinished();
    while (r.isReady(this.stream)) r.decode(this.stream);
    const text = textOf(r.getResult(this.stream));
    if (text) this.onFinal(text);
    this.lastText = '';
    this.stream = r.createStream();
  }

  private decode(): void {
    const r = recognizer!;
    while (r.isReady(this.stream)) r.decode(this.stream);
    const text = textOf(r.getResult(this.stream));

    if (r.isEndpoint(this.stream)) {
      if (text) this.onFinal(text);
      r.reset(this.stream);
      this.lastText = '';
      return;
    }
    if (text !== this.lastText) {
      this.lastText = text;
      this.onInterim(text);
    }
  }
}

/** result.text는 띄어쓰기가 빠지므로 토큰(앞에 공백 포함)을 이어 붙여 복원한다 */
function textOf(r: SherpaResult): string {
  return (r.tokens?.length ? r.tokens.join('') : r.text).replace(/\s+/g, ' ').trim();
}
