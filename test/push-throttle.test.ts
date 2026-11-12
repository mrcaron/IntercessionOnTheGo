import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as c from '../src/shared/crypto';
import { PUSH_WINDOW_MS, type NotifyKind, type SessionSummary } from '../src/shared/types';
import type { Env } from '../src/worker/env';
import { mergedText, type StationDO } from '../src/worker/station-do';

type Sent = { payload: { body: string; alert: boolean }; urgency?: string };
let n = 0;

/** A fresh station whose push sender is replaced by a counter. */
async function setup() {
  const stub = (env as unknown as Env).STATION.get((env as unknown as Env).STATION.idFromName(`push-${n++}`));
  const sent: Sent[] = [];
  const sub = {
    endpoint: 'https://push.example/abc',
    keys: { p256dh: c.b64u(new Uint8Array(65).fill(4)), auth: c.b64u(new Uint8Array(16).fill(1)) },
  };
  await runInDurableObject(stub, async (inst: StationDO) => {
    (inst as unknown as { env: Partial<Env> }).env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    inst.sender = async (_s, payload, _v, urgency) => {
      sent.push({ payload: JSON.parse(payload), urgency });
      return 201;
    };
    await inst.addPush(sub, 'https://prayer.test');
  });
  const summary = (id: string): Omit<SessionSummary, 'unread'> => ({
    id,
    createdAt: 1,
    expiresAt: Date.now() + 1e6,
    state: 'requested',
    prayedAt: null,
    hasRequest: true,
    hasChat: true,
  });
  // Events go through the DO instance so the injected sender is the one used.
  const event = (id: string, kind: NotifyKind) =>
    runInDurableObject(stub, async (inst: StationDO) => {
      await inst.sessionEvent(summary(id), kind);
    });
  const flushWaitUntil = () => new Promise((r) => setTimeout(r, 20));
  return { stub, sent, event, flushWaitUntil };
}

async function openDashboard(stub: DurableObjectStub<StationDO>) {
  const res = await stub.fetch('https://x/ws', { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

describe('push throttling', () => {
  it('keeps the default window at 60 seconds', () => expect(PUSH_WINDOW_MS).toBe(60_000));

  it('turns a burst of 50 events into at most 2 pushes in a minute', async () => {
    const t = await setup();
    for (let i = 0; i < 50; i++) await t.event(`p${i % 10}`, i % 3 === 0 ? 'message' : i % 3 === 1 ? 'requested' : 'opened');
    await t.flushWaitUntil();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].urgency).toBe('high');
    expect(t.sent[0].payload.alert).toBe(true);
    await runDurableObjectAlarm(t.stub);
    await t.flushWaitUntil();
    expect(t.sent.length).toBeLessThanOrEqual(2);
    expect(t.sent[1].urgency).toBe('normal');
    expect(t.sent[1].payload.alert).toBe(false);
    // Nothing new is pending, so the next alarm only closes the window.
    await runDurableObjectAlarm(t.stub);
    expect(t.sent).toHaveLength(2);
  });

  it('merges counts into one line on the alarm', async () => {
    const t = await setup();
    await t.event('first', 'requested'); // immediate
    for (const id of ['a', 'b', 'c']) await t.event(id, 'requested');
    await t.event('m1', 'message');
    await t.event('m2', 'message');
    await t.flushWaitUntil();
    expect(t.sent).toHaveLength(1);
    expect(await runDurableObjectAlarm(t.stub)).toBe(true);
    expect(t.sent[1].payload.body).toBe('3 new requests, 2 messages');
    expect(mergedText(1, 0)).toBe('1 new request');
    expect(mergedText(0, 1)).toBe('1 message');
  });

  it('never pushes for a page just being opened', async () => {
    const t = await setup();
    await t.event('a', 'opened');
    await t.event('a', 'update');
    await t.flushWaitUntil();
    expect(t.sent).toHaveLength(0);
  });

  it('pushes only the first unread message on a page, until it is read', async () => {
    const t = await setup();
    await t.event('a', 'message');
    await t.event('a', 'message');
    await t.event('a', 'message');
    await runDurableObjectAlarm(t.stub);
    await t.flushWaitUntil();
    // One immediate push; the follow-up messages were not counted.
    expect(t.sent).toHaveLength(1);
    await runInDurableObject(t.stub, (inst: StationDO) => inst.markRead('a'));
    await t.event('a', 'message');
    await t.flushWaitUntil();
    // The first alarm closed the empty window, so this one goes out immediately.
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1].payload.body).toBe('Someone sent you a chat message.');
  });

  it('sends nothing while the dashboard is visible', async () => {
    const t = await setup();
    const ws = await openDashboard(t.stub);
    await t.event('a', 'requested');
    await t.flushWaitUntil();
    expect(t.sent).toHaveLength(0);
    ws.close();
  });

  it('still sends the merged push after the dashboard closes during the window', async () => {
    const t = await setup();
    await t.event('a', 'requested'); // immediate, window opens
    await t.event('b', 'requested'); // counted
    await t.flushWaitUntil();
    const ws = await openDashboard(t.stub);
    ws.send('hidden');
    await t.flushWaitUntil();
    await runDurableObjectAlarm(t.stub);
    expect(t.sent.map((s) => s.payload.body)).toEqual(['A new prayer request is waiting.', '1 new request']);
    ws.close();
  });

  it('drops the merged push if the dashboard is visible at flush time', async () => {
    const t = await setup();
    await t.event('a', 'requested');
    await t.event('b', 'requested');
    const ws = await openDashboard(t.stub);
    await runDurableObjectAlarm(t.stub);
    expect(t.sent).toHaveLength(1);
    ws.close();
  });

  it('is silenced by quietUntil, but the raw push (test button) is not', async () => {
    const t = await setup();
    await runInDurableObject(t.stub, async (inst: StationDO, state) => {
      await state.storage.put('quietUntil', Date.now() + 60_000);
    });
    await t.event('a', 'requested');
    await t.flushWaitUntil();
    expect(t.sent).toHaveLength(0);
    const delivered = await runInDurableObject(t.stub, (inst: StationDO) => inst.push('Test: notifications are working.'));
    expect(delivered).toBe(1);
    expect(t.sent).toHaveLength(1);
  });

  it('lets the test push through immediately, even inside an open window', async () => {
    const t = await setup();
    await t.event('a', 'requested');
    await t.flushWaitUntil();
    await runInDurableObject(t.stub, (inst: StationDO) => inst.push('Test: notifications are working.'));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1].payload.body).toBe('Test: notifications are working.');
  });

  it('an alarm cannot throw or loop when sending fails', async () => {
    const t = await setup();
    await t.event('a', 'requested');
    await t.event('b', 'requested');
    await runInDurableObject(t.stub, (inst: StationDO) => {
      inst.sender = async () => {
        throw new Error('push service down');
      };
    });
    await expect(runDurableObjectAlarm(t.stub)).resolves.toBe(true);
    // Counts were reset before sending, so the next alarm has nothing to flush.
    await runDurableObjectAlarm(t.stub);
    expect(t.sent).toHaveLength(1);
  });
});
