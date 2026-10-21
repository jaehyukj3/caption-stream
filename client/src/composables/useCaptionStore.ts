import { computed, reactive } from 'vue';
import type { CaptionLine, ServerMessage } from '@caption/shared';

/**
 * 자막 상태. 송출자 화면, 수신자 화면, PiP 창이 같은 객체를 공유한다.
 * 서버 메시지를 그대로 넣으면 상태가 갱신된다.
 */
export function createCaptionStore() {
  const state = reactive({
    lines: [] as CaptionLine[],
    interim: '',
    ended: false,
    viewerCount: 0,
  });

  const lastSeq = computed(() => state.lines.at(-1)?.seq ?? 0);

  function addLines(lines: CaptionLine[]) {
    const last = lastSeq.value;
    // 재연결 중 중복 수신 방지: seq가 더 큰 것만 붙인다
    const fresh = lines.filter((l) => l.seq > last);
    if (fresh.length) state.lines.push(...fresh);
  }

  function apply(msg: ServerMessage) {
    switch (msg.type) {
      case 'joined':
        state.ended = msg.ended;
        break;
      case 'history':
        addLines(msg.lines);
        break;
      case 'final':
        addLines([msg.line]);
        state.interim = '';
        break;
      case 'interim':
        state.interim = msg.text;
        break;
      case 'viewerCount':
        state.viewerCount = msg.count;
        break;
      case 'sessionEnd':
        state.ended = true;
        state.interim = '';
        break;
    }
  }

  return { state, lastSeq, apply };
}

export type CaptionStore = ReturnType<typeof createCaptionStore>;
