// One Durable Object per intercessor: profile, on-duty state, login, the push
// subscription, and an index of live prayer pages (timing and status only).

import { DurableObject } from 'cloudflare:workers';
import { b64u, loginChallengeText, randomBytes, sha256, verifyText } from '../shared/crypto';
import {
  DUTY_LENGTH,
  PUSH_WINDOW_MS,
  MAX_LIVE_PAGES,
  MAX_NEW_PAGES_PER_MINUTE,
  MAX_PAGES_PER_SHIFT,
  QUIET_MAX_MIN,
  QUIET_UNTIL_DUTY,
  RESERVATION_TTL,
  type HostIndex,
  type NotifyKind,
  type SessionSummary,
  type StationEvent,
  type StationPublic,
} from '../shared/types';
import type { Env } from './env';
import { isValidSubscription, sendPush, type PushSubscriptionJSON, type PushUrgency } from './webpush';

interface Profile {
  id: string;
  code: string; // compressed ECDH public key (what the QR carries)
  sigPub: string; // ECDSA public key used to verify logins
  name: string;
  place: string;
}

export interface IntakeLimits {
  livePages: number;
  perMinute: number;
  perShift: number;
}

export type AdmitResult = { ok: true } | { ok: false; reason: 'off-duty' | 'busy' };

const num = (v: string | undefined, fallback: number) => (v !== undefined && Number.isFinite(+v) && +v >= 0 ? +v : fallback);

const LOGIN_TTL = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL = 2 * 60 * 1000;

// Opening a page never pushes: it is the most frequent, least useful alert and the easiest to abuse.
const PUSH_TEXT: Partial<Record<NotifyKind, string>> = {
  requested: 'A new prayer request is waiting.',
  message: 'Someone sent you a chat message.',
};

/** Events counted since the last push in the current window; flushed by alarm(). */
interface PushWindow {
  end: number;
  requested: number;
  message: number;
}

