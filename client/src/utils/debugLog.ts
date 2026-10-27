import { shallowRef } from 'vue';

/**
 * 폰에서 원인을 확인하기 위한 진단 기록. 송출 화면의 '진단 정보'에 시간순으로 보인다.
 * (원격으로 개발자 도구를 열 수 없는 기기에서 어느 단계까지 갔는지 보려는 용도)
 */
export const debugLines = shallowRef<string[]>([]);

export function dlog(message: string): void {
  const d = new Date();
  const t = `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 1)}`;
  debugLines.value = [...debugLines.value.slice(-39), `${t} ${message}`];
}
