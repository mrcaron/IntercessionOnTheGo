// HTTP entry point: routes API calls to the two Durable Objects and serves the
// static pages. Nothing here writes logs or stores anything about a request.

import { b64u, randomBytes, stationIdFromCode, unb64u } from '../shared/crypto';
import type { SessionView, WriteRefusal } from '../shared/types';
import type { Env } from './env';
import type { Auth } from './session-do';

export { SessionDO } from './session-do';
export { StationDO } from './station-do';

const ID = /^[A-Za-z0-9_-]{22}$/;
const COOKIE = 'mps_host';
const MAX_BODY = 16_000;
const GONE = () => json({ error: 'gone' }, 404);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return withPageHeaders(await env.ASSETS.fetch(request), url);
    try {
      return await api(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      return json({ error: 'server' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.slice(5).split('/');
  const route = `${request.method} ${parts.map((p, i) => (i > 0 && ID.test(p) ? ':id' : p)).join('/')}`;
  const id = parts[1] ?? '';
  if (request.method !== 'GET') sameOrigin(request, url);

  switch (route) {
    // ---- rider and shared --------------------------------------------------
    case 'GET station/:id': {
      const info = await station(env, id).publicInfo();
      return info ? json(info) : GONE();
    }
    case 'POST sessions': {
      await limit(env.CREATE_LIMIT, request);
      const body = await read<{ station: string; authHash: string; wrappedKey: string }>(request);
      if (!ID.test(body.station ?? '') || !isBytes(body.authHash, 32) || !isBytes(body.wrappedKey, 125)) throw new HttpError(400);
      const info = await station(env, body.station).publicInfo();
      if (!info) return GONE();
      if (!info.onDuty) return json({ error: 'off-duty' }, 403);
      const newId = b64u(randomBytes(16));
      const view = await session(env, newId).create({ id: newId, ...pick(body) });
      if (!view) throw new HttpError(500);
      return json(forRider(view, info), 201);
    }
    case 'GET sessions/:id': {
      const auth = await sessionAuth(request, env);
      // The dashboard can peek (read without marking chat messages as read) to learn a name for the list.
      const view = auth && (await session(env, id).view(auth, url.searchParams.get('peek') === '1'));
      if (!view) return GONE();
      return json(auth.role === 'rider' ? forRider(view, await station(env, view.station).publicInfo()) : view);
    }
    case 'POST sessions/:id/request': {
      await limit(env.WRITE_LIMIT, request);
      const auth = await sessionAuth(request, env);
      const { body } = await read<{ body: string }>(request);
      const res = auth && (await session(env, id).setRequest(auth, body));
      if (!res) return GONE();
      return res.ok ? json({ ok: true }) : refused(res.code);
    }
    case 'POST sessions/:id/messages': {
      await limit(env.WRITE_LIMIT, request);
      const auth = await sessionAuth(request, env);
      const { body } = await read<{ body: string }>(request);
      const res = auth && (await session(env, id).addMessage(auth, body));
      if (!res) return GONE();
      return res.ok ? json(res.msg, 201) : refused(res.code);
    }
    case 'POST sessions/:id/pause': {
      await limit(env.WRITE_LIMIT, request);
      const auth = await sessionAuth(request, env);
      const res = auth && (await session(env, id).pause(auth));
      if (!res) return GONE();
      return res.ok ? json({ expiresAt: res.expiresAt }) : refused(res.code);
    }
    case 'POST sessions/:id/prayed': {
      const auth = await sessionAuth(request, env);
      return auth && (await session(env, id).markPrayed(auth)) ? json({ ok: true }) : GONE();
    }
    case 'DELETE sessions/:id': {
      const auth = await sessionAuth(request, env);
      return auth && (await session(env, id).erase(auth)) ? json({ ok: true }) : GONE();
    }
    case 'GET sessions/:id/ws': {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426);
      sameOrigin(request, url);
      const auth = await sessionAuth(request, env);
      if (!auth) return GONE();
      const headers = new Headers(request.headers);
      headers.set('x-mps-auth', JSON.stringify(auth));
      return session(env, id).fetch(new Request(request, { headers }));
    }

    // ---- intercessor -------------------------------------------------------
    case 'POST setup': {
      await limit(env.CREATE_LIMIT, request);
      const body = await read<{ setupToken: string; code: string; sigPub: string; name: string; place: string }>(request);
      if (!env.SETUP_TOKEN || !safeEqual(body.setupToken ?? '', env.SETUP_TOKEN)) throw new HttpError(403, 'bad-setup-token');
      if (!isBytes(body.sigPub, 65)) throw new HttpError(400);
      let stationId: string;
      try {
        stationId = await stationIdFromCode(body.code);
      } catch {
        throw new HttpError(400);
      }
      const ok = await station(env, stationId).register({
        id: stationId,
        code: body.code,
        sigPub: body.sigPub,
        ...profileFields(body),
      });
      if (!ok) throw new HttpError(409);
      return json({ station: stationId }, 201);
    }
    case 'POST login/challenge': {
      await limit(env.CREATE_LIMIT, request);
      const body = await read<{ station: string }>(request);
      if (!ID.test(body.station ?? '')) throw new HttpError(400);
      const nonce = await station(env, body.station).challenge();
      return nonce ? json({ nonce }) : GONE();
    }
    case 'POST login': {
      const body = await read<{ station: string; nonce: string; signature: string }>(request);
      if (!ID.test(body.station ?? '') || typeof body.nonce !== 'string' || typeof body.signature !== 'string') throw new HttpError(400);
      const token = await station(env, body.station).login(body.nonce, body.signature);
      if (!token) throw new HttpError(401);
      return json({ ok: true }, 200, {
        'Set-Cookie': `${COOKIE}=${body.station}.${token}; Path=/api; Max-Age=${30 * 24 * 3600}; HttpOnly; Secure; SameSite=Strict`,
      });
    }
    case 'POST logout': {
      const host = await hostAuth(request, env);
      if (host) await station(env, host.station).logout(host.token);
      return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
    }
    case 'GET host': {
      const host = await requireHost(request, env);
      const index = await station(env, host.station).index();
      return index ? json({ ...index, pushKey: env.VAPID_PRIVATE_KEY ? (env.VAPID_PUBLIC_KEY ?? null) : null }) : GONE();
    }
    case 'POST host/profile': {
      const host = await requireHost(request, env);
      const { name, place } = profileFields(await read<{ name: string; place: string }>(request));
      await station(env, host.station).updateProfile(name, place);
      return json({ ok: true });
    }
    case 'POST host/duty': {
      const host = await requireHost(request, env);
      const { on } = await read<{ on: boolean }>(request);
      return json({ onDutyUntil: await station(env, host.station).setDuty(on === true) });
    }
    case 'POST host/push': {
      const host = await requireHost(request, env);
      const { subscription } = await read<{ subscription: unknown }>(request);
      if (!(await station(env, host.station).addPush(subscription, url.origin))) throw new HttpError(400);
      return json({ ok: true });
    }
    case 'DELETE host/push': {
      const host = await requireHost(request, env);
      const { endpoint } = await read<{ endpoint: string }>(request);
      await station(env, host.station).removePush(String(endpoint));
      return json({ ok: true });
    }
    case 'POST host/push/test': {
      const host = await requireHost(request, env);
      return json({ delivered: await station(env, host.station).push('Test: notifications are working.') });
    }
    case 'GET host/ws': {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426);
      sameOrigin(request, url);
      const host = await requireHost(request, env);
      return station(env, host.station).fetch(request);
    }
  }
  return json({ error: 'not-found' }, 404);
}

// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message = 'bad-request',
  ) {
    super(message);
  }
}

