import { computed, ref, watch } from 'vue';
import { dropFillers, tidySpacing } from '../stt/tidyText';
import { readJson, writeJson } from '../utils/storage';

export interface DictEntry {
  from: string;
  to: string;
}

const KEY = 'caption.dictionary';
const FILLER_KEY = 'caption.dropFillers';
/** 인식기에 미리 알려 줄 용어 수 (많을수록 오히려 흐려진다: 문맥에 맞는 100개 이하 권장) */
const MAX_TERMS = 100;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * 용어 사전: "오인식 → 교정어". 브라우저(localStorage)에 저장된다.
 * - 한 번의 정규식으로 치환해 A→B, B→C 같은 연쇄 치환이 일어나지 않는다.
 * - 긴 단어를 먼저 매칭하고, 띄어쓰기 차이는 무시한다("쿠버 네티스"도 "쿠버네티스" 항목에 걸림).
 */
export function useDictionary() {
  const entries = ref<DictEntry[]>(readJson(localStorage, KEY, []));
  watch(entries, (v) => writeJson(localStorage, KEY, v), { deep: true });
  /** 군말(음, 어) 지우기. 기본은 켜짐 */
  const fillers = ref<boolean>(readJson(localStorage, FILLER_KEY, true));
  watch(fillers, (v) => writeJson(localStorage, FILLER_KEY, v));
  /** 사전의 교정어 = 이 강의의 용어. 폰 내장 음성인식에 미리 알려 준다 (지원하는 폰만) */
  const terms = computed(() => [...new Set(entries.value.map((e) => e.to.trim()).filter(Boolean))].slice(0, MAX_TERMS));

  const compiled = computed(() => {
    const map = new Map<string, string>();
    for (const e of entries.value) {
      const k = squash(e.from);
      if (k) map.set(k, e.to);
    }
    if (!map.size) return null;
    const pattern = [...map.keys()]
      .sort((a, b) => b.length - a.length)
      .map((k) => [...k].map(escapeRe).join('\\s*'))
      .join('|');
    return { re: new RegExp(pattern, 'g'), map };
  });

  /** tidy: SenseVoice 결과면 띄어쓰기를 다듬는다 (폰·브라우저 음성인식은 이미 맞아서 하지 않음) */
  function apply(raw: string, tidy = true): string {
    const spaced = tidy ? tidySpacing(raw) : raw;
    const text = fillers.value ? dropFillers(spaced) : spaced;
    const c = compiled.value;
    if (!c) return text;
    return text.replace(c.re, (m) => c.map.get(squash(m)) ?? m);
  }

  function add(from: string, to: string) {
    from = from.trim();
    to = to.trim();
    if (!from) return;
    const i = entries.value.findIndex((e) => squash(e.from) === squash(from));
    if (i >= 0) entries.value.splice(i, 1, { from, to });
    else entries.value.push({ from, to });
  }

  function remove(index: number) {
    entries.value.splice(index, 1);
  }

  return { entries, fillers, terms, apply, add, remove };
}
