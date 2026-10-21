/**
 * 종단간 암호화 (AES-256-GCM, WebCrypto). 브라우저와 Node.js(22+)에서 같은 코드로 동작한다.
 * 키는 노트북이 방마다 만들고, 참석자에게는 QR 주소의 # 뒤(서버로 전송되지 않는 부분)로만 전달된다.
 * 형식: base64url(iv 12바이트 ‖ 암호문+태그)
 */

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function toB64url(bytes: Uint8Array): string {
  // 큰 메시지(늦게 들어온 참석자의 전체 이력 등)에서 인자 개수 한도를 넘지 않도록 나눠 변환
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 새 키 (base64url 문자열) */
export function generateE2eKey(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomId(bytes = 16): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function importE2eKey(keyB64: string): Promise<Key> {
  const raw = fromB64url(keyB64);
  if (raw.length !== 32) throw new Error('invalid key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function e2eEncrypt(key: Key, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64url(out);
}

/** 위조·손상된 데이터면 예외 */
export async function e2eDecrypt(key: Key, data: string): Promise<string> {
  const buf = fromB64url(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  return new TextDecoder().decode(pt);
}

export type E2eKey = Key;
