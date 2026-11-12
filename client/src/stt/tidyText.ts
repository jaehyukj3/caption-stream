/**
 * 인식 결과 띄어쓰기 다듬기 (SenseVoice용). SenseVoice는 낱말을 음절 단위로 떼어 내는 일이 잦다
 * ("사업 장 내 에", "피해 를 주 거나", "보 시는 것 처럼"): 강당 녹음에서 한 글자 어절이 28% (자연스러운 한국어는 7%).
 *  - 홀로 떨어진 조사·어미·접미사는 앞말에 붙인다 ("피해 를" → "피해를", "사업 장" → "사업장")
 *  - 그 밖의 한 글자도, 혼자 쓰는 낱말이 아니면 뒷말에 붙인다 ("보 유한" → "보유한", "주 거나" → "주거나")
 * 결과: 한 글자 어절 28% → 8%. 띄어쓰기가 맞는 문장(갤럭시 변환 312어절)은 거의 바꾸지 않는다.
 * 폰·브라우저 음성인식 결과는 띄어쓰기가 맞으므로 쓰지 않는다.
 */
const SUFFIX = new Set(['을', '를', '은', '는', '이', '가', '에', '의', '와', '과', '로', '도', '만', '께', '요', '죠', '고', '며', '면', '서', '지', '게', '다', '데', '니', '듯', '든', '나', '랑', '적', '들', '님', '씩', '째', '쯤', '용', '상', '간', '장', '성', '화', '자', '점', '권', '부', '팀', '실', '과', '측', '량', '률', '형', '식', '법']);
const MULTI_SUFFIX = new Set(['에서', '으로', '에게', '한테', '처럼', '까지', '부터', '이랑', '어요', '아요', '어서', '아서', '었다', '았다', '습니다', '니다', '으며', '리며', '리고', '으면', '거나', '는데', '지만', '도록', '이다', '입니다', '이라고', '라고', '에는', '에도', '으로는', '에만', '에서는', '이라는', '라는', '에요', '예요', '이에요', '인데', '이고', '이며', '로서', '으로서']);
/** 혼자 쓰는 한 글자 낱말 (붙이지 않음) */
const STANDALONE = new Set(['그', '이', '저', '수', '것', '거', '및', '등', '안', '못', '더', '또', '꼭', '잘', '좀', '왜', '뭐', '제', '내', '네', '예', '각', '몇', '한', '두', '세', '첫', '새', '총', '약', '별', '딱', '쭉', '즉', '곧', '늘', '막', '꽤', '참', '아', '어', '음', '자', '뭘', '날', '때', '데', '중', '전', '후', '위', '앞', '뒤', '옆', '밖', '속', '말', '일', '분', '번', '건', '개', '년', '월', '시', '명', '원', '살', '초', '회', '차', '층', '대',
  // 한 글자 명사·꾸밈말 ("집 아이", "큰 실수")
  // 홀로 쓰는 '다'(모두), 앞으로의 일('할 거예요', '될 수'), 부르는 말·감탄 ('야', '와', '나 아직')
  '다', '할', '될', '볼', '갈', '올', '살', '알', '쓸', '탈', '돼', '야', '와', '나', '요',
  '본', '된', '난', '낼', '쓴', '온', '준', '걸', '줘', '써', '봐', '펴', '삶', '피', '바', '창', '너', '떠', '먼', '백', '앱', '순', '법',
  '집', '물', '돈', '길', '손', '눈', '몸', '꿈', '빛', '산', '강', '땅', '밥', '책', '문', '방', '옷', '표', '값', '힘', '맛', '곳', '팔', '발', '목', '귀', '입', '코', '배', '해', '달', '별', '불', '술', '차', '뜻', '글', '꽃', '잠', '키', '역', '반', '편', '쪽', '줄', '큰', '긴', '센', '옛', '온', '헌', '딴', '웬', '왠', '뭔', '첫']);
const HANGUL = /^[가-힣]+$/;
/** '-ㄴ/-ㄹ' 꾸밈 끝 ("하신", "본", "할"): 뒤의 '적'·'데'·'지'는 따로 쓰는 말 ("본 적", "갈 데") */
const MODIFIER_END = /(신|은|는|던|든|본|한|된|할|을|볼|갈|올|난|쓴|간|온|준|인)$/;
const AFTER_MODIFIER = new Set(['적', '데', '지', '줄', '바', '척', '뻔', '게', '만큼', '대로', '듯']);
const TRAILING_PUNCT = /[.,?!…~]+$/;