const station = (env: Env, id: string) => env.STATION.get(env.STATION.idFromName(id));
const session = (env: Env, id: string) => env.SESSION.get(env.SESSION.idFromName(id));

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Parses a small JSON object. Field types are not trusted; each route validates what it uses. */
async function read<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413);
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object') return v;
  } catch {
    /* fall through */
  }
  throw new HttpError(400);
}

const pick = (b: { station?: string; authHash?: string; wrappedKey?: string }) => ({
  station: b.station!,
  authHash: b.authHash!,
  wrappedKey: b.wrappedKey!,
});

function profileFields(b: { name?: unknown; place?: unknown }): { name: string; place: string } {
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
  const name = clean(b.name, 40);
  if (!name) throw new HttpError(400, 'name-required');
  return { name, place: clean(b.place, 60) || 'on the bus' };
}

function isBytes(v: unknown, length: number): v is string {
  try {
    return typeof v === 'string' && unb64u(v).length === length;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length || 0);
  return diff === 0;
}

/** Browsers send Origin on writes and WebSocket upgrades; reject other sites. */
function sameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'cross-origin');
}

async function limit(limiter: RateLimit | undefined, request: Request): Promise<void> {
  if (!limiter) return;
  const key = request.headers.get('cf-connecting-ip') ?? 'local';
  if (!(await limiter.limit({ key })).success) throw new HttpError(429, 'slow-down');
}

async function hostAuth(request: Request, env: Env): Promise<{ station: string; token: string } | null> {
  const match = (request.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{22})\\.([A-Za-z0-9_-]{43})`));
  if (!match) return null;
  const [, stationId, token] = match;
  return (await station(env, stationId).checkAuth(token)) ? { station: stationId, token } : null;
}

async function requireHost(request: Request, env: Env) {
  const host = await hostAuth(request, env);
  if (!host) throw new HttpError(401, 'login-required');
  return host;
}

/** A rider presents the token derived from their page key; the intercessor presents a login cookie. */
async function sessionAuth(request: Request, env: Env): Promise<Auth | null> {
  const bearer = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (bearer) return { role: 'rider', token: bearer };
  // Browsers cannot set headers on a WebSocket, so the rider's token rides in the subprotocol list.
  const proto = request.headers.get('sec-websocket-protocol')?.match(/^mps,\s*([A-Za-z0-9_-]{43})$/)?.[1];
  if (proto) return { role: 'rider', token: proto };
  const host = await hostAuth(request, env);
  return host ? { role: 'host', station: host.station } : null;
}

// Refusal code -> HTTP status for rider writes. Limits are 429; a state conflict is 409.
const REFUSAL_STATUS: Record<WriteRefusal, number> = {
  'limit-request': 429,
  'limit-pause': 429,
  'limit-chat': 429,
  'wait-for-reply': 429,
  'too-fast': 429,
  'already-prayed': 409,
};

const refused = (code: WriteRefusal) => json({ error: code }, REFUSAL_STATUS[code]);

function forRider(view: SessionView, info: { name: string; place: string } | null): SessionView {
  return { ...view, host: info ? { name: info.name, place: info.place } : undefined };
}

function withPageHeaders(res: Response, url: URL): Response {
  const out = new Response(res.body, res);
  const ws = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  out.headers.set(
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ${ws}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  );
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (res.headers.get('content-type')?.includes('text/html')) out.headers.set('Cache-Control', 'no-cache');
  return out;
}
