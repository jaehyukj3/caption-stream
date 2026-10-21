import { reactive, watch, watchEffect } from 'vue';
import { readJson, writeJson } from '../utils/storage';

export type Theme = 'dark' | 'light';

const KEY = 'caption.prefs';
export const FONT_MIN = 14;
export const FONT_MAX = 56;

const systemTheme = (): Theme => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

/** 글자 크기·테마. 기기별로 기억하고 <html data-theme>에 반영한다. */
export function usePreferences(defaultFontSize = 22) {
  const prefs = reactive(
    readJson(localStorage, KEY, { fontSize: defaultFontSize, theme: systemTheme() as Theme }),
  );

  watch(prefs, (v) => writeJson(localStorage, KEY, v));
  watchEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  });

  return {
    prefs,
    biggerFont: () => (prefs.fontSize = Math.min(FONT_MAX, prefs.fontSize + 2)),
    smallerFont: () => (prefs.fontSize = Math.max(FONT_MIN, prefs.fontSize - 2)),
    toggleTheme: () => (prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'),
  };
}
