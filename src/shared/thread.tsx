// Pieces used by both the rider page and the dashboard: decrypting a page's
// content, the chat thread, and a two-step confirm button.

import { useEffect, useRef, useState } from 'preact/hooks';
import { clock } from './client';
import { messageContext, open, requestContext } from './crypto';
import type { RequestContent, Role, SessionEvent, SessionView } from './types';

export interface PlainMessage {
  seq: number;
  from: Role;
  ts: number;
  text: string;
}

const UNREADABLE = '[could not be decrypted]';

/** Decrypts the request and messages of a page as they arrive. */
export function useDecrypted(view: SessionView | null, enc: CryptoKey | null) {
  const [request, setRequest] = useState<RequestContent | null>(null);
  const [messages, setMessages] = useState<PlainMessage[]>([]);
  const cache = useRef(new Map<number, PlainMessage>());

  useEffect(() => {
    if (!view || !enc) return;
    let stale = false;
    (async () => {
      let req: RequestContent | null = null;
      if (view.request) {
        try {
          const parsed = JSON.parse(await open(enc, requestContext(view.id), view.request)) as Partial<RequestContent>;
          req = { name: String(parsed.name ?? ''), text: String(parsed.text ?? '') };
        } catch {
          req = { name: '', text: UNREADABLE };
        }
      }
      const out: PlainMessage[] = [];
      for (const m of view.messages) {
        let plain = cache.current.get(m.seq);
        if (!plain) {
          let text = UNREADABLE;
          try {
            text = await open(enc, messageContext(view.id, m.from), m.body);
          } catch {
            /* keep the placeholder */
          }
          plain = { seq: m.seq, from: m.from, ts: m.ts, text };
          cache.current.set(m.seq, plain);
        }
        out.push(plain);
      }
      if (!stale) {
        setRequest(req);
        setMessages(out);
      }
    })();
    return () => {
      stale = true;
    };
  }, [view, enc]);

  return { request, messages };
}

/** Folds a live event into the current view. Returns null when the page is gone. */
export function applyEvent(view: SessionView, e: SessionEvent): SessionView | null {
  switch (e.t) {
    case 'gone':
      return null;
    case 'state':
      return { ...view, state: e.state, prayedAt: e.prayedAt, expiresAt: e.expiresAt };
    case 'request':
      return { ...view, request: e.request, requestAt: e.requestAt, state: e.state, prayedAt: null };
    case 'msg':
      return view.messages.some((m) => m.seq === e.msg.seq) ? view : { ...view, messages: [...view.messages, e.msg] };
  }
}

export function Chat(props: {
  messages: PlainMessage[];
  me: Role;
  placeholder: string;
  onSend(text: string): Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const count = props.messages.length;

  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: 'nearest' });
  }, [count]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await props.onSend(text);
      setDraft('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack">
      {count > 0 && (
        <div class="chat" aria-live="polite">
          {props.messages.map((m) => (
            <div key={m.seq} class={`bubble ${m.from === props.me ? 'me' : ''}`}>
              {m.text}
              <time>{clock(m.ts)}</time>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
      <div class="composer">
        <textarea
          class="grow"
          aria-label="Message"
          placeholder={props.placeholder}
          maxLength={1500}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button class="primary" disabled={busy || !draft.trim()} onClick={send}>
          Send
        </button>
      </div>
      {failed && <p class="error">That didn't send. Check your connection and try again.</p>}
    </div>
  );
}

/** A button that asks once more before doing something that cannot be undone. */
export function Confirm(props: { label: string; confirm: string; class?: string; onConfirm(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button class={`danger ${props.class ?? ''}`} onClick={props.onConfirm}>
      {props.confirm}
    </button>
  ) : (
    <button class={props.class} onClick={() => setArmed(true)}>
      {props.label}
    </button>
  );
}

/** Re-renders on an interval so countdowns stay current. */
export function useNow(everyMs = 15000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
