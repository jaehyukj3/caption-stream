/**
 * 강의 후 설문. 참석자 화면에서 응답하고, 응답은 자막과 같은 경로(중계 시 암호화)로
 * 송출 화면에만 전달된다. 서버에는 저장하지 않는다.
 *
 * 구성: 자막 경험 5문항(5점) + SUS 10문항(System Usability Scale, 5점) + 선택 정보 + 자유 의견
 */

export type SurveyQuestion =
  | { id: string; kind: 'likert'; text: string; group: 'experience' | 'sus' }
  | { id: string; kind: 'choice'; text: string; options: string[] }
  | { id: string; kind: 'text'; text: string; maxLength: number };

export const LIKERT_LABELS = ['전혀 아니다', '아니다', '보통이다', '그렇다', '매우 그렇다'] as const;

export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  { id: 'e1', kind: 'likert', group: 'experience', text: '자막이 강의 내용을 이해하는 데 도움이 되었다.' },
  { id: 'e2', kind: 'likert', group: 'experience', text: '자막이 대체로 정확했다.' },
  { id: 'e3', kind: 'likert', group: 'experience', text: '자막이 말하는 속도를 잘 따라왔다(많이 늦지 않았다).' },
  { id: 'e4', kind: 'likert', group: 'experience', text: '휴대폰으로 자막을 보기 편했다(글자 크기, 화면 등).' },
  { id: 'e5', kind: 'likert', group: 'experience', text: '다음 강의에서도 이 자막을 쓰고 싶다.' },

  // SUS (Brooke, 1996) 한국어 문항 — 홀수는 긍정, 짝수는 부정 문항
  { id: 's1', kind: 'likert', group: 'sus', text: '이 자막 서비스를 자주 사용하고 싶다.' },
  { id: 's2', kind: 'likert', group: 'sus', text: '이 서비스는 불필요하게 복잡하다.' },
  { id: 's3', kind: 'likert', group: 'sus', text: '이 서비스는 사용하기 쉬웠다.' },
  { id: 's4', kind: 'likert', group: 'sus', text: '이 서비스를 사용하려면 다른 사람의 도움이 필요할 것 같다.' },
  { id: 's5', kind: 'likert', group: 'sus', text: '이 서비스의 기능들이 잘 어우러져 있다.' },
  { id: 's6', kind: 'likert', group: 'sus', text: '이 서비스에는 앞뒤가 맞지 않는 부분이 많다.' },
  { id: 's7', kind: 'likert', group: 'sus', text: '대부분의 사람들이 이 서비스를 금방 익힐 것이다.' },
  { id: 's8', kind: 'likert', group: 'sus', text: '이 서비스는 사용하기 번거롭다.' },
  { id: 's9', kind: 'likert', group: 'sus', text: '이 서비스를 사용하면서 자신감이 있었다.' },
  { id: 's10', kind: 'likert', group: 'sus', text: '이 서비스를 쓰기 전에 많은 것을 배워야 했다.' },

  { id: 'hearing', kind: 'choice', text: '청각 상태 (선택)', options: ['청각장애', '난청(보청기 등)', '해당 없음', '응답하지 않음'] },
  { id: 'age', kind: 'choice', text: '연령대 (선택)', options: ['20대 이하', '30대', '40대', '50대', '60대 이상', '응답하지 않음'] },
  { id: 'usage', kind: 'choice', text: '자막을 어떻게 보셨나요? (선택)', options: ['자막을 주로 봤다', '강사 말과 자막을 함께 봤다', '가끔 확인했다', '거의 보지 않았다'] },
  { id: 'comment', kind: 'text', text: '좋았던 점, 불편했던 점을 자유롭게 적어 주세요. (선택)', maxLength: 500 },
];

/** 참석자 한 명의 응답. 값: likert는 1~5, choice는 보기 번호(0부터), text는 문자열 */
export interface SurveyResponse {
  /** 참석자 기기에서 만든 익명 ID (같은 사람이 다시 내면 덮어쓴다) */
  respondentId: string;
  answers: Record<string, number | string>;
  submittedAt: number;
}

export const SURVEY_REQUIRED = SURVEY_QUESTIONS.filter((q) => q.kind === 'likert').map((q) => q.id);
export const MAX_SURVEY_RESPONSES = 1000;

/** 신뢰할 수 없는 입력을 검증해 정리된 응답으로 (형식이 틀리면 null) */
export function sanitizeSurveyAnswers(input: unknown): Record<string, number | string> | null {
  if (typeof input !== 'object' || input === null) return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, number | string> = {};
  for (const q of SURVEY_QUESTIONS) {
    const v = src[q.id];
    if (v === undefined || v === null || v === '') continue;
    if (q.kind === 'likert') {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 5) return null;
      out[q.id] = v as number;
    } else if (q.kind === 'choice') {
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= q.options.length) return null;
      out[q.id] = v as number;
    } else {
      if (typeof v !== 'string') return null;
      out[q.id] = v.slice(0, q.maxLength);
    }
  }
  return SURVEY_REQUIRED.every((id) => id in out) ? out : null;
}

/** SUS 점수(0~100). 홀수 문항은 (점수−1), 짝수 문항은 (5−점수)를 더해 2.5배 */
export function susScore(answers: Record<string, number | string>): number | null {
  let sum = 0;
  for (let i = 1; i <= 10; i++) {
    const v = answers[`s${i}`];
    if (typeof v !== 'number') return null;
    sum += i % 2 === 1 ? v - 1 : 5 - v;
  }
  return sum * 2.5;
}

/** 엑셀에서 바로 열 수 있는 CSV (UTF-8 BOM은 저장할 때 붙인다) */
export function surveyToCsv(responses: SurveyResponse[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['응답시각', ...SURVEY_QUESTIONS.map((q) => q.id), 'SUS점수'];
  const rows = responses.map((r) => [
    new Date(r.submittedAt).toLocaleString('ko-KR'),
    ...SURVEY_QUESTIONS.map((q) => {
      const v = r.answers[q.id];
      return q.kind === 'choice' && typeof v === 'number' ? q.options[v] : v;
    }),
    susScore(r.answers),
  ]);
  const legend = ['', '문항 안내', ...SURVEY_QUESTIONS.map((q) => `${q.id}: ${q.text}`)];
  return [header, ...rows].map((row) => row.map(esc).join(',')).join('\r\n') + '\r\n\r\n' + legend.map(esc).join('\r\n');
}
