// Small browser helpers shared by the rider page and the dashboard.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`/api/${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error');
  return data as T;
}

export interface Live {
  send(text: string): void;
  close(): void;
}

/**
 * A listening WebSocket that reconnects by itself. `onUp` fires on every
 * (re)connection and `onDown` after every failed attempt, so the caller can
 * re-fetch and learn whether the page still exists.
 */
export function live<E>(
  path: string,
  opts: { token?: string; onEvent(e: E): void; onUp?(): void; onDown?(): void },
): Live {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const connect = () => {
    if (closed) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/${path}`;
    const socket = opts.token ? new WebSocket(url, ['mps', opts.token]) : new WebSocket(url);
    ws = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      delay = 1000;
      opts.onUp?.();
    };
    socket.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        opts.onEvent(JSON.parse(e.data as string) as E);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (closed) return;
      if (!opened) opts.onDown?.();
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
  };

  const wake = () => {
    if (document.visibilityState === 'visible' && !ws && !closed) {
      clearTimeout(timer);
      delay = 1000;
      connect();
    }
  };
  document.addEventListener('visibilitychange', wake);
  ping = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
  }, 25000);
  connect();

  return {
    send(text) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(text);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      document.removeEventListener('visibilitychange', wake);
      ws?.close();
    },
  };
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "42 min", "3 h 10 min", "2 days" */
export function timeLeft(ms: number): string {
  const min = Math.ceil(ms / 60000);
  if (min <= 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}
