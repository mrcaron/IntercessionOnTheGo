// Per-page caps on rider writes: request edits, pauses and chat messages.

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as c from '../src/shared/crypto';
import {
  MAX_PAGE_LIFETIME,
  MAX_PAUSES,
  MAX_REQUEST_EDITS,
  MAX_RIDER_MESSAGES,
  MAX_RIDER_STREAK,
  type HostIndex,
  type SessionView,
} from '../src/shared/types';
import type { Env } from '../src/worker/env';

const testEnv = env as unknown as Env;
const ORIGIN = 'https://prayer.test';

let visitor = 0;

function call(path: string, o: { body?: unknown; token?: string; cookie?: string; method?: string } = {}): Promise<Response> {
  // A fresh address per call keeps the per-visitor rate limit out of the way: these caps are per page.
  const headers: Record<string, string> = { Origin: ORIGIN, 'CF-Connecting-IP': `10.1.${visitor >> 8}.${visitor++ & 255}` };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.Cookie = o.cookie;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
}

async function setup() {
  const keys = await c.generateStationKeys();
  const code = await c.stationCode(keys);
  const station = await c.stationIdFromCode(code);
  await call('/api/setup', {
    body: { setupToken: 'test-setup', code, sigPub: c.b64u(await c.rawPublic(keys.sign.publicKey)), name: 'Sam', place: '' },
  });
  const { nonce } = (await (await call('/api/login/challenge', { body: { station } })).json()) as { nonce: string };
  const login = await call('/api/login', {
    body: { station, nonce, signature: await c.signText(keys.sign.privateKey, c.loginChallengeText(station, nonce)) },
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  await call('/api/host/duty', { body: { on: true }, cookie });

  const k = c.randomBytes(32);
  const sk = await c.deriveSessionKeys(k);
  const res = await call('/api/sessions', {
    body: { station, authHash: c.b64u(await c.sha256(sk.auth)), wrappedKey: await c.wrapSessionKey(code, k) },
  });
  const view = (await res.json()) as SessionView;
  return { id: view.id, view, keys: sk, cookie };
}

type Page = Awaited<ReturnType<typeof setup>>;

const stub = (id: string) => testEnv.SESSION.get(testEnv.SESSION.idFromName(id));

/** Pretend the last rider message was long ago, so the 3 s gap doesn't get in the way. */
const waitOutGap = (p: Page) =>
  runInDurableObject(stub(p.id), async (_i, state) => {
    const meta = (await state.storage.get<Record<string, unknown>>('meta'))!;
    if (meta.lastRiderMsgAt) await state.storage.put('meta', { ...meta, lastRiderMsgAt: (meta.lastRiderMsgAt as number) - 10_000 });
  });

async function writeRequest(p: Page) {
  const body = await c.seal(p.keys.enc, c.requestContext(p.id), JSON.stringify({ name: '', text: 'x' }));
  return call(`/api/sessions/${p.id}/request`, { body: { body }, token: p.keys.auth });
}
async function riderSays(p: Page, text = 'hi') {
  await waitOutGap(p);
  const body = await c.seal(p.keys.enc, c.messageContext(p.id, 'rider'), text);
  return call(`/api/sessions/${p.id}/messages`, { body: { body }, token: p.keys.auth });
}
async function hostSays(p: Page, text = 'hello') {
  const body = await c.seal(p.keys.enc, c.messageContext(p.id, 'host'), text);
  return call(`/api/sessions/${p.id}/messages`, { body: { body }, cookie: p.cookie });
}
const pause = (p: Page) => call(`/api/sessions/${p.id}/pause`, { method: 'POST', token: p.keys.auth });
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const riderView = async (p: Page) => (await (await call(`/api/sessions/${p.id}`, { token: p.keys.auth })).json()) as SessionView;
const prayed = (p: Page) => call(`/api/sessions/${p.id}/prayed`, { method: 'POST', cookie: p.cookie });

describe('pause cap', () => {
  it('50 presses: only 3 count, and the page lives at most 72 hours', async () => {
    const p = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) statuses.push((await pause(p)).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(MAX_PAUSES);
    expect(statuses.slice(MAX_PAUSES).every((s) => s === 429)).toBe(true);

    const view = await riderView(p);
    expect(view.expiresAt).toBeLessThanOrEqual(p.view.createdAt + MAX_PAGE_LIFETIME);
    expect(view.expiresAt).toBe(p.view.createdAt + MAX_PAGE_LIFETIME); // 1h + 24h + 24h + clamped third
    const index = (await (await call('/api/host', { cookie: p.cookie })).json()) as HostIndex;
    expect(index.sessions[0].expiresAt).toBe(view.expiresAt);
    expect(await runInDurableObject(stub(p.id), (_i, s) => s.storage.getAlarm())).toBe(view.expiresAt);
  });

  it('answers 429 limit-pause and reports no pauses left', async () => {
    const p = await setup();
    for (let i = 0; i < MAX_PAUSES; i++) expect((await pause(p)).status).toBe(200);
    const res = await pause(p);
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('limit-pause');
    expect((await riderView(p)).limits?.pausesLeft).toBe(0);
  });

  it('only the rider can pause', async () => {
    const p = await setup();
    expect((await call(`/api/sessions/${p.id}/pause`, { method: 'POST', cookie: p.cookie })).status).toBe(404);
  });
});

describe('request cap', () => {
  it('allows the first write plus two edits, then refuses', async () => {
    const p = await setup();
    for (let i = 0; i < 1 + MAX_REQUEST_EDITS; i++) expect((await writeRequest(p)).status).toBe(200);
    const res = await writeRequest(p);
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('limit-request');
    expect((await riderView(p)).limits?.requestEditsLeft).toBe(0);
  });

  it('20 rewrites after prayed are all refused and leave the page as it was', async () => {
    const p = await setup();
    expect((await writeRequest(p)).status).toBe(200);
    expect((await prayed(p)).status).toBe(200);
    const before = await riderView(p);
    expect(before.state).toBe('prayed');
    for (let i = 0; i < 20; i++) {
      const res = await writeRequest(p);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('already-prayed');
    }
    const after = await riderView(p);
    expect(after.state).toBe('prayed');
    expect(after.prayedAt).toBe(before.prayedAt);
    expect(after.request).toBe(before.request);
  });
});

describe('praying before the rider writes', () => {
  it('still accepts the first request, then refuses rewrites once prayed again', async () => {
    const p = await setup();
    expect((await prayed(p)).status).toBe(200);
    expect((await riderView(p)).limits?.requestEditsLeft).toBe(1 + MAX_REQUEST_EDITS);
    expect((await writeRequest(p)).status).toBe(200);
    expect((await riderView(p)).state).toBe('requested');
    expect((await prayed(p)).status).toBe(200);
    const res = await writeRequest(p);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('already-prayed');
  });
});

describe('chat caps', () => {
  it('refuses a second message sent inside the gap', async () => {
    const p = await setup();
    expect((await riderSays(p)).status).toBe(201);
    const body = await c.seal(p.keys.enc, c.messageContext(p.id, 'rider'), 'again');
    const res = await call(`/api/sessions/${p.id}/messages`, { body: { body }, token: p.keys.auth });
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('too-fast');
    expect((await riderSays(p)).status).toBe(201); // once the gap has passed
  });

  it('stops after 5 in a row until the host replies', async () => {
    const p = await setup();
    for (let i = 0; i < MAX_RIDER_STREAK; i++) expect((await riderSays(p)).status).toBe(201);
    const res = await riderSays(p);
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('wait-for-reply');
    expect((await riderView(p)).limits?.streakLeft).toBe(0);
    expect((await hostSays(p)).status).toBe(201);
    expect((await riderSays(p)).status).toBe(201);
  });

  it('caps rider messages at 30 per page, and the host is not limited', async () => {
    const p = await setup();
    for (let i = 0; i < MAX_RIDER_MESSAGES; i++) {
      expect((await riderSays(p)).status).toBe(201);
      if (i % 2) expect((await hostSays(p)).status).toBe(201); // keeps the streak under its own cap
    }
    const res = await riderSays(p);
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('limit-chat');
    // Host messages keep going, many in a row and with no gap.
    for (let i = 0; i < 8; i++) expect((await hostSays(p)).status).toBe(201);
  });

  it('does not count or store a refused message', async () => {
    const p = await setup();
    for (let i = 0; i < MAX_RIDER_STREAK; i++) await riderSays(p);
    const before = (await riderView(p)).messages.length;
    await riderSays(p);
    expect((await riderView(p)).messages).toHaveLength(before);
  });
});

describe('pages stored before the caps existed', () => {
  it('still work when the counters are missing', async () => {
    const p = await setup();
    expect((await writeRequest(p)).status).toBe(200);
    expect((await riderSays(p)).status).toBe(201);
    await runInDurableObject(stub(p.id), async (_i, state) => {
      const meta = (await state.storage.get<Record<string, unknown>>('meta'))!;
      for (const k of ['requestWrites', 'pauses', 'riderMsgs', 'riderStreak', 'lastRiderMsgAt']) delete meta[k];
      await state.storage.put('meta', meta);
    });
    // The existing request counts as the first write, so two edits remain.
    expect((await riderView(p)).limits).toMatchObject({ requestEditsLeft: MAX_REQUEST_EDITS, pausesLeft: MAX_PAUSES });
    expect((await writeRequest(p)).status).toBe(200);
    expect((await riderSays(p)).status).toBe(201);
    expect((await pause(p)).status).toBe(200);
  });
});
