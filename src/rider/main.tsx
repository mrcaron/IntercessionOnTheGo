// The page a rider lands on after scanning the hat.

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, clock, live, timeLeft } from '../shared/client';
import {
  b64u,
  deriveSessionKeys,
  messageContext,
  randomBytes,
  requestContext,
  seal,
  sha256,
  stationIdFromCode,
  unb64u,
  wrapSessionKey,
  type SessionKeys,
} from '../shared/crypto';
import '../shared/style.css';
import { Partners } from '../shared/partners';
import { applyEvent, Chat, Confirm, useDecrypted, useNow } from '../shared/thread';
import { Toast, useToast } from '../shared/toast';
import type { SessionEvent, SessionView, StationPublic } from '../shared/types';

type Screen =
  | { kind: 'loading' }
  | { kind: 'home' }
  | { kind: 'offduty'; name: string }
  | { kind: 'gone' }
  | { kind: 'trouble' }
  | { kind: 'page'; view: SessionView; keys: SessionKeys };

const remember = (stationId: string) => `mps:${stationId}`;

// Which prayer the rider has already been told about, per page, so a reload does not announce it again.
const seenKey = (pageId: string) => `mps-seen:${pageId}`;
const seenInMemory = new Map<string, string>();

function seenPrayer(pageId: string): string | null {
  const mem = seenInMemory.get(pageId);
  if (mem) return mem;
  try {
    return localStorage.getItem(seenKey(pageId));
  } catch {
    return null;
  }
}

function markPrayerSeen(pageId: string, prayedAt: number) {
  seenInMemory.set(pageId, String(prayedAt));
  try {
    localStorage.setItem(seenKey(pageId), String(prayedAt));
  } catch {
    /* storage unavailable */
  }
}

function forget(pageId: string) {
  seenInMemory.delete(pageId);
  try {
    localStorage.removeItem(seenKey(pageId));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)!;
      if (key.startsWith('mps:') && localStorage.getItem(key)?.startsWith(`${pageId}#`)) localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable */
  }
}

async function loadPage(id: string, k: string): Promise<Screen> {
  const keys = await deriveSessionKeys(unb64u(k));
  const view = await api<SessionView>(`sessions/${id}`, { token: keys.auth });
  return { kind: 'page', view, keys };
}

async function boot(): Promise<Screen> {
  // Returning via bookmark: /p/<page id>#<page key>
  const existing = location.pathname.match(/^\/p\/([A-Za-z0-9_-]{22})$/);
  if (existing) {
    try {
      return await loadPage(existing[1], location.hash.slice(1));
    } catch (err) {
      if (err instanceof ApiError && err.status !== 404) return { kind: 'trouble' };
      forget(existing[1]);
      return { kind: 'gone' };
    }
  }

  // Fresh scan: /#k=<intercessor's public key>
  const code = new URLSearchParams(location.hash.slice(1)).get('k');
  if (!code) return { kind: 'home' };
  let stationId: string;
  try {
    stationId = await stationIdFromCode(code);
  } catch {
    return { kind: 'home' };
  }

  // Scanning twice should bring you back to the same page, not start a second one.
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(remember(stationId));
  } catch {
    /* storage unavailable */
  }
  if (saved) {
    const [id, k] = saved.split('#');
    try {
      const screen = await loadPage(id, k);
      history.replaceState(null, '', `/p/${id}#${k}`);
      return screen;
    } catch {
      forget(id);
    }
  }

  let info: StationPublic;
  try {
    info = await api<StationPublic>(`station/${stationId}`);
  } catch (err) {
    return err instanceof ApiError && err.status === 404 ? { kind: 'home' } : { kind: 'trouble' };
  }
  if (!info.onDuty) return { kind: 'offduty', name: info.name };

  // Make the page key here, on this phone. The server only ever sees it wrapped.
  const k = randomBytes(32);
  const keys = await deriveSessionKeys(k);
  try {
    const view = await api<SessionView>('sessions', {
      body: {
        station: stationId,
        authHash: b64u(await sha256(keys.auth)),
        wrappedKey: await wrapSessionKey(code, k),
      },
    });
    const kText = b64u(k);
    try {
      localStorage.setItem(remember(stationId), `${view.id}#${kText}`);
    } catch {
      /* storage unavailable */
    }
    history.replaceState(null, '', `/p/${view.id}#${kText}`);
    return { kind: 'page', view, keys };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'off-duty') return { kind: 'offduty', name: info.name };
    return { kind: 'trouble' };
  }
}

