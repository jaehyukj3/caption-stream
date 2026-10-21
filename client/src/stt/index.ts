import { LocalSttProvider } from './LocalSttProvider';
import type { SttProvider } from './SttProvider';
import { WebSpeechProvider } from './WebSpeechProvider';

export type SttKind = 'local' | 'webspeech';

/**
 * 기본은 노트북 안의 로컬 엔진.
 * 비교·개발용으로 송출 주소에 ?stt=webspeech 를 붙이면 크롬 음성인식(Google 서버)을 쓴다.
 */
export function sttKindFromUrl(): SttKind {
  return new URLSearchParams(location.search).get('stt') === 'webspeech' ? 'webspeech' : 'local';
}

export function createSttProvider(kind: SttKind = sttKindFromUrl()): SttProvider {
  return kind === 'webspeech' ? new WebSpeechProvider('ko-KR') : new LocalSttProvider();
}
