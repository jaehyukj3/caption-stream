import { STT_SAMPLE_RATE } from '@caption/shared';
import { dlog } from '../utils/debugLog';

/**
 * 마이크 소리를 16kHz PCM(Int16)으로 100ms씩 잘라 보내는 AudioWorklet.
 * 노트북: AudioContext를 16kHz로 만들어 브라우저가 리샘플링한다.
 * 휴대폰: 일부 안드로이드 기기에서 브라우저 리샘플링이 소리를 망가뜨려, 기기 기본 속도로 받고
 *        여기서 직접 16kHz로 줄인다 (저역 통과 FIR 필터 후 솎아내기).
 *        단순 구간 평균은 자음(3~8kHz)을 깎고 8kHz 위 잡음을 접어 넣어 글자 오류율이 높았다
 *        (정답 있는 낭독 4문장, 48kHz 입력: 구간 평균 5.0% → FIR 0.8%).
 *
 * 입력 음량 자동 맞춤: 앰프 출력(크게 들어옴)이든 스피커 소리를 내장 마이크로
 * 받는 경우(작게 들어옴)든 인식에 알맞은 크기로 천천히 맞춘다.
 * 말소리 구간만 기준으로 삼아 조용할 때 잡음을 키우지 않는다.
 */
const WORKLET_SOURCE = `
const CHUNK = ${STT_SAMPLE_RATE / 10};
const TARGET = 0.08, MIN_GAIN = 0.5;
/** 3초마다 입력 크기·증폭 배율을 알린다 (진단용, sampleRate = 이 오디오 처리의 실제 속도) */
const STATS_EVERY = sampleRate * 3;
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    // floor: 이보다 작은 소리는 말소리로 보지 않음 · maxGain: 최대 증폭 배율
    this.floor = o.floor || 0.004; this.maxGain = o.maxGain || 8;
    this.buf = new Int16Array(CHUNK); this.n = 0; this.env = TARGET; this.gain = 1;
    this.sSum = 0; this.sPeak = 0; this.sN = 0;
    // sampleRate: 이 오디오 처리의 실제 속도 (AudioWorklet 전역 값)
    this.ratio = sampleRate / ${STT_SAMPLE_RATE}; this.pos = 0;
    // 16kHz로 줄이기 전 저역 통과 필터 (차단 7.2kHz, Blackman 창 windowed-sinc)
    const taps = (Math.round(this.ratio * 21) | 1);
    this.kernel = new Float32Array(taps);
    const m = (taps - 1) / 2, fc = 7200 / sampleRate;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const t = i - m;
      const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
      this.kernel[i] = sinc * win; sum += this.kernel[i];
    }
    for (let i = 0; i < taps; i++) this.kernel[i] /= sum;
    this.hist = new Float32Array(taps); this.h = 0;
  }
  push(s) {
    this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === CHUNK) {
      // 버퍼를 넘기면(transfer) 원래 배열은 길이 0이 되므로 새로 만든다
      this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
      this.buf = new Int16Array(CHUNK);
      this.n = 0;
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / ch.length);
      this.sSum += sum; this.sN += ch.length; if (rms > this.sPeak) this.sPeak = rms;
      if (this.sN >= STATS_EVERY) {
        this.port.postMessage({ stats: true, rms: Math.sqrt(this.sSum / this.sN), peak: this.sPeak, gain: this.gain });
        this.sSum = 0; this.sPeak = 0; this.sN = 0;
      }
      const FLOOR = this.floor, MAX_GAIN = this.maxGain;
      if (rms > FLOOR) this.env = this.env * 0.995 + rms * 0.005;
      const want = Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET / this.env));
      this.gain += (want - this.gain) * 0.01;
      const passThrough = Math.abs(this.ratio - 1) < 0.001;
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i] * this.gain));
        if (passThrough) { this.push(s); continue; }
        // 필터 이력에 넣고, 16kHz 한 샘플 간격마다 필터를 거친 값을 내보낸다
        const hist = this.hist, k = this.kernel, n = k.length;
        hist[this.h] = s; this.h = (this.h + 1) % n; this.pos++;
        if (this.pos >= this.ratio) {
          let acc = 0;
          for (let j = 0, idx = this.h; j < n; j++, idx = idx + 1 === n ? 0 : idx + 1) acc += hist[idx] * k[j];
          this.push(acc);
          this.pos -= this.ratio;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

/** 마이크를 켜지 못했을 때 사용자에게 보여 줄 설명 */
export function micErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return '마이크 권한이 거부되었습니다. 주소창 왼쪽 아이콘(또는 크롬 설정 → 사이트 설정 → 마이크)에서 허용해 주세요.';
  if (name === 'NotFoundError') return '마이크를 찾을 수 없습니다.';
  if (name === 'NotReadableError' || name === 'AbortError') return '다른 앱이 마이크를 쓰고 있어 켤 수 없습니다. 통화·녹음·음성 비서 앱을 닫고 다시 시도해 주세요.';
  return `마이크를 시작하지 못했습니다 (${name || 'Error'}: ${(e as Error)?.message ?? e})`;
}

export interface MicCapture {
  stop(): void;
  /** 최근 10초 동안 엔진으로 보낸 소리 (16kHz Int16, 진단용) */
  recent(): Int16Array;
}

const RECENT_CHUNKS = 100; // 100ms × 100 = 10초

/** 16kHz mono Int16 PCM → WAV 파일 */
export function pcmToWav(pcm: Int16Array, rate = STT_SAMPLE_RATE): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  header.setUint32(4, 36 + pcm.byteLength, true);
  w(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  w(36, 'data');
  header.setUint32(40, pcm.byteLength, true);
  return new Blob([header.buffer, pcm.buffer as ArrayBuffer], { type: 'audio/wav' });
}

export interface MicCaptureOptions {
  /**
   * 휴대폰용 설정. 안드로이드는 브라우저 자동 음량을 끄면 마이크 원음이 매우 작아(말소리가 잡음 수준)
   * 음성 구간 검출이 거의 안 된다. 휴대폰에서는 자동 음량을 켜고, 더 작은 소리도 더 크게 키운다.
   */
  mobile?: boolean;
}

/** 휴대폰·태블릿 브라우저인지 (마이크 처리 설정을 다르게 한다) */
export function isMobileDevice(): boolean {
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}

const dbfs = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x)) : -120);

/** 마이크를 켜고 16kHz Int16 PCM을 100ms마다 onChunk로 넘긴다 */
export async function startMicCapture(
  deviceId: string | null,
  onChunk: (pcm: ArrayBuffer) => void,
  options: MicCaptureOptions = {},
): Promise<MicCapture> {
  // 노트북: 브라우저 잡음 제거·자동 음량은 인식률을 떨어뜨려 끈다 (실측: 끝음절 누락, 오인식 증가)
  dlog(`마이크 요청 (getUserMedia, ${options.mobile ? '휴대폰 설정' : '노트북 설정'})`);
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: !!options.mobile,
    },
  });
  dlog(`마이크 열림: ${media.getAudioTracks()[0]?.label || '이름 없음'}`);
  const ctx = options.mobile ? new AudioContext() : new AudioContext({ sampleRate: STT_SAMPLE_RATE });
  dlog(`오디오 처리 생성: ${ctx.state}, ${ctx.sampleRate}Hz`);
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
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      // 휴대폰은 브라우저 자동 음량이 이미 크기를 맞춰 주므로 거의 키우지 않는다 (더 키우면 말소리 끝이 잘림).
      // 잡음 수준(-50dB) 아래는 기준에서 빼서 말 사이 잡음도 키우지 않는다.
      processorOptions: options.mobile ? { floor: 0.003, maxGain: 3 } : {},
    });
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer | { stats: true; rms: number; peak: number; gain: number }>) => {
      const d = ev.data;
      if (d instanceof ArrayBuffer) onChunk(d); // 아래에서 진단용으로 감싼다
      else dlog(`입력 크기: 평균 ${dbfs(d.rms)}dB, 최대 ${dbfs(d.peak)}dB, 증폭 x${d.gain.toFixed(1)}`);
    };
    // 그래프 끝(destination)에 이어져 있어야 처리가 돈다. 소리는 내지 않는다.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(media).connect(node).connect(mute).connect(ctx.destination);
    // 버튼을 누른 직후가 아니면 안드로이드 크롬이 오디오 처리를 멈춘 상태로 만든다.
    // 깨우기가 허용되지 않으면 기다리지 않고, 다음에 화면을 누를 때 깨운다.
    if (ctx.state === 'suspended') {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
      if (ctx.state === 'suspended') document.addEventListener('pointerdown', () => void ctx.resume(), { once: true });
    }
    dlog(`오디오 처리 상태: ${ctx.state}`);
  } catch (e) {
    dlog(`오디오 처리 실패: ${(e as Error)?.name} ${(e as Error)?.message}`);
    stop();
    throw e;
  }
  let chunks = 0;
  const first = onChunk;
  const ring: Int16Array[] = [];
  onChunk = (pcm) => {
    if (++chunks === 1) dlog('첫 소리 조각 받음');
    // 진단용으로 최근 소리를 복사해 둔다 (원본은 엔진으로 넘겨져 비워진다)
    ring.push(new Int16Array(pcm.slice(0)));
    if (ring.length > RECENT_CHUNKS) ring.shift();
    first(pcm);
  };
  const recent = () => {
    const out = new Int16Array(ring.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of ring) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  return { stop, recent };
}
