import { computed, shallowRef } from 'vue';
import type { CaptionLine, RoomStats } from '@caption/shared';
import type { SttDiag } from '../stt/SttProvider';
import { saveText, stamp } from '../utils/download';

export interface LogEvent {
  t: number;
  kind: 'mic' | 'stt';
  type: string;
  detail?: string;
}

/** 이 시간보다 짧게 본 수신자는 '잠깐 들어온 사람'으로 따로 센다 */
const BRIEF_VIEW_MS = 60_000;

/**
 * 테스트 기록: 마이크 상태·음성인식 끊김을 모아 두었다가 방 이용 통계·자막과 함께 파일로 저장한다.
 * 모두 송출 화면 메모리에만 있고, 송출자가 저장 버튼을 누를 때만 파일이 된다.
 */
export function useSessionLog(meta: { code: string; mode: 'laptop' | 'web'; engine: string }) {
  const events = shallowRef<LogEvent[]>([]);
  const push = (e: Omit<LogEvent, 't'>) => (events.value = [...events.value, { t: Date.now(), ...e }]);

  function mic(state: string) {
    push({ kind: 'mic', type: state });
  }
  function stt(e: SttDiag) {
    push({ kind: 'stt', type: e.type, detail: e.detail });
  }

  /** 마이크가 켜져 있는데 음성인식이 멈춰 있던 구간 (자동 재시작·재연결 사이) */
  const gaps = computed(() => {
    const out: { at: number; ms: number }[] = [];
    let micOn = false;
    let stoppedAt: number | null = null;
    for (const e of events.value) {
      if (e.kind === 'mic') {
        micOn = e.type === 'running';
        if (!micOn) stoppedAt = null;
      } else if (micOn && e.type === 'stopped') {
        stoppedAt ??= e.t;
      } else if (e.type === 'listening' && stoppedAt !== null) {
        out.push({ at: stoppedAt, ms: e.t - stoppedAt });
        stoppedAt = null;
      }
    }
    return out;
  });

  const sttSummary = computed(() => ({
    restarts: gaps.value.length,
    longestGapMs: Math.max(0, ...gaps.value.map((g) => g.ms)),
    totalGapMs: gaps.value.reduce((a, g) => a + g.ms, 0),
    errors: events.value.filter((e) => e.kind === 'stt' && e.type === 'error' && e.detail !== 'no-speech').length,
  }));

  function viewerSummary(stats: RoomStats | null) {
    if (!stats) return null;
    const watched = stats.viewers.filter((v) => v.totalMs >= BRIEF_VIEW_MS);
    return {
      unique: stats.viewers.length,
      watched: watched.length,
      peak: Math.max(0, ...stats.timeline.map(([, n]) => n)),
      avgMinutes: watched.length ? watched.reduce((a, v) => a + v.totalMs, 0) / watched.length / 60_000 : 0,
    };
  }

  /** 분석용 JSON 파일로 저장 */
  function download(stats: RoomStats | null, lines: readonly CaptionLine[], extra: Record<string, unknown> = {}) {
    const data = {
      format: 'caption-stream-log/1',
      ...meta,
      exportedAt: Date.now(),
      summary: { stt: sttSummary.value, viewers: viewerSummary(stats), captionLines: lines.length },
      sttGaps: gaps.value,
      events: events.value,
      roomStats: stats,
      captions: lines,
      ...extra,
    };
    saveText(`test-log_${meta.code}_${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json');
  }

  return { events, mic, stt, gaps, sttSummary, viewerSummary, download };
}

export type SessionLog = ReturnType<typeof useSessionLog>;
