import { describe, expect, it } from 'vitest';
import * as c from '../src/shared/crypto';
import { encryptPayload, isValidSubscription, vapidAuthorization } from '../src/worker/webpush';

describe('crypto', () => {
  it('compresses and restores public keys', async () => {
    for (let i = 0; i < 8; i++) {
      const keys = await c.generateStationKeys();
      const raw = await c.rawPublic(keys.ecdh.publicKey);
      const small = c.compressPoint(raw);
      expect(small.length).toBe(33);
      expect(c.decompressPoint(small)).toEqual(raw);
    }
    expect((await c.stationCode(await c.generateStationKeys())).length).toBe(44);
  });

  it('rejects a code that is not a point on the curve', async () => {
    // Roughly half of all x values have no matching y on P-256.
    let rejected = 0;
    for (let x = 1; x <= 32; x++) {
      const candidate = new Uint8Array(33);
      candidate[0] = 2;
      candidate[32] = x;
      try {
        c.decompressPoint(candidate);
      } catch {
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(4);
    expect(rejected).toBeLessThan(28);
    await expect(c.stationIdFromCode('not-a-key')).rejects.toThrow();
  });

  it('wraps a session key only the station can open', async () => {
    const station = await c.generateStationKeys();
    const other = await c.generateStationKeys();
    const k = c.randomBytes(32);
    const wrapped = await c.wrapSessionKey(await c.stationCode(station), k);
    expect(await c.unwrapSessionKey(station, wrapped)).toEqual(k);
    await expect(c.unwrapSessionKey(other, wrapped)).rejects.toThrow();
  });

  it('seals text and binds it to its context', async () => {
    const keys = await c.deriveSessionKeys(c.randomBytes(32));
    const sealed = await c.seal(keys.enc, c.requestContext('abc'), 'pray for me 🙏');
    expect(await c.open(keys.enc, c.requestContext('abc'), sealed)).toBe('pray for me 🙏');
    await expect(c.open(keys.enc, c.requestContext('other'), sealed)).rejects.toThrow();
    await expect(c.open(keys.enc, c.messageContext('abc', 'host'), sealed)).rejects.toThrow();
    const stranger = await c.deriveSessionKeys(c.randomBytes(32));
    await expect(c.open(stranger.enc, c.requestContext('abc'), sealed)).rejects.toThrow();
    expect(keys.auth).toHaveLength(43);
  });

  it('signs and verifies login challenges', async () => {
    const keys = await c.generateStationKeys();
    const pub = c.b64u(await c.rawPublic(keys.sign.publicKey));
    const sig = await c.signText(keys.sign.privateKey, 'hello');
    expect(await c.verifyText(pub, 'hello', sig)).toBe(true);
    expect(await c.verifyText(pub, 'hullo', sig)).toBe(false);
    expect(await c.verifyText('junk', 'hello', sig)).toBe(false);
  });

  it('backs up and restores station keys with a passphrase', async () => {
    const keys = await c.generateStationKeys();
    const file = await c.exportBackup(keys, 'correct horse');
    expect(file).not.toContain('"d"');
    const restored = await c.importBackup(file, 'correct horse');
    expect(await c.stationCode(restored)).toBe(await c.stationCode(keys));
    const wrapped = await c.wrapSessionKey(await c.stationCode(keys), c.randomBytes(32));
    await expect(c.unwrapSessionKey(restored, wrapped)).resolves.toHaveLength(32);
    const sig = await c.signText(restored.sign.privateKey, 'x');
    expect(await c.verifyText(c.b64u(await c.rawPublic(keys.sign.publicKey)), 'x', sig)).toBe(true);
    await expect(c.importBackup(file, 'wrong')).rejects.toThrow(/passphrase/);
  });
});

describe('web push', () => {
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

  it('encrypts a payload the subscribed browser can decrypt (RFC 8291)', async () => {
    const ua = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPublic = await c.rawPublic(ua.publicKey);
    const auth = c.randomBytes(16);
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: c.b64u(uaPublic), auth: c.b64u(auth) } };
    expect(isValidSubscription(sub)).toBe(true);
    expect(isValidSubscription({ ...sub, endpoint: 'http://push.example/abc' })).toBe(false);

    const body = await encryptPayload(sub, c.utf8('{"body":"hi"}'));

    // Receiver side, written independently from the RFC.
    const salt = body.slice(0, 16);
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    const asPublic = body.slice(21, 86);
    const ct = body.slice(86);
    const asKey = await crypto.subtle.importKey('raw', asPublic, ECDH, false, []);
    const shared = await c.ecdhShared(ua.privateKey, asKey);
    const hk = async (ikm: Uint8Array, s: Uint8Array, info: Uint8Array, len: number) => {
      const key = await crypto.subtle.importKey('raw', ikm as c.Bytes, 'HKDF', false, ['deriveBits']);
      return new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s as c.Bytes, info: info as c.Bytes }, key, len * 8),
      );
    };
    const ikm = await hk(shared, auth, c.concat(c.utf8('WebPush: info\0'), uaPublic, asPublic), 32);
    const cek = await hk(ikm, salt, c.utf8('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hk(ikm, salt, c.utf8('Content-Encoding: nonce\0'), 12);
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
    expect(plain[plain.length - 1]).toBe(2);
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe('{"body":"hi"}');
  });

  it('signs a VAPID token the push service can verify', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKey = c.b64u(await c.rawPublic(pair.publicKey));
    const privateKey = ((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey).d!;
    const header = await vapidAuthorization('https://push.example/abc', { publicKey, privateKey, subject: 'https://prayer.test' });
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(publicKey);
    const [h, p, s] = token.split('.');
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, c.unb64u(s), c.utf8(`${h}.${p}`))).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(c.unb64u(p)));
    expect(claims.aud).toBe('https://push.example');
    expect(claims.sub).toBe('https://prayer.test');
  });
});
