import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as c from '../src/shared/crypto';
import { MAX_LIVE_PAGES, MAX_NEW_PAGES_PER_MINUTE, MAX_PAGES_PER_SHIFT, type HostIndex, type SessionView } from '../src/shared/types';
import type { Env } from '../src/worker/env';
import type { StationDO } from '../src/worker/station-do';

const testEnv = env as unknown as Env;
const ORIGIN = 'https://prayer.test';

let visitor = 0;
// Every call comes from a fresh IPv6 address, like the attacker in the issue.
const nextIp = () => `2001:db8:${(visitor >> 16).toString(16)}:${(visitor++ & 0xffff).toString(16)}::1`;

async function call(path: string, o: { body?: unknown; cookie?: string; method?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { Origin: ORIGIN, 'CF-Connecting-IP': nextIp() };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.cookie) headers.Cookie = o.cookie;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
}

/** `limits` apply to this station only, and are set the way the Worker's env vars would be. */
async function makeStation(limits: { live?: number; perMinute?: number; perShift?: number } = {}) {
  const keys = await c.generateStationKeys();
  const code = await c.stationCode(keys);
  const id = await c.stationIdFromCode(code);
  const setup = await call('/api/setup', {
    body: { setupToken: 'test-setup', code, sigPub: c.b64u(await c.rawPublic(keys.sign.publicKey)), name: 'Sam', place: '' },
  });
  expect(setup.status).toBe(201);
  const { nonce } = (await (await call('/api/login/challenge', { body: { station: id } })).json()) as { nonce: string };
  const login = await call('/api/login', {
    body: { station: id, nonce, signature: await c.signText(keys.sign.privateKey, c.loginChallengeText(id, nonce)) },
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const stub = testEnv.STATION.get(testEnv.STATION.idFromName(id));
  await runInDurableObject(stub, (inst: StationDO) => {
    const self = inst as unknown as { env: Env };
    self.env = {
      ...self.env,
      MAX_LIVE_PAGES: String(limits.live ?? MAX_LIVE_PAGES),
      MAX_NEW_PAGES_PER_MINUTE: String(limits.perMinute ?? MAX_NEW_PAGES_PER_MINUTE),
      MAX_PAGES_PER_SHIFT: String(limits.perShift ?? MAX_PAGES_PER_SHIFT),
    };
  });
  const duty = (on: boolean) => call('/api/host/duty', { body: { on }, cookie });
  expect((await duty(true)).status).toBe(200);
  return { keys, code, id, cookie, stub, duty };
}

async function openPage(station: { id: string; code: string }) {
  const k = c.randomBytes(32);
  const keys = await c.deriveSessionKeys(k);
  const res = await call('/api/sessions', {
    body: { station: station.id, authHash: c.b64u(await c.sha256(keys.auth)), wrappedKey: await c.wrapSessionKey(station.code, k) },
  });
  return { res, keys, view: res.ok ? ((await res.json()) as SessionView) : null };
}

const hostIndex = async (cookie: string) => (await (await call('/api/host', { cookie })).json()) as HostIndex;
const sessionStub = (id: string) => testEnv.SESSION.get(testEnv.SESSION.idFromName(id));
const statuses = async (station: Parameters<typeof openPage>[0], n: number) =>
  (await Promise.all(Array.from({ length: n }, () => openPage(station)))).map((p) => p.res.status);

describe('station intake budget', () => {
  it('refuses a flood from 60 different addresses (the confirmed probe)', async () => {
    const station = await makeStation(); // default limits
    const codes = await statuses(station, 60);
    expect(codes.filter((s) => s === 201)).toHaveLength(MAX_NEW_PAGES_PER_MINUTE);
    expect(codes.filter((s) => s === 429)).toHaveLength(60 - MAX_NEW_PAGES_PER_MINUTE);
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(MAX_NEW_PAGES_PER_MINUTE);
  });

  it('answers a refusal with 429 busy and a retry hint, and makes no page', async () => {
    const station = await makeStation({ perMinute: 1 });
    expect((await openPage(station)).res.status).toBe(201);
    const { res } = await openPage(station);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'busy' });
    expect(res.headers.get('retry-after')).toBe('60');
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(1);
  });

  it('still says off-duty (403) when the intercessor is off duty', async () => {
    const station = await makeStation();
    await station.duty(false);
    expect((await openPage(station)).res.status).toBe(403);
  });

  it('caps live pages, and an erased or expired page frees its slot', async () => {
    const station = await makeStation({ live: 2, perMinute: 100 });
    const a = await openPage(station);
    const b = await openPage(station);
    expect([a.res.status, b.res.status]).toEqual([201, 201]);
    expect((await openPage(station)).res.status).toBe(429);

    // Erase one: the slot comes back.
    expect((await call(`/api/sessions/${a.view!.id}`, { method: 'DELETE', cookie: station.cookie })).status).toBe(200);
    const c1 = await openPage(station);
    expect(c1.res.status).toBe(201);
    expect((await openPage(station)).res.status).toBe(429);

    // Let one expire: the alarm calls sessionGone and the slot comes back.
    const stub = sessionStub(b.view!.id);
    await runInDurableObject(stub, async (_, state) => {
      const meta = (await state.storage.get<{ expiresAt: number }>('meta'))!;
      await state.storage.put('meta', { ...meta, expiresAt: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await openPage(station)).res.status).toBe(201);
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(2);
  });

  it('caps pages per shift, and switching duty on starts a new shift', async () => {
    const station = await makeStation({ perShift: 2, perMinute: 100 });
    const first = await statuses(station, 3);
    expect(first.filter((x) => x === 201)).toHaveLength(2);
    expect(first.filter((x) => x === 429)).toHaveLength(1);
    await station.duty(true); // a new shift
    expect((await openPage(station)).res.status).toBe(201);
  });

  it('lets exactly the free slots through when creates arrive at the same moment', async () => {
    const station = await makeStation({ live: 2, perMinute: 100 });
    const codes = await statuses(station, 10);
    expect(codes.filter((s) => s === 201)).toHaveLength(2);
    expect(codes.filter((s) => s === 429)).toHaveLength(8);
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(2);
  });

  it('cooldown(ms) blocks admits until the time passes, and never shortens', async () => {
    const station = await makeStation({ perMinute: 100 });
    await runInDurableObject(station.stub, async (inst: StationDO, state) => {
      await inst.cooldown(60_000);
      expect(await inst.admit('a'.repeat(22))).toEqual({ ok: false, reason: 'busy' });
      await inst.cooldown(1); // shorter request leaves the longer one in place
      const until = (await state.storage.get<number>('cooldownUntil'))!;
      expect(until).toBeGreaterThan(Date.now() + 50_000);
      await state.storage.put('cooldownUntil', Date.now() - 1); // time passes
      expect(await inst.admit('b'.repeat(22))).toEqual({ ok: true });
    });
  });

  it('a failed create gives its reserved slot back', async () => {
    const station = await makeStation({ live: 1, perMinute: 100 });
    await runInDurableObject(station.stub, async (inst: StationDO) => {
      expect(await inst.admit('c'.repeat(22))).toEqual({ ok: true });
      expect(await inst.admit('d'.repeat(22))).toEqual({ ok: false, reason: 'busy' });
      await inst.release('c'.repeat(22));
      expect(await inst.admit('d'.repeat(22))).toEqual({ ok: true });
    });
  });
});