export function tidySpacing(text: string): string {
  const words = text.split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const cur = words[i]!;
    const core = cur.replace(TRAILING_PUNCT, '');
    const prev = out[out.length - 1];
    const n = [...core].length;
    const isSuffix = (n === 1 && SUFFIX.has(core) && !STANDALONE.has(core)) || MULTI_SUFFIX.has(core);
    if (prev !== undefined && /[가-힣]$/.test(prev) && HANGUL.test(core) && isSuffix && !(AFTER_MODIFIER.has(core) && MODIFIER_END.test(prev))) {
      out[out.length - 1] = prev + cur; // 조사·어미 → 앞말
      continue;
    }
    const next = words[i + 1];
    const dependent = prev !== undefined && AFTER_MODIFIER.has(core) && MODIFIER_END.test(prev);
    if (!dependent && n === 1 && core === cur && HANGUL.test(core) && !STANDALONE.has(core) && next && /^[가-힣]/.test(next) && !STANDALONE.has(next.replace(TRAILING_PUNCT, ''))) {
      words[i + 1] = cur + next; // 그 밖의 한 글자 → 뒷말
      continue;
    }
    out.push(cur);
  }
  return out.map(splitMerged).join(' ');
}

/**
 * 붙어 나온 낱말 떼기: SenseVoice는 반대로 띄어쓰기를 빼먹기도 한다 ("거리를둘이", "흩날리는벚꽃잎이").
 * 어절을 끝내는 '를'·'는' 뒤에 낱말이 더 붙어 있으면 뗀다. '는데'·'는지'처럼 이어지는 어미는 그대로 둔다.
 */
const SPLIT_AFTER = /([가-힣]{1,}?(?:를|는))(?=[가-힣]{2,})/g;
const CONTINUES = /^(데|지|가|구|군|다|걸|커|요|게|거|건|대|냐|듯|한|바|척|만|것|줄|까|래|텐|테|니|이야)/;
/** 자주 쓰는 꾸밈말: 뒤에 붙어 나온 낱말을 뗀다 ("자꾸겹쳐" → "자꾸 겹쳐"). '-하다/-되다'로 이어지면 그대로 ("계속되는") */
const ADVERB = /^(자꾸|너무|정말|진짜|아주|다시|이제|그냥|많이|조금|항상|벌써|아직|먼저|모두|혹시|아마|가장|제일|굉장히|빨리|천천히|같이|서로|이미|결국|특히|보통|원래|거의|전혀|별로|약간|그대로)(?=[가-힣]{2,})/;
const VERBALIZE = /^(하|되|돼|해|했|됐|씩|히|요)/;
function splitMerged(word: string): string {
  if (!/^[가-힣]{4,}/.test(word)) return word;
  let out = '';
  let rest = word;
  const adv = ADVERB.exec(rest);
  if (adv) {
    const tail = rest.slice(adv[1]!.length);
    const first = tail[0]!;
    const particle = SUFFIX.has(first) || [...MULTI_SUFFIX].some((x) => tail.startsWith(x));
    if (!particle && !VERBALIZE.test(tail)) {
      out = adv[1]! + ' ';
      rest = tail;
    }
  }
  for (;;) {
    SPLIT_AFTER.lastIndex = 0;
    const m = SPLIT_AFTER.exec(rest);
    if (!m) break;
    const cut = m.index + m[1]!.length;
    const tail = rest.slice(cut);
    if (CONTINUES.test(tail)) {
      out += rest.slice(0, cut);
      rest = tail;
      continue;
    }
    out += rest.slice(0, cut) + ' ';
    rest = tail;
  }
  return out + rest;
}

/**
 * 군말 지우기: 낱말로 홀로 쓰인 "음", "어" 같은 머뭇거림을 뺀다 (읽기 좋은 자막용).
 * 발화를 그대로 남겨야 하는 기록(연구 인터뷰, 감사 기록)에는 끄고 쓴다.
 */
const FILLERS = new Set(['음', '음음', '어', '어어', '으', '흠', '엄', '에', '아']);
export function dropFillers(text: string): string {
  return text
    .split(' ')
    .filter((w) => !FILLERS.has(w.replace(/[.,?!…~]+$/, '')))
    .join(' ')
    .trim();
}
