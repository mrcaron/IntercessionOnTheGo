// End-to-end encryption primitives shared by the rider page, the dashboard and
// (for hashing / signature checks only) the Worker. WebCrypto only, no deps.

export type Bytes = Uint8Array<ArrayBuffer>;

const te = new TextEncoder();
const td = new TextDecoder();

export function utf8(s: string): Bytes {
  return te.encode(s) as Bytes;
}

export function b64u(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function sha256(data: Uint8Array | string): Promise<Bytes> {
  const bytes = typeof data === 'string' ? utf8(data) : (data as Bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm as Bytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as Bytes, info: utf8(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// P-256 point compression. WebCrypto only speaks the 65-byte uncompressed form;
// the QR code carries the 33-byte compressed form so it stays small and bold.

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function toBig(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

function fromBig(n: bigint, len: number): Bytes {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r;
}

export function compressPoint(raw: Uint8Array): Bytes {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad public key');
  return concat(new Uint8Array([2 + (raw[64] & 1)]), raw.subarray(1, 33));
}

export function decompressPoint(c: Uint8Array): Bytes {
  if (c.length !== 33 || (c[0] !== 2 && c[0] !== 3)) throw new Error('bad public key');
  const x = toBig(c.subarray(1));
  if (x >= P) throw new Error('bad public key');
  const rhs = (((x * x) % P) * x + (P - 3n) * x + B) % P;
  let y = modpow(rhs, (P + 1n) / 4n, P);
  if ((y * y) % P !== rhs) throw new Error('bad public key');
  if (Number(y & 1n) !== (c[0] & 1)) y = P - y;
  return concat(new Uint8Array([4]), fromBig(x, 32), fromBig(y, 32));
}

// ---------------------------------------------------------------------------
// Station (intercessor) identity

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface StationKeys {
  ecdh: CryptoKeyPair; // decrypts session keys
  sign: CryptoKeyPair; // proves identity to the server at login
}

export async function generateStationKeys(): Promise<StationKeys> {
  return {
    ecdh: (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair,
    sign: (await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair,
  };
}

export async function rawPublic(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
}

/** The 44-character code that goes in the QR link (compressed public key). */
export async function stationCode(keys: StationKeys): Promise<string> {
  return b64u(compressPoint(await rawPublic(keys.ecdh.publicKey)));
}

/** Server-side name of a station: a fingerprint of the code, never the code itself. */
export async function stationIdFromCode(code: string): Promise<string> {
  const c = unb64u(code);
  decompressPoint(c); // validates
  return b64u((await sha256(c)).subarray(0, 16));
}

// ---------------------------------------------------------------------------
// Session key: made on the rider's phone, wrapped so only the station can open it

/** Layout: ephemeral public key (65) | iv (12) | AES-GCM(K) (48) */
export async function wrapSessionKey(code: string, k: Uint8Array): Promise<string> {
  const stationRaw = decompressPoint(unb64u(code));
  const stationPub = await crypto.subtle.importKey('raw', stationRaw, ECDH, false, []);
  const eph = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const ephRaw = await rawPublic(eph.publicKey);
  const shared = await ecdhShared(eph.privateKey, stationPub);
  const kek = await aesKey(await hkdf(shared, concat(ephRaw, stationRaw), 'mps/wrap', 32));
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, k as Bytes));
  return b64u(concat(ephRaw, iv, ct));
}

export async function unwrapSessionKey(keys: StationKeys, wrapped: string): Promise<Bytes> {
  const blob = unb64u(wrapped);
  if (blob.length !== 65 + 12 + 48) throw new Error('bad wrapped key');
  const ephRaw = blob.slice(0, 65);
  const iv = blob.slice(65, 77);
  const ct = blob.slice(77);
  const ephPub = await crypto.subtle.importKey('raw', ephRaw, ECDH, false, []);
  const stationRaw = await rawPublic(keys.ecdh.publicKey);
  const shared = await ecdhShared(keys.ecdh.privateKey, ephPub);
  const kek = await aesKey(await hkdf(shared, concat(ephRaw, stationRaw), 'mps/wrap', 32));
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct));
}

export async function ecdhShared(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Bytes> {
  // Cast: browser and Workers typings disagree on the name of the `public` field.
  const params = { name: 'ECDH', public: publicKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0];
  return new Uint8Array(await crypto.subtle.deriveBits(params, privateKey, 256));
}

function aesKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface SessionKeys {
  enc: CryptoKey; // encrypts everything either side writes
  auth: string; // rider's bearer token; the server stores only its hash
}

const EMPTY = new Uint8Array(0);

export async function deriveSessionKeys(k: Uint8Array): Promise<SessionKeys> {
  if (k.length !== 32) throw new Error('bad session key');
  return {
    enc: await aesKey(await hkdf(k, EMPTY, 'mps/enc', 32)),
    auth: b64u(await hkdf(k, EMPTY, 'mps/auth', 32)),
  };
}

/** Encrypt text. `context` binds the ciphertext to its place (session, kind, author). */
export async function seal(enc: CryptoKey, context: string, text: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(context) }, enc, utf8(text));
  return b64u(concat(iv, new Uint8Array(ct)));
}

export async function open(enc: CryptoKey, context: string, sealed: string): Promise<string> {
  const blob = unb64u(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: utf8(context) },
    enc,
    blob.slice(12),
  );
  return td.decode(pt);
}

export const requestContext = (sessionId: string) => `${sessionId}/request`;
export const messageContext = (sessionId: string, from: 'rider' | 'host') => `${sessionId}/msg/${from}`;

// ---------------------------------------------------------------------------
// Login: the dashboard signs a server challenge instead of using a password

export const loginChallengeText = (stationId: string, nonce: string) => `mps-login:${stationId}:${nonce}`;

export async function signText(key: CryptoKey, text: string): Promise<string> {
  return b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(text)));
}

export async function verifyText(publicRaw: string, text: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', unb64u(publicRaw), ECDSA, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(signature), utf8(text));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Passphrase-protected backup of the station keys

const PBKDF2_ITERATIONS = 310_000;

async function passKey(passphrase: string, salt: Bytes): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function exportBackup(keys: StationKeys, passphrase: string): Promise<string> {
  const plain = JSON.stringify({
    ecdh: await crypto.subtle.exportKey('jwk', keys.ecdh.privateKey),
    sign: await crypto.subtle.exportKey('jwk', keys.sign.privateKey),
  });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt), utf8(plain));
  return JSON.stringify({ app: 'mobile-prayer-station', v: 1, salt: b64u(salt), iv: b64u(iv), data: b64u(ct) });
}

export async function importBackup(file: string, passphrase: string): Promise<StationKeys> {
  const f = JSON.parse(file) as { v: number; salt: string; iv: string; data: string };
  if (f.v !== 1) throw new Error('Unknown backup version');
  let plain: string;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(f.iv) },
      await passKey(passphrase, unb64u(f.salt)),
      unb64u(f.data),
    );
    plain = td.decode(pt);
  } catch {
    throw new Error('Wrong passphrase or damaged backup');
  }
  const jwk = JSON.parse(plain) as { ecdh: JsonWebKey; sign: JsonWebKey };
  const pub = (j: JsonWebKey): JsonWebKey => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y });
  return {
    ecdh: {
      privateKey: await crypto.subtle.importKey('jwk', jwk.ecdh, ECDH, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('jwk', pub(jwk.ecdh), ECDH, true, []),
    },
    sign: {
      privateKey: await crypto.subtle.importKey('jwk', jwk.sign, ECDSA, true, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', pub(jwk.sign), ECDSA, true, ['verify']),
    },
  };
}
