// One Durable Object per prayer page. It holds only ciphertext plus timing and
// status, and wipes itself when its alarm fires.

import { DurableObject } from 'cloudflare:workers';
import { b64u, sha256 } from '../shared/crypto';
import {
  MAX_MESSAGES,
  MAX_SEALED_MESSAGE,
  MAX_SEALED_REQUEST,
  PAUSE_EXTENSION,
  SESSION_LIFETIME,
  type Message,
  type NotifyKind,
  type Role,
  type SessionEvent,
  type SessionState,
  type SessionSummary,
  type SessionView,
} from '../shared/types';
import type { Env } from './env';

export type Auth = { role: 'rider'; token: string } | { role: 'host'; station: string };

interface Meta {
  id: string;
  station: string;
  authHash: string;
  wrappedKey: string;
  createdAt: number;
  expiresAt: number;
  state: SessionState;
  prayedAt: number | null;
  request: string | null;
  requestAt: number | null;
  hasChat: boolean;
  seq: number;
}

const msgKey = (seq: number) => `m:${String(seq).padStart(6, '0')}`;

export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // -- lifecycle -------------------------------------------------------------

  async create(input: { id: string; station: string; authHash: string; wrappedKey: string }): Promise<SessionView | null> {
    if (await this.ctx.storage.get('meta')) return null;
    const now = Date.now();
    const meta: Meta = {
      ...input,
      createdAt: now,
      expiresAt: now + SESSION_LIFETIME,
      state: 'opened',
      prayedAt: null,
      request: null,
      requestAt: null,
      hasChat: false,
      seq: 0,
    };
    await this.ctx.storage.put('meta', meta);
    await this.ctx.storage.setAlarm(meta.expiresAt);
    await this.notify(meta, 'opened');
    return this.toView(meta, [], 'rider');
  }

  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>('meta');
    if (!meta) return;
    if (Date.now() < meta.expiresAt) {
      await this.ctx.storage.setAlarm(meta.expiresAt);
      return;
    }
    await this.destroy(meta);
  }

  /** Erase everything. After this the object is indistinguishable from one that never existed. */
  private async destroy(meta: Meta): Promise<void> {
    this.broadcast({ t: 'gone' });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'gone');
      } catch {
        /* already closed */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.station(meta).sessionGone(meta.id);
  }

  // -- access ----------------------------------------------------------------

  /** Loads the page if it exists, has not expired, and the caller may see it. */
  private async load(auth: Auth): Promise<Meta | null> {
    const meta = await this.ctx.storage.get<Meta>('meta');
    if (!meta) return null;
    if (Date.now() >= meta.expiresAt) {
      await this.destroy(meta);
      return null;
    }
    if (auth.role === 'host') return auth.station === meta.station ? meta : null;
    return b64u(await sha256(auth.token)) === meta.authHash ? meta : null;
  }

  /** `peek` reads without counting as opening the page, so unread messages stay unread. */
  async view(auth: Auth, peek = false): Promise<SessionView | null> {
    const meta = await this.load(auth);
    if (!meta) return null;
    const messages = [...(await this.ctx.storage.list<Message>({ prefix: 'm:' })).values()];
    if (auth.role === 'host' && !peek) await this.station(meta).markRead(meta.id);
    return this.toView(meta, messages, auth.role);
  }

  async setRequest(auth: Auth, body: string): Promise<boolean> {
    const meta = await this.load(auth);
    if (!meta || auth.role !== 'rider' || !validSealed(body, MAX_SEALED_REQUEST)) return false;
    meta.request = body;
    meta.requestAt = Date.now();
    meta.state = 'requested';
    meta.prayedAt = null;
    await this.ctx.storage.put('meta', meta);
    this.broadcast({ t: 'request', request: body, requestAt: meta.requestAt, state: meta.state });
    await this.notify(meta, 'requested');
    return true;
  }

  async addMessage(auth: Auth, body: string): Promise<Message | null> {
    const meta = await this.load(auth);
    if (!meta || !validSealed(body, MAX_SEALED_MESSAGE) || meta.seq >= MAX_MESSAGES) return null;
    meta.seq += 1;
    const msg: Message = { seq: meta.seq, from: auth.role, ts: Date.now(), body };
    if (auth.role === 'rider') meta.hasChat = true;
    await this.ctx.storage.put({ meta, [msgKey(msg.seq)]: msg });
    this.broadcast({ t: 'msg', msg });
    await this.notify(meta, auth.role === 'rider' ? 'message' : 'update');
    return msg;
  }

  async pause(auth: Auth): Promise<number | null> {
    const meta = await this.load(auth);
    if (!meta || auth.role !== 'rider') return null;
    meta.expiresAt += PAUSE_EXTENSION;
    await this.ctx.storage.put('meta', meta);
    await this.ctx.storage.setAlarm(meta.expiresAt);
    this.broadcastState(meta);
    await this.notify(meta, 'update');
    return meta.expiresAt;
  }

  async markPrayed(auth: Auth): Promise<boolean> {
    const meta = await this.load(auth);
    if (!meta || auth.role !== 'host') return false;
    meta.state = 'prayed';
    meta.prayedAt = Date.now();
    await this.ctx.storage.put('meta', meta);
    this.broadcastState(meta);
    await this.notify(meta, 'update');
    return true;
  }

  async erase(auth: Auth): Promise<boolean> {
    const meta = await this.load(auth);
    if (!meta) return false;
    await this.destroy(meta);
    return true;
  }

  // -- live updates ----------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const authHeader = request.headers.get('x-mps-auth');
    const auth = authHeader ? (JSON.parse(authHeader) as Auth) : null;
    if (!auth || !(await this.load(auth))) return new Response(null, { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [auth.role]);
    const headers = new Headers();
    if (request.headers.get('sec-websocket-protocol')) headers.set('Sec-WebSocket-Protocol', 'mps');
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }

  webSocketMessage(): void {
    /* clients only listen */
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private broadcast(event: SessionEvent): void {
    const text = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* socket went away */
      }
    }
  }

  private broadcastState(meta: Meta): void {
    this.broadcast({ t: 'state', state: meta.state, prayedAt: meta.prayedAt, expiresAt: meta.expiresAt });
  }

  // -- helpers ---------------------------------------------------------------

  private station(meta: Meta) {
    return this.env.STATION.get(this.env.STATION.idFromName(meta.station));
  }

  private async notify(meta: Meta, kind: NotifyKind): Promise<void> {
    const summary: Omit<SessionSummary, 'unread'> = {
      id: meta.id,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      state: meta.state,
      prayedAt: meta.prayedAt,
      hasRequest: meta.request !== null,
      hasChat: meta.hasChat,
    };
    await this.station(meta).sessionEvent(summary, kind);
  }

  private toView(meta: Meta, messages: Message[], role: Role): SessionView {
    return {
      id: meta.id,
      station: meta.station,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      state: meta.state,
      prayedAt: meta.prayedAt,
      request: meta.request,
      requestAt: meta.requestAt,
      messages,
      ...(role === 'host' ? { wrappedKey: meta.wrappedKey } : {}),
    };
  }
}

function validSealed(body: unknown, max: number): body is string {
  // 12-byte iv + 16-byte tag is 28 bytes, i.e. at least 38 base64url characters.
  return typeof body === 'string' && body.length >= 38 && body.length <= max && /^[A-Za-z0-9_-]+$/.test(body);
}