export function mergedText(requested: number, message: number): string {
  const parts: string[] = [];
  if (requested) parts.push(`${requested} new request${requested === 1 ? '' : 's'}`);
  if (message) parts.push(`${message} message${message === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export class StationDO extends DurableObject<Env> {
  /** Replaced in tests so they can count sends. */
  sender: typeof sendPush = sendPush;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // -- setup and profile -----------------------------------------------------

  async register(p: Profile): Promise<boolean> {
    const existing = await this.ctx.storage.get<Profile>('profile');
    if (existing && existing.sigPub !== p.sigPub) return false;
    await this.ctx.storage.put('profile', p);
    return true;
  }

  async publicInfo(): Promise<StationPublic | null> {
    const p = await this.ctx.storage.get<Profile>('profile');
    if (!p) return null;
    return { name: p.name, place: p.place, onDuty: await this.onDuty(), closed: await this.isFrozen() };
  }

  async updateProfile(name: string, place: string): Promise<void> {
    const p = await this.ctx.storage.get<Profile>('profile');
    if (p) await this.ctx.storage.put('profile', { ...p, name, place });
  }

  // -- login -----------------------------------------------------------------

  async challenge(): Promise<string | null> {
    if (!(await this.ctx.storage.get('profile'))) return null;
    const nonce = b64u(randomBytes(24));
    await this.ctx.storage.put(`chal:${nonce}`, Date.now() + CHALLENGE_TTL);
    return nonce;
  }

  async login(nonce: string, signature: string): Promise<string | null> {
    const p = await this.ctx.storage.get<Profile>('profile');
    const exp = await this.ctx.storage.get<number>(`chal:${nonce}`);
    await this.ctx.storage.delete(`chal:${nonce}`);
    if (!p || !exp || exp < Date.now()) return null;
    if (!(await verifyText(p.sigPub, loginChallengeText(p.id, nonce), signature))) return null;
    await this.sweepAuth();
    const token = b64u(randomBytes(32));
    await this.ctx.storage.put(`auth:${b64u(await sha256(token))}`, Date.now() + LOGIN_TTL);
    return token;
  }

  async checkAuth(token: string): Promise<boolean> {
    const exp = await this.ctx.storage.get<number>(`auth:${b64u(await sha256(token))}`);
    return !!exp && exp > Date.now();
  }

  async logout(token: string): Promise<void> {
    await this.ctx.storage.delete(`auth:${b64u(await sha256(token))}`);
  }

  private async sweepAuth(): Promise<void> {
    const now = Date.now();
    for (const prefix of ['auth:', 'chal:']) {
      for (const [key, exp] of await this.ctx.storage.list<number>({ prefix })) {
        if (exp < now) await this.ctx.storage.delete(key);
      }
    }
  }

  // -- duty ------------------------------------------------------------------

  private async onDuty(): Promise<boolean> {
    return ((await this.ctx.storage.get<number>('duty')) ?? 0) > Date.now();
  }

  async setDuty(on: boolean): Promise<number> {
    const until = on ? Date.now() + DUTY_LENGTH : 0;
    await this.ctx.storage.put('duty', until);
    if (on) await this.ctx.storage.put('shiftCount', 0); // a new shift gets a fresh page budget
    if (on) await this.clearControlsOnDuty();
    this.broadcast({ t: 'duty', onDutyUntil: until });
    return until;
  }

  // -- intake budget --------------------------------------------------------

  /**
   * Decides whether a new page may open, and reserves its slot in the same call. Calls to a
   * Durable Object are serialized, so two creates at once cannot both take the last slot.
   * `overrides` is for tests only; the Worker route never passes it.
   */
  async admit(id: string, overrides?: Partial<IntakeLimits>): Promise<AdmitResult> {
    // Queue behind earlier calls: awaiting storage between the check and the write must not let
    // another admit read the same counts.
    const run = this.admitting.then(() => this.admitNow(id, overrides));
    this.admitting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private admitting: Promise<void> = Promise.resolve();

  private async admitNow(id: string, overrides?: Partial<IntakeLimits>): Promise<AdmitResult> {
    if (!(await this.onDuty())) return { ok: false, reason: 'off-duty' };
    const now = Date.now();
    const limits: IntakeLimits = {
      livePages: num(this.env.MAX_LIVE_PAGES, MAX_LIVE_PAGES),
      perMinute: num(this.env.MAX_NEW_PAGES_PER_MINUTE, MAX_NEW_PAGES_PER_MINUTE),
      perShift: num(this.env.MAX_PAGES_PER_SHIFT, MAX_PAGES_PER_SHIFT),
      // Test-only: nothing in the Worker writes this key. It survives the instance being recreated.
      ...(await this.ctx.storage.get<Partial<IntakeLimits>>('intakeLimits')),
      ...overrides,
    };
    if (((await this.ctx.storage.get<number>('cooldownUntil')) ?? 0) > now) return { ok: false, reason: 'busy' };
    const recent = ((await this.ctx.storage.get<number[]>('recentOpens')) ?? []).filter((t) => t > now - 60_000);
    const shift = (await this.ctx.storage.get<number>('shiftCount')) ?? 0;
    if ((await this.livePages(now)) >= limits.livePages || recent.length >= limits.perMinute || shift >= limits.perShift) {
      return { ok: false, reason: 'busy' };
    }
    await this.ctx.storage.put({
      [`r:${id}`]: now + RESERVATION_TTL,
      recentOpens: [...recent, now],
      shiftCount: shift + 1,
    });
    return { ok: true };
  }

  /** Gives back a reserved slot when the page could not be created. */
  async release(id: string): Promise<void> {
    await this.ctx.storage.delete(`r:${id}`);
  }

  /** Refuses new pages until `ms` from now (never shortens an existing cool-down). */
  async cooldown(ms: number): Promise<void> {
    const until = Math.max((await this.ctx.storage.get<number>('cooldownUntil')) ?? 0, Date.now() + ms);
    await this.ctx.storage.put('cooldownUntil', until);
  }

  // Pages in the index that have not expired, plus reservations still waiting for their page.
  // Ignoring expired entries keeps the count right even if a sessionGone call were ever lost.
  private async livePages(now: number): Promise<number> {
    let n = 0;
    for (const s of (await this.ctx.storage.list<SessionSummary>({ prefix: 's:' })).values()) if (s.expiresAt > now) n++;
    for (const [key, exp] of await this.ctx.storage.list<number>({ prefix: 'r:' })) {
      if (exp > now) n++;
      else await this.ctx.storage.delete(key);
    }
    return n;
  }

  // -- host controls: quiet mode, closed intake, cool-down ---------------------
  // Plain timestamps and flags; nothing here schedules work. The push path reads quietUntil.

  async isFrozen(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>('frozen')) === true;
  }

  /** Going back on duty reopens pages, and ends a panic's "quiet until duty" (a timed quiet stays). */
  private async clearControlsOnDuty(): Promise<void> {
    await this.ctx.storage.delete('frozen');
    if ((await this.ctx.storage.get<number>('quietUntil')) === QUIET_UNTIL_DUTY) await this.ctx.storage.delete('quietUntil');
    await this.broadcastControls();
  }

  /** `minutes` of 0 turns quiet mode off. Returns the new quietUntil (0 when off). */
  async setQuiet(minutes: number): Promise<number> {
    const m = Math.min(Math.max(Math.floor(minutes), 0), QUIET_MAX_MIN);
    if (m === 0) await this.ctx.storage.delete('quietUntil');
    else await this.ctx.storage.put('quietUntil', Date.now() + m * 60_000);
    await this.broadcastControls();
    return m === 0 ? 0 : ((await this.ctx.storage.get<number>('quietUntil')) ?? 0);
  }

  /** Close: off duty and frozen. Open: unfreeze and back on duty. */
  async setIntake(open: boolean): Promise<{ onDutyUntil: number; frozen: boolean }> {
    if (open) return { onDutyUntil: await this.setDuty(true), frozen: false };
    await this.setDuty(false);
    await this.ctx.storage.put('frozen', true);
    await this.broadcastControls();
    return { onDutyUntil: 0, frozen: true };
  }

  /** Off duty, frozen and quiet until duty is next turned on. The Worker then erases the pages. */
  async lockDown(): Promise<void> {
    await this.setDuty(false);
    await this.ctx.storage.put({ frozen: true, quietUntil: QUIET_UNTIL_DUTY });
    await this.broadcastControls();
  }

  private async broadcastControls(): Promise<void> {
    this.broadcast({
      t: 'controls',
      quietUntil: (await this.ctx.storage.get<number>('quietUntil')) ?? 0,
      frozen: await this.isFrozen(),
    });
  }

  // -- index of live prayer pages --------------------------------------------

  async index(): Promise<HostIndex | null> {
    const p = await this.ctx.storage.get<Profile>('profile');
    if (!p) return null;
    const sessions = [...(await this.ctx.storage.list<SessionSummary>({ prefix: 's:' })).values()];
    return {
      name: p.name,
      place: p.place,
      onDutyUntil: (await this.ctx.storage.get<number>('duty')) ?? 0,
      pushEnabled: (await this.subscriptions()).length > 0,
      quietUntil: (await this.ctx.storage.get<number>('quietUntil')) ?? 0,
      frozen: await this.isFrozen(),
      sessions,
    };
  }

  async sessionEvent(summary: Omit<SessionSummary, 'unread'>, kind: NotifyKind): Promise<void> {
    const key = `s:${summary.id}`;
    if (kind === 'opened') await this.ctx.storage.delete(`r:${summary.id}`); // the page now counts through the index
    const prev = await this.ctx.storage.get<SessionSummary>(key);
    const session: SessionSummary = { ...summary, unread: (prev?.unread ?? 0) + (kind === 'message' ? 1 : 0) };
    await this.ctx.storage.put(key, session);
    this.broadcast({ t: 'upsert', session });
    // Only a request, or the first unread message on a page, is worth an alert.
    if (kind === 'requested' || (kind === 'message' && (prev?.unread ?? 0) === 0)) await this.notePush(kind);
  }

  async sessionGone(id: string): Promise<void> {
    await this.ctx.storage.delete(`s:${id}`);
    this.broadcast({ t: 'remove', id });
  }

  async markRead(id: string): Promise<void> {
    const key = `s:${id}`;
    const s = await this.ctx.storage.get<SessionSummary>(key);
    if (!s || s.unread === 0) return;
    s.unread = 0;
    await this.ctx.storage.put(key, s);
    this.broadcast({ t: 'upsert', session: s });
  }

  // -- push ------------------------------------------------------------------

  private async subscriptions(): Promise<PushSubscriptionJSON[]> {
    return (await this.ctx.storage.get<PushSubscriptionJSON[]>('push')) ?? [];
  }

  async addPush(sub: unknown, origin: string): Promise<boolean> {
    if (!isValidSubscription(sub)) return false;
    await this.ctx.storage.put('origin', origin);
    const clean: PushSubscriptionJSON = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    const subs = (await this.subscriptions()).filter((s) => s.endpoint !== clean.endpoint);
    await this.ctx.storage.put('push', [...subs, clean].slice(-5));
    return true;
  }

  async removePush(endpoint: string): Promise<void> {
    await this.ctx.storage.put('push', (await this.subscriptions()).filter((s) => s.endpoint !== endpoint));
  }

  private windowMs(): number {
    const n = Number(this.env.PUSH_WINDOW_MS);
    return n > 0 ? n : PUSH_WINDOW_MS;
  }

  /** Quiet mode (set by the intercessor controls) silences throttled pushes, not the test button. */
  private async quiet(): Promise<boolean> {
    return ((await this.ctx.storage.get<number>('quietUntil')) ?? 0) > Date.now();
  }

  /** First alert in a window goes out at once; later ones are counted and merged by alarm(). */
  private async notePush(kind: 'requested' | 'message'): Promise<void> {
    if (this.dashboardVisible() || (await this.quiet())) return;
    const w = await this.ctx.storage.get<PushWindow>('pushWindow');
    // A window whose alarm was lost (e.g. a deploy reset it) must not swallow alerts forever.
    const stale = !!w && w.end + this.windowMs() < Date.now();
    if (w && !stale) {
      w[kind]++;
      await this.ctx.storage.put('pushWindow', w);
      return;
    }
    const end = Date.now() + this.windowMs();
    await this.ctx.storage.put('pushWindow', { end, requested: 0, message: 0 } satisfies PushWindow);
    await this.ctx.storage.setAlarm(end);
    this.ctx.waitUntil(this.push(PUSH_TEXT[kind]!, 'high', true).catch(() => 0));
  }

  async alarm(): Promise<void> {
    try {
      const w = await this.ctx.storage.get<PushWindow>('pushWindow');
      if (!w) return;
      if (!w.requested && !w.message) {
        await this.ctx.storage.delete('pushWindow');
        return;
      }
      // Reset and re-arm before sending, so a failing push service can never cause a retry loop.
      const end = Date.now() + this.windowMs();
      await this.ctx.storage.put('pushWindow', { end, requested: 0, message: 0 } satisfies PushWindow);
      await this.ctx.storage.setAlarm(end);
      // Counts are intentionally discarded while quiet or while the dashboard is open.
      if (this.dashboardVisible() || (await this.quiet())) return;
      await this.push(mergedText(w.requested, w.message), 'normal', false);
    } catch {
      /* never throw from an alarm */
    }
  }

  /** Raw, unthrottled send of one generic line to every subscribed device. Returns how many accepted it. */
  async push(text: string, urgency: PushUrgency = 'high', alert = true): Promise<number> {
    const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = this.env;
    if (!publicKey || !privateKey) return 0;
    const subs = await this.subscriptions();
    // Push services require a contact URL; this site's own address keeps it impersonal.
    const subject = this.env.VAPID_SUBJECT || (await this.ctx.storage.get<string>('origin')) || 'https://example.com';
    let delivered = 0;
    const dead: string[] = [];
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const status = await this.sender(sub, JSON.stringify({ body: text, alert }), {
            publicKey,
            privateKey,
            subject,
          }, urgency);
          if (status >= 200 && status < 300) delivered++;
          if (status === 404 || status === 410) dead.push(sub.endpoint);
        } catch {
          /* network trouble: try again on the next event */
        }
      }),
    );
    if (dead.length) await this.ctx.storage.put('push', subs.filter((s) => !dead.includes(s.endpoint)));
    return delivered;
  }

  // -- live dashboard --------------------------------------------------------

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ visible: true });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'visible') ws.serializeAttachment({ visible: true });
    if (message === 'hidden') ws.serializeAttachment({ visible: false });
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private dashboardVisible(): boolean {
    return this.ctx.getWebSockets().some((ws) => (ws.deserializeAttachment() as { visible?: boolean } | null)?.visible);
  }

  private broadcast(event: StationEvent): void {
    const text = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* socket went away */
      }
    }
  }
}