function Screens() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  useEffect(() => {
    boot().then(setScreen, () => setScreen({ kind: 'trouble' }));
  }, []);

  switch (screen.kind) {
    case 'loading':
      return <p class="muted">Opening a private page…</p>;
    case 'home':
      return (
        <Notice title="Mobile Prayer Station">
          <p>This is a quiet place to ask someone to pray for you. It opens when you scan the code on a prayer station hat.</p>
        </Notice>
      );
    case 'offduty':
      return (
        <Notice title={`Hi, I'm ${screen.name}.`}>
          <p>I'm not out praying right now, so this page isn't taking requests at the moment. If you see me again, scan the hat and say hello.</p>
          <p>God sees you and loves you deeply.</p>
        </Notice>
      );
    case 'gone':
      return (
        <Notice title="Nothing is here.">
          <p>If there was a prayer page at this address, it has erased itself. Nothing was kept.</p>
        </Notice>
      );
    case 'trouble':
      return (
        <Notice title="This page couldn't load.">
          <p>The connection dropped. Please try again in a moment.</p>
          <button class="primary" onClick={() => location.reload()}>
            Try again
          </button>
        </Notice>
      );
    case 'page':
      return <Page initial={screen.view} keys={screen.keys} onGone={() => setScreen({ kind: 'gone' })} />;
  }
}

function App() {
  return (
    <>
      <Screens />
      <Partners />
    </>
  );
}

function Notice(props: { title: string; children: preact.ComponentChildren }) {
  return (
    <main>
      <p class="eyebrow">Mobile Prayer Station</p>
      <h1>{props.title}</h1>
      <div class="lead" style="margin-top:16px">
        {props.children}
      </div>
    </main>
  );
}

