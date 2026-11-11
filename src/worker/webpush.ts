// Web Push (RFC 8291 payload encryption + RFC 8292 VAPID) with WebCrypto only.
// Used solely to alert the intercessor. Payloads never contain prayer content.

import { b64u, concat, ecdhShared, hkdf, randomBytes, unb64u, utf8, type Bytes } from '../shared/crypto';

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Vapid {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateKey: string; // base64url, 32-byte scalar
  subject: string; // https: or mailto: contact for the push service
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

export function isValidSubscription(s: unknown): s is PushSubscriptionJSON {
  const sub = s as PushSubscriptionJSON;
  try {
    return (
      typeof sub?.endpoint === 'string' &&
      sub.endpoint.length < 2000 &&
      new URL(sub.endpoint).protocol === 'https:' &&
      unb64u(sub.keys.p256dh).length === 65 &&
      unb64u(sub.keys.auth).length === 16
    );
  } catch {
    return false;
  }
}

/** Encrypt a payload for one subscription (aes128gcm content coding). */
export async function encryptPayload(
  sub: PushSubscriptionJSON,
  plaintext: Uint8Array,
  local?: CryptoKeyPair, // injectable for tests
  salt: Bytes = randomBytes(16),
): Promise<Bytes> {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const keys = local ?? ((await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, ECDH, false, []);
  const ecdh = await ecdhShared(keys.privateKey, uaKey);

  const ikm = await hkdfBytes(ecdh, authSecret, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 marks the final record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ct);
}

async function hkdfBytes(ikm: Uint8Array, salt: Uint8Array, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm as Bytes, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as Bytes, info }, key, length * 8),
  );
}

export async function vapidAuthorization(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const pub = unb64u(vapid.publicKey);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(pub.subarray(1, 33)),
    y: b64u(pub.subarray(33, 65)),
    d: vapid.privateKey,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Returns the push service's HTTP status. 404 and 410 mean the subscription is dead. */
export async function sendPush(sub: PushSubscriptionJSON, payload: string, vapid: Vapid): Promise<number> {
  const body = await encryptPayload(sub, utf8(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}
