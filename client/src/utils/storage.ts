/** localStorage/sessionStorage는 사생활 보호 모드 등에서 예외를 던질 수 있어 감싼다. */
export function readJson<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(storage: Storage, key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 실패는 무시: 편의 기능일 뿐 */
  }
}