function Page(props: { initial: SessionView; keys: SessionKeys; onGone(): void }) {
  const { keys } = props;
  const [view, setView] = useState(props.initial);
  const { request, messages } = useDecrypted(view, keys.enc);
  const now = useNow();
  const id = view.id;
  const call = { token: keys.auth };

  const gone = () => {
    forget(id);
    props.onGone();
  };

  const refresh = () =>
    api<SessionView>(`sessions/${id}`, call).then(setView, (err) => {
      if (err instanceof ApiError && err.status === 404) gone();
    });

  useEffect(() => {
    let first = true;
    const socket = live<SessionEvent>(`sessions/${id}/ws`, {
      token: keys.auth,
      onEvent: (e) =>
        setView((v) => {
          const next = applyEvent(v, e);
          if (!next) queueMicrotask(gone);
          return next ?? v;
        }),
      onUp: () => {
        if (!first) refresh(); // catch up on anything missed while offline
        first = false;
      },
      onDown: refresh,
    });
    return () => socket.close();
  }, [id]);

  useEffect(() => {
    if (now >= view.expiresAt) refresh();
  }, [now, view.expiresAt]);

  // Tell the rider the moment they have been prayed for, wherever they have scrolled to.
  // A prayer is announced once: live when it happens, or once on return if it happened while they were away.
  const { toast, show, dismiss } = useToast();
  useEffect(() => {
    if (view.state !== 'prayed' || !view.prayedAt) return;
    if (seenPrayer(id) === String(view.prayedAt)) return;
    markPrayerSeen(id, view.prayedAt);
    show(`I prayed for you at ${clock(view.prayedAt)}.`);
  }, [id, view.state, view.prayedAt]);

  const host = view.host ?? { name: 'a friend', place: 'near you' };
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <main>
      <Toast toast={toast} onDismiss={dismiss} />
      <p class="eyebrow">Mobile Prayer Station</p>
      <h1>Hi there, I'm {host.name}.</h1>
      <div class="lead" style="margin-top:16px">
        <p>
          I am an apprentice of Jesus praying over you right now {host.place}. I want you to know that God sees you and loves you
          deeply, in the midst of the joys and sorrows you are carrying. The sign is that you saw me and got here.
        </p>
      </div>

      {view.state === 'prayed' && view.prayedAt && (
        <div class="banner good" role="status">
          🙏 I prayed for you at {clock(view.prayedAt)}.
        </div>
      )}

      {view.request ? (
        <section class="card stack" aria-label="What you shared">
          <p class="eyebrow" style="margin:0">
            You shared{view.requestAt ? ` at ${clock(view.requestAt)}` : ''}
          </p>
          {request?.name && (
            <p style="margin:0">
              <strong>{request.name}</strong>
            </p>
          )}
          {request?.text && <p class="shared">{request.text}</p>}
          {view.state === 'requested' && (
            <p class="muted small" role="status">
              Sent. Keep this page open or come back to it, and you'll see here the moment I've prayed for you.
            </p>
          )}
        </section>
      ) : (
        <RequestForm
          onSend={async (content) => {
            const body = await seal(keys.enc, requestContext(id), JSON.stringify(content));
            await api(`sessions/${id}/request`, { ...call, body: { body } });
            await refresh();
          }}
        />
      )}

      <section class="card stack">
        <h2>Chat with me</h2>
        <p class="muted small">Anonymous, and not attached to any phone number.</p>
        {chatOpen || messages.length > 0 ? (
          <Chat
            messages={messages}
            me="rider"
            placeholder="Write a message"
            onSend={async (text) => {
              const body = await seal(keys.enc, messageContext(id, 'rider'), text);
              await api(`sessions/${id}/messages`, { ...call, body: { body } });
              await refresh();
            }}
          />
        ) : (
          <button onClick={() => setChatOpen(true)}>💬 Start a chat</button>
        )}
      </section>

      <section class="fuse stack">
        <p>
          This page erases itself in <strong>{timeLeft(view.expiresAt - now)}</strong>, with zero record.
        </p>
        <div class="row wrap">
          <button
            onClick={async () => {
              const { expiresAt } = await api<{ expiresAt: number }>(`sessions/${id}/pause`, { ...call, method: 'POST' });
              setView((v) => ({ ...v, expiresAt }));
            }}
          >
            Pause: keep it one more day
          </button>
          <Confirm
            label="Erase now"
            confirm="Tap again to erase everything"
            onConfirm={() => api(`sessions/${id}`, { ...call, method: 'DELETE' }).then(gone, gone)}
          />
        </div>
        <p class="muted small">
          This is confidential and will not be shared with anyone else, sold or otherwise published anywhere. Only you and I can see this
          space: what you write is locked on your phone and only my phone can open it. You can bookmark this page and come back any
          time before it erases.
        </p>
      </section>
    </main>
  );
}

function RequestForm(props: { onSend(content: { name: string; text: string }): Promise<void> }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const empty = !name.trim() && !text.trim();

  const send = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await props.onSend({ name: name.trim(), text: text.trim() });
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <section class="card stack">
      <p>
        I would love to pray more specifically for your needs as you feel open to sharing them. Feel free to ignore me, or introduce
        yourself personally if you're comfortable. If you'd like to remain discreet, tell me below how to pray for you, or merely share
        your name.
      </p>
      <div>
        <label for="name">Your name (optional)</label>
        <input id="name" type="text" autocomplete="off" maxLength={80} value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </div>
      <div>
        <label for="text">How can I pray for you? (optional)</label>
        <textarea id="text" maxLength={3000} value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </div>
      <button class="primary hands" disabled={busy || empty} onClick={send}>
        <span class="emoji" aria-hidden="true">
          🙏
        </span>
        {busy ? 'Sending…' : 'Send it off'}
      </button>
      {failed && <p class="error">That didn't send. Check your connection and try again.</p>}
    </section>
  );
}

render(<App />, document.getElementById('app')!);
