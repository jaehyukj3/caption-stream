/**
 * 인식 결과 띄어쓰기 다듬기. SenseVoice는 조사·어미를 앞말과 떼어 내는 일이 잦다
 * ("바람 이 날 리며", "사랑 하 는 그대 와", "걸 어요").
 * 조사·어미는 한국어 맞춤법상 늘 앞말에 붙여 쓰므로, 홀로 떨어진 조사·어미 어절만 앞 어절에 붙인다.
 * 단어로도 흔히 쓰이는 것(가: 가다, 면: 국수, 이: 이것)은 잘못 붙일 수 있어 넣지 않았다.
 */
const SUFFIXES = new Set([
  // 조사
  ...['을', '를', '은', '는', '에', '에서', '의', '와', '과', '로', '으로', '께', '한테', '에게', '처럼', '까지', '부터', '이랑', '하고는'],
  // 어미
  ...['요', '어요', '아요', '어서', '아서', '었어요', '았어요', '었다', '았다', '었습니다', '았습니다', '습니다', '니다', '며', '으며', '리며', '리고', '으면'],
]);

const HANGUL_END = /[가-힣]$/;
const TRAILING_PUNCT = /[.,?!…~]+$/;

export function tidySpacing(text: string): string {
  const words = text.split(' ');
  const out: string[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    const core = w.replace(TRAILING_PUNCT, '');
    if (prev !== undefined && SUFFIXES.has(core) && HANGUL_END.test(prev)) out[out.length - 1] = prev + w;
    else out.push(w);
  }
  return out.join(' ');
}
