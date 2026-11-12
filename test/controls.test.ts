import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as c from '../src/shared/crypto';
import { QUIET_UNTIL_DUTY, type HostIndex, type SessionView } from '../src/shared/types';
import type { Env } from '../src/worker/env';

const testEnv = env as unknown as Env;
const ORIGIN = 'https://prayer.test';

let visitor = 0;

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
  cookie?: string;
}

function call(path: string, o: CallOptions = {}): Promise<Response> {
  // Each call comes from a fresh address so the per-visitor rate limit stays out of the way.
  const headers: Record<string, string> = { Origin: ORIGIN, 'CF-Connecting-IP': `10.0.${visitor >> 8}.${visitor++ & 255}` };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.Cookie = o.cookie;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
}

async function makeStation(onDuty = true) {
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
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  if (onDuty) expect((await call('/api/host/duty', { body: { on: true }, cookie })).status).toBe(200);
  return { keys, code, id, cookie };
}

async function openPage(station: { id: string; code: string }) {
  const k = c.randomBytes(32);
  const keys = await c.deriveSessionKeys(k);
  const res = await call('/api/sessions', {
    body: {
      station: station.id,
      authHash: c.b64u(await c.sha256(keys.auth)),
      wrappedKey: await c.wrapSessionKey(station.code, k),
    },
  });
  return { res, k, keys, view: res.ok ? ((await res.json()) as SessionView) : null };
}


const hostIndex = async (cookie: string) => (await (await call('/api/host', { cookie })).json()) as HostIndex;
const sessionStub = (id: string) => testEnv.SESSION.get(testEnv.SESSION.idFromName(id));
const stationStub = (id: string) => testEnv.STATION.get(testEnv.STATION.idFromName(id));

async function sealedRequest(page: Awaited<ReturnType<typeof openPage>>) {
  return c.seal(page.keys.enc, c.requestContext(page.view!.id), JSON.stringify({ name: 'Dana', text: 'hi' }));
}
async function sealedMessage(page: Awaited<ReturnType<typeof openPage>>) {
  return c.seal(page.keys.enc, c.messageContext(page.view!.id, 'rider'), 'hello');
}

describe('quiet mode', () => {
  it('sets quietUntil, defaults to an hour, and turns off with 0', async () => {
    const st = await makeStation();
    const res = await call('/api/host/quiet', { body: {}, cookie: st.cookie });
    expect(res.status).toBe(200);
    const { quietUntil } = (await res.json()) as { quietUntil: number };
    expect(quietUntil).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(quietUntil).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect((await hostIndex(st.cookie)).quietUntil).toBe(quietUntil);
    const stored = await runInDurableObject(stationStub(st.id), (_, state) => state.storage.get('quietUntil'));
    expect(stored).toBe(quietUntil);

    const off = (await (await call('/api/host/quiet', { body: { minutes: 0 }, cookie: st.cookie })).json()) as { quietUntil: number };
    expect(off.quietUntil).toBe(0);
    expect(await runInDurableObject(stationStub(st.id), (_, state) => state.storage.get('quietUntil'))).toBeUndefined();
  });

  it('caps and validates the length', async () => {
    const st = await makeStation();
    const big = (await (await call('/api/host/quiet', { body: { minutes: 999999 }, cookie: st.cookie })).json()) as { quietUntil: number };
    expect(big.quietUntil).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
    expect((await call('/api/host/quiet', { body: { minutes: 'x' }, cookie: st.cookie })).status).toBe(400);
  });
});

describe('close intake', () => {
  it('stops rider writes on existing pages, still lets them read, and reopens', async () => {
    const st = await makeStation();
    const page = await openPage(st);
    const id = page.view!.id;

    const close = await call('/api/host/intake', { body: { open: false }, cookie: st.cookie });
    expect(close.status).toBe(200);
    expect(await close.json()).toEqual({ onDutyUntil: 0, frozen: true });

    // The confirmed probe: off duty alone used to leave existing pages able to write.
    for (const [path, body] of [
      ['request', { body: await sealedRequest(page) }],
      ['messages', { body: await sealedMessage(page) }],
      ['pause', {}],
    ] as const) {
      const res = await call(`/api/sessions/${id}/${path}`, { body, token: page.keys.auth });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: 'paused' });
    }
    // Nothing reached the station's index either.
    expect((await hostIndex(st.cookie)).sessions[0]).toMatchObject({ state: 'opened', hasChat: false });

    const read = await call(`/api/sessions/${id}`, { token: page.keys.auth });
    expect(read.status).toBe(200);
    expect(((await read.json()) as SessionView).host?.closed).toBe(true);

    // The intercessor can still write to them.
    const reply = await c.seal((await c.deriveSessionKeys(await c.unwrapSessionKey(st.keys, ((await (await call(`/api/sessions/${id}`, { cookie: st.cookie })).json()) as SessionView).wrappedKey!))).enc, c.messageContext(id, 'host'), 'ok');
    expect((await call(`/api/sessions/${id}/messages`, { body: { body: reply }, cookie: st.cookie })).status).toBe(201);

    const open = (await (await call('/api/host/intake', { body: { open: true }, cookie: st.cookie })).json()) as { onDutyUntil: number; frozen: boolean };
    expect(open.frozen).toBe(false);
    expect(open.onDutyUntil).toBeGreaterThan(Date.now());
    expect((await call(`/api/sessions/${id}/request`, { body: { body: await sealedRequest(page) }, token: page.keys.auth })).status).toBe(200);
  });

  it('is also lifted by turning duty on', async () => {
    const st = await makeStation();
    await call('/api/host/intake', { body: { open: false }, cookie: st.cookie });
    expect((await hostIndex(st.cookie)).frozen).toBe(true);
    await call('/api/host/duty', { body: { on: true }, cookie: st.cookie });
    expect((await hostIndex(st.cookie)).frozen).toBe(false);
  });

  it('needs a boolean', async () => {
    const st = await makeStation();
    expect((await call('/api/host/intake', { body: { open: 'no' }, cookie: st.cookie })).status).toBe(400);
  });
});

