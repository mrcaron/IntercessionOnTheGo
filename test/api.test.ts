import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as c from '../src/shared/crypto';
import { PAUSE_EXTENSION, SESSION_LIFETIME, type HostIndex, type SessionView } from '../src/shared/types';
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

const sessionStub = (id: string) => testEnv.SESSION.get(testEnv.SESSION.idFromName(id));
const hostIndex = async (cookie: string) => (await (await call('/api/host', { cookie })).json()) as HostIndex;

describe('setup and login', () => {
  it('rejects a wrong setup token', async () => {
    const keys = await c.generateStationKeys();
    const res = await call('/api/setup', {
      body: { setupToken: 'nope', code: await c.stationCode(keys), sigPub: c.b64u(await c.rawPublic(keys.sign.publicKey)), name: 'X' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a login signed by the wrong key', async () => {
    const station = await makeStation(false);
    const other = await c.generateStationKeys();
    const { nonce } = (await (await call('/api/login/challenge', { body: { station: station.id } })).json()) as { nonce: string };
    const res = await call('/api/login', {
      body: { station: station.id, nonce, signature: await c.signText(other.sign.privateKey, c.loginChallengeText(station.id, nonce)) },
    });
    expect(res.status).toBe(401);
  });

  it('requires login for the dashboard', async () => {
    expect((await call('/api/host')).status).toBe(401);
  });

  it('refuses cross-site writes', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/sessions`, { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' });
    expect(res.status).toBe(403);
  });
});

describe('prayer page', () => {
  it('cannot be opened while the intercessor is off duty', async () => {
    const station = await makeStation(false);
    const info = (await (await call(`/api/station/${station.id}`)).json()) as { onDuty: boolean; name: string; place: string };
    expect(info).toEqual({ name: 'Sam', place: 'on the bus', onDuty: false });
    const { res } = await openPage(station);
    expect(res.status).toBe(403);
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(0);
  });

  it('runs the whole journey end to end, encrypted', async () => {
    const station = await makeStation();
    const page = await openPage(station);
    expect(page.res.status).toBe(201);
    const id = page.view!.id;
    expect(page.view!.host).toEqual({ name: 'Sam', place: 'on the bus' });
    expect(page.view!.wrappedKey).toBeUndefined();
    expect(page.view!.expiresAt - page.view!.createdAt).toBe(SESSION_LIFETIME);

    // The dashboard sees a newly opened page.
    let index = await hostIndex(station.cookie);
    expect(index.sessions).toMatchObject([{ id, state: 'opened', hasChat: false, unread: 0 }]);

    // Rider sends a request.
    const secret = 'Please pray for my mother Ruth, she is in hospital';
    const sealed = await c.seal(page.keys.enc, c.requestContext(id), JSON.stringify({ name: 'Dana', text: secret }));
    expect((await call(`/api/sessions/${id}/request`, { body: { body: sealed }, token: page.keys.auth })).status).toBe(200);
    index = await hostIndex(station.cookie);
    expect(index.sessions[0].state).toBe('requested');

    // Nothing readable is stored on the server.
    const stored = await runInDurableObject(sessionStub(id), async (_, state) => JSON.stringify([...(await state.storage.list())]));
    expect(stored).not.toContain('Ruth');
    expect(stored).not.toContain('Dana');
    expect(stored).not.toContain(page.keys.auth);

    // The intercessor opens it and decrypts with their own key.
    const hostView = (await (await call(`/api/sessions/${id}`, { cookie: station.cookie })).json()) as SessionView;
    const k = await c.unwrapSessionKey(station.keys, hostView.wrappedKey!);
    const hostKeys = await c.deriveSessionKeys(k);
    expect(JSON.parse(await c.open(hostKeys.enc, c.requestContext(id), hostView.request!))).toEqual({ name: 'Dana', text: secret });

    // Prayed: the rider sees it.
    expect((await call(`/api/sessions/${id}/prayed`, { method: 'POST', token: page.keys.auth })).status).toBe(404);
    expect((await call(`/api/sessions/${id}/prayed`, { method: 'POST', cookie: station.cookie })).status).toBe(200);
    let riderView = (await (await call(`/api/sessions/${id}`, { token: page.keys.auth })).json()) as SessionView;
    expect(riderView.state).toBe('prayed');
    expect(riderView.prayedAt).toBeGreaterThan(0);

    // Chat both ways.
    const hello = await c.seal(page.keys.enc, c.messageContext(id, 'rider'), 'Thank you. Can we talk?');
    expect((await call(`/api/sessions/${id}/messages`, { body: { body: hello }, token: page.keys.auth })).status).toBe(201);
    index = await hostIndex(station.cookie);
    expect(index.sessions[0]).toMatchObject({ hasChat: true, unread: 1 });
    const reply = await c.seal(hostKeys.enc, c.messageContext(id, 'host'), 'Of course.');
    expect((await call(`/api/sessions/${id}/messages`, { body: { body: reply }, cookie: station.cookie })).status).toBe(201);
    riderView = (await (await call(`/api/sessions/${id}`, { token: page.keys.auth })).json()) as SessionView;
    expect(riderView.messages.map((m) => m.from)).toEqual(['rider', 'host']);
    expect(await c.open(page.keys.enc, c.messageContext(id, 'host'), riderView.messages[1].body)).toBe('Of course.');
    // Opening the page as the intercessor clears the unread count.
    await call(`/api/sessions/${id}`, { cookie: station.cookie });
    expect((await hostIndex(station.cookie)).sessions[0].unread).toBe(0);
  });

  it('gives identical answers for a wrong key, another intercessor, and a page that never existed', async () => {
    const station = await makeStation();
    const stranger = await makeStation();
    const page = await openPage(station);
    const id = page.view!.id;
    const wrong = c.b64u(c.randomBytes(32));
    const answers = await Promise.all([
      call(`/api/sessions/${id}`, { token: wrong }),
      call(`/api/sessions/${id}`, { cookie: stranger.cookie }),
      call(`/api/sessions/${id}`),
      call(`/api/sessions/${c.b64u(c.randomBytes(16))}`, { token: wrong }),
    ]);
    const bodies = await Promise.all(answers.map((r) => r.text()));
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(bodies).size).toBe(1);
  });

  it('pause adds exactly 24 hours each press', async () => {
    const station = await makeStation();
    const page = await openPage(station);
    const id = page.view!.id;
    const first = (await (await call(`/api/sessions/${id}/pause`, { method: 'POST', token: page.keys.auth })).json()) as { expiresAt: number };
    expect(first.expiresAt).toBe(page.view!.expiresAt + PAUSE_EXTENSION);
    const second = (await (await call(`/api/sessions/${id}/pause`, { method: 'POST', token: page.keys.auth })).json()) as { expiresAt: number };
    expect(second.expiresAt).toBe(page.view!.expiresAt + 2 * PAUSE_EXTENSION);
    expect((await hostIndex(station.cookie)).sessions[0].expiresAt).toBe(second.expiresAt);
    // Only the rider may pause.
    expect((await call(`/api/sessions/${id}/pause`, { method: 'POST', cookie: station.cookie })).status).toBe(404);
  });

  it('self-destructs when the alarm fires, leaving nothing behind', async () => {
    const station = await makeStation();
    const page = await openPage(station);
    const id = page.view!.id;
    const sealed = await c.seal(page.keys.enc, c.requestContext(id), JSON.stringify({ name: '', text: 'x' }));
    await call(`/api/sessions/${id}/request`, { body: { body: sealed }, token: page.keys.auth });
    const stub = sessionStub(id);

    // An early alarm must not erase anything.
    await runDurableObjectAlarm(stub);
    expect((await call(`/api/sessions/${id}`, { token: page.keys.auth })).status).toBe(200);

    // Move the clock: mark the page as expired, then let the alarm run.
    await runInDurableObject(stub, async (_, state) => {
      const meta = (await state.storage.get<{ expiresAt: number }>('meta'))!;
      await state.storage.put('meta', { ...meta, expiresAt: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const left = await runInDurableObject(stub, async (_, state) => ({
      keys: (await state.storage.list()).size,
      alarm: await state.storage.getAlarm(),
    }));
    expect(left).toEqual({ keys: 0, alarm: null });
    expect((await call(`/api/sessions/${id}`, { token: page.keys.auth })).status).toBe(404);
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(0);
  });

  it('expires on access even if the alarm is late', async () => {
    const station = await makeStation();
    const page = await openPage(station);
    const id = page.view!.id;
    await runInDurableObject(sessionStub(id), async (_, state) => {
      const meta = (await state.storage.get<{ expiresAt: number }>('meta'))!;
      await state.storage.put('meta', { ...meta, expiresAt: Date.now() - 1 });
    });
    expect((await call(`/api/sessions/${id}`, { token: page.keys.auth })).status).toBe(404);
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(0);
  });

  it('can be erased at once by either side', async () => {
    const station = await makeStation();
    const a = await openPage(station);
    const b = await openPage(station);
    expect((await call(`/api/sessions/${a.view!.id}`, { method: 'DELETE', token: a.keys.auth })).status).toBe(200);
    expect((await call(`/api/sessions/${b.view!.id}`, { method: 'DELETE', cookie: station.cookie })).status).toBe(200);
    expect((await call(`/api/sessions/${a.view!.id}`, { token: a.keys.auth })).status).toBe(404);
    expect((await hostIndex(station.cookie)).sessions).toHaveLength(0);
  });

  it('slows down a visitor who opens pages in a burst', async () => {
    const station = await makeStation();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await SELF.fetch(`${ORIGIN}/api/sessions`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ station: station.id, authHash: 'x', wrappedKey: 'x' }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses).toContain(429);
  });

  it('pushes live updates to the rider over WebSocket', async () => {
    const station = await makeStation();
    const page = await openPage(station);
    const id = page.view!.id;
    const denied = await SELF.fetch(`${ORIGIN}/api/sessions/${id}/ws`, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `mps, ${c.b64u(c.randomBytes(32))}` },
    });
    expect(denied.status).toBe(404);
    const res = await SELF.fetch(`${ORIGIN}/api/sessions/${id}/ws`, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `mps, ${page.keys.auth}` },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const events: { t: string; state?: string }[] = [];
    const got = new Promise<void>((resolve) =>
      ws.addEventListener('message', (e) => {
        events.push(JSON.parse(e.data as string));
        resolve();
      }),
    );
    await call(`/api/sessions/${id}/prayed`, { method: 'POST', cookie: station.cookie });
    await got;
    expect(events[0]).toMatchObject({ t: 'state', state: 'prayed' });
    ws.close();
  });
});