describe('block this page', () => {
  it('erases the page and cools the whole station down', async () => {
    const st = await makeStation();
    const page = await openPage(st);
    const id = page.view!.id;
    expect((await call(`/api/sessions/${id}/block`, { method: 'POST', body: {}, cookie: st.cookie })).status).toBe(200);
    expect((await call(`/api/sessions/${id}`, { token: page.keys.auth })).status).toBe(404);
    expect((await hostIndex(st.cookie)).sessions).toHaveLength(0);

    const next = await openPage(st);
    expect(next.res.status).toBe(429);
    expect(await next.res.json()).toEqual({ error: 'busy' });
    expect(Number(next.res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it("will not touch another station's page", async () => {
    const mine = await makeStation();
    const theirs = await makeStation();
    const page = await openPage(theirs);
    const res = await call(`/api/sessions/${page.view!.id}/block`, { method: 'POST', body: {}, cookie: mine.cookie });
    expect(res.status).toBe(404);
    expect((await call(`/api/sessions/${page.view!.id}`, { token: page.keys.auth })).status).toBe(200);
    expect((await openPage(theirs)).res.status).toBe(201);
    expect((await openPage(mine)).res.status).toBe(201);
  });
});

describe('panic', () => {
  it('erases every page, goes off duty, closes writes and stays quiet until duty is on', async () => {
    const st = await makeStation();
    const pages = [await openPage(st), await openPage(st), await openPage(st)];
    const res = await call('/api/host/panic', { method: 'POST', body: {}, cookie: st.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ erased: 3 });
    for (const p of pages) expect((await call(`/api/sessions/${p.view!.id}`, { token: p.keys.auth })).status).toBe(404);

    const index = await hostIndex(st.cookie);
    expect(index).toMatchObject({ sessions: [], onDutyUntil: 0, frozen: true, quietUntil: QUIET_UNTIL_DUTY });
    expect((await openPage(st)).res.status).toBe(403);

    await call('/api/host/duty', { body: { on: true }, cookie: st.cookie });
    expect(await hostIndex(st.cookie)).toMatchObject({ frozen: false, quietUntil: 0 });
  });

  it('keeps a timed quiet when duty is turned on', async () => {
    const st = await makeStation();
    const { quietUntil } = (await (await call('/api/host/quiet', { body: { minutes: 30 }, cookie: st.cookie })).json()) as { quietUntil: number };
    await call('/api/host/duty', { body: { on: true }, cookie: st.cookie });
    expect((await hostIndex(st.cookie)).quietUntil).toBe(quietUntil);
  });
});

describe('only the intercessor can use the controls', () => {
  it('turns away riders and anonymous callers', async () => {
    const st = await makeStation();
    const page = await openPage(st);
    const id = page.view!.id;
    const attempts: [string, unknown][] = [
      ['/api/host/quiet', {}],
      ['/api/host/intake', { open: false }],
      ['/api/host/panic', {}],
      [`/api/sessions/${id}/block`, {}],
    ];
    for (const [path, body] of attempts) {
      expect((await call(path, { body })).status, `${path} anonymous`).toBe(401);
      expect((await call(path, { body, token: page.keys.auth })).status, `${path} rider`).toBe(401);
    }
    // Nothing changed.
    expect((await call(`/api/sessions/${id}`, { token: page.keys.auth })).status).toBe(200);
    expect(await hostIndex(st.cookie)).toMatchObject({ frozen: false, quietUntil: 0 });
    expect((await call('/api/host/quiet', { body: {}, cookie: st.cookie, method: 'POST' })).status).toBe(200);
  });

  it('refuses cross-site calls', async () => {
    const st = await makeStation();
    const res = await SELF.fetch(`${ORIGIN}/api/host/panic`, { method: 'POST', headers: { Origin: 'https://evil.test', Cookie: st.cookie }, body: '{}' });
    expect(res.status).toBe(403);
  });
});
