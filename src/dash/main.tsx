// The intercessor's dashboard: who needs prayer, and how long each page has left.

import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { api, ApiError, clock, live, timeLeft, type Live } from '../shared/client';
import {
  b64u,
  deriveSessionKeys,
  exportBackup,
  generateStationKeys,
  importBackup,
  loginChallengeText,
  messageContext,
  rawPublic,
  seal,
  signText,
  stationCode,
  stationIdFromCode,
  unb64u,
  unwrapSessionKey,
  type SessionKeys,
  type StationKeys,
} from '../shared/crypto';
import '../shared/style.css';
import { Partners } from '../shared/partners';
import { applyEvent, Chat, Confirm, useDecrypted, useNow } from '../shared/thread';
import { QUIET_UNTIL_DUTY, type HostIndex, type SessionEvent, SessionSummary, SessionView, StationEvent } from '../shared/types';
import { clearKeys, loadKeys, saveKeys } from './keystore';
import { useTitles } from './titles';

type Index = HostIndex & { pushKey: string | null };

interface Identity {
  keys: StationKeys;
  code: string;
  id: string;
}

async function identify(keys: StationKeys): Promise<Identity> {
  const code = await stationCode(keys);
  return { keys, code, id: await stationIdFromCode(code) };
}

async function login(me: Identity): Promise<void> {
  const { nonce } = await api<{ nonce: string }>('login/challenge', { body: { station: me.id } });
  const signature = await signText(me.keys.sign.privateKey, loginChallengeText(me.id, nonce));
  await api('login', { body: { station: me.id, nonce, signature } });
}

/** Loads the dashboard, logging in first if the session has lapsed. */
async function loadIndex(me: Identity): Promise<Index> {
  try {
    return await api<Index>('host');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    await login(me);
    return api<Index>('host');
  }
}

// ---------------------------------------------------------------------------

function Screens() {
  const [me, setMe] = useState<Identity | null | undefined>(undefined);
  const [index, setIndex] = useState<Index | null>(null);
  const [needsRegistration, setNeedsRegistration] = useState(false);
  const [trouble, setTrouble] = useState(false);

  const enter = async (identity: Identity) => {
    setMe(identity);
    try {
      setIndex(await loadIndex(identity));
      setNeedsRegistration(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNeedsRegistration(true);
      else setTrouble(true);
    }
  };

  useEffect(() => {
    loadKeys().then(
      async (keys) => (keys ? enter(await identify(keys)) : setMe(null)),
      () => setMe(null),
    );
  }, []);

  if (trouble) {
    return (
      <main class="stack">
        <h1>Can't reach the station</h1>
        <p>Check your connection and try again.</p>
        <button class="primary" onClick={() => location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  if (me === undefined) return <p class="muted">Loading…</p>;
  if (!me || needsRegistration) return <Setup existing={me} onReady={enter} />;
  if (!index) return <p class="muted">Loading…</p>;
  return <Dashboard me={me} index={index} setIndex={setIndex} />;
}

function App() {
  return (
    <>
      <Screens />
      <Partners />
    </>
  );
}

// ---------------------------------------------------------------------------

function Setup(props: { existing: Identity | null; onReady(me: Identity): Promise<void> }) {
  const [name, setName] = useState('');
  const [place, setPlace] = useState('on the bus');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const me = props.existing ?? (await identify(await generateStationKeys()));
      await api('setup', {
        body: { setupToken: token.trim(), code: me.code, sigPub: b64u(await rawPublic(me.keys.sign.publicKey)), name, place },
      });
      await saveKeys(me.keys);
      await props.onReady(me);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(
        code === 'bad-setup-token'
          ? 'That setup code is not right.'
          : code === 'name-required'
            ? 'Please enter your name.'
            : 'Setup failed. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const chosen = file.current?.files?.[0];
    if (!chosen) return setError('Choose your backup file first.');
    setBusy(true);
    setError('');
    try {
      const keys = await importBackup(await chosen.text(), passphrase);
      await saveKeys(keys);
      await props.onReady(await identify(keys));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that backup.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="stack">
      <p class="eyebrow">Prayer Station</p>
      <h1>Set up your station</h1>
      {props.existing ? (
        <p class="banner">Your keys are on this device, but this server doesn't know them yet. Fill in the form to register.</p>
      ) : (
        <p>
          This creates the keys that let only this phone read what riders send you. They are stored on this device, so do the setup on
          the phone you will carry.
        </p>
      )}
      <div class="card stack">
        <div>
          <label for="name">Your first name</label>
          <input id="name" type="text" maxLength={40} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </div>
        <div>
          <label for="place">Where you'll be praying</label>
          <input id="place" type="text" maxLength={60} value={place} onInput={(e) => setPlace(e.currentTarget.value)} />
          <p class="muted small" style="margin:6px 0 0">
            Riders read: "praying for you right now {place || 'on the bus'}."
          </p>
        </div>
        <div>
          <label for="token">Setup code</label>
          <input id="token" type="password" autocomplete="off" value={token} onInput={(e) => setToken(e.currentTarget.value)} />
        </div>
        <button class="primary block" disabled={busy || !name.trim() || !token.trim()} onClick={create}>
          {busy ? 'Working…' : 'Create my station'}
        </button>
      </div>
      {!props.existing &&
        (restoring ? (
          <div class="card stack">
            <h2>Restore from a backup</h2>
            <input ref={file} type="file" accept="application/json,.json" aria-label="Backup file" />
            <div>
              <label for="pass">Backup passphrase</label>
              <input id="pass" type="password" value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} />
            </div>
            <button class="block" disabled={busy || !passphrase} onClick={restore}>
              Restore
            </button>
          </div>
        ) : (
          <button class="link" onClick={() => setRestoring(true)}>
            I have a backup file
          </button>
        ))}
      {error && <p class="error">{error}</p>}
    </main>
  );
}

// ---------------------------------------------------------------------------

function Dashboard(props: { me: Identity; index: Index; setIndex(i: Index): void }) {
  const { me, index } = props;
  const [sessions, setSessions] = useState<SessionSummary[]>(index.sessions);
  const [onDutyUntil, setOnDutyUntil] = useState(index.onDutyUntil);
  const [quietUntil, setQuietUntil] = useState(index.quietUntil);
  const [frozen, setFrozen] = useState(index.frozen);
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'settings' } | { kind: 'detail'; id: string }>({ kind: 'list' });
  const now = useNow();
  const titleOf = useTitles(me.keys, sessions);

  useEffect(() => {
    let first = true;
    let socket: Live;
    const resync = () =>
      loadIndex(me).then((fresh) => {
        setSessions(fresh.sessions);
        setOnDutyUntil(fresh.onDutyUntil);
        setQuietUntil(fresh.quietUntil);
        setFrozen(fresh.frozen);
      }, () => {});
    const report = () => socket.send(document.visibilityState === 'visible' ? 'visible' : 'hidden');
    socket = live<StationEvent>('host/ws', {
      onEvent: (e) => {
        if (e.t === 'duty') setOnDutyUntil(e.onDutyUntil);
        if (e.t === 'controls') {
          setQuietUntil(e.quietUntil);
          setFrozen(e.frozen);
        }
        if (e.t === 'remove') setSessions((list) => list.filter((s) => s.id !== e.id));
        if (e.t === 'upsert') setSessions((list) => [...list.filter((s) => s.id !== e.session.id), e.session]);
      },
      onUp: () => {
        report();
        if (!first) resync();
        first = false;
      },
      onDown: resync,
    });
    document.addEventListener('visibilitychange', report);
    return () => {
      document.removeEventListener('visibilitychange', report);
      socket.close();
    };
  }, [me]);

  const alive = useMemo(() => sessions.filter((s) => s.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt), [sessions, now]);
  const onDuty = onDutyUntil > now;
  const quiet = quietUntil > now;

  if (view.kind === 'settings') {
    return <Settings me={me} index={index} setIndex={props.setIndex} onBack={() => setView({ kind: 'list' })} />;
  }
  if (view.kind === 'detail') {
    return <Detail me={me} id={view.id} title={titleOf(sessions.find((s) => s.id === view.id))} onBack={() => setView({ kind: 'list' })} />;
  }

  const waiting = alive.filter((s) => s.state !== 'prayed' || s.unread > 0);
  const done = alive.filter((s) => s.state === 'prayed' && s.unread === 0);

  return (
    <main>
      <div class="topbar">
        <h1 class="grow">Prayer Station</h1>
        <button aria-label="Settings" onClick={() => setView({ kind: 'settings' })}>
          Settings
        </button>
      </div>

      <button
        class="switch"
        role="switch"
        aria-checked={onDuty}
        onClick={async () => {
          const res = await api<{ onDutyUntil: number }>('host/duty', { body: { on: !onDuty } });
          setOnDutyUntil(res.onDutyUntil);
        }}
      >
        <span class="knob" />
        <span class="grow">
          <strong>{onDuty ? `Praying ${index.place}` : 'Off duty'}</strong>
          <span class="muted small" style="display:block;font-weight:400">
            {onDuty
              ? `Your hat is live for another ${timeLeft(onDutyUntil - now)}.`
              : 'Scanning your hat shows a "not right now" page. Switch on when you board.'}
          </span>
        </span>
      </button>

      {frozen && (
        <p class="banner small" role="status">
          Pages are closed. People can read what's there but can't write.
        </p>
      )}
      <div class="row wrap">
        {quiet ? (
          <button
            onClick={async () => setQuietUntil((await api<{ quietUntil: number }>('host/quiet', { body: { minutes: 0 } })).quietUntil)}
          >
            {quietUntil >= QUIET_UNTIL_DUTY ? 'Quiet until you go on duty' : `Quiet until ${clock(quietUntil)}`} · Turn off
          </button>
        ) : (
          <button onClick={async () => setQuietUntil((await api<{ quietUntil: number }>('host/quiet', { body: {} })).quietUntil)}>
            Quiet my phone for 1 hour
          </button>
        )}
        {
          <button
            onClick={async () => {
              const res = await api<{ onDutyUntil: number; frozen: boolean }>('host/intake', { body: { open: frozen } });
              setOnDutyUntil(res.onDutyUntil);
              setFrozen(res.frozen);
            }}
          >
            {frozen ? 'Reopen' : 'Close intake'}
          </button>
        }
      </div>

      {!index.pushEnabled && (
        <p class="banner small">
          Notifications are off on this device.{' '}
          <button class="link" onClick={() => setView({ kind: 'settings' })}>
            Turn them on
          </button>
        </p>
      )}

      <h2 class="section-title">Waiting for you ({waiting.length})</h2>
      {waiting.length === 0 ? (
        <p class="muted">{onDuty ? 'No one yet. Pages appear here the moment someone scans your hat.' : 'Nothing waiting.'}</p>
      ) : (
        <ul class="list">
          {waiting.map((s) => (
            <Item key={s.id} s={s} title={titleOf(s)} now={now} onOpen={() => setView({ kind: 'detail', id: s.id })} />
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <>
          <h2 class="section-title">Prayed for ({done.length})</h2>
          <ul class="list">
            {done.map((s) => (
              <Item key={s.id} s={s} title={titleOf(s)} now={now} onOpen={() => setView({ kind: 'detail', id: s.id })} />
            ))}
          </ul>
        </>
      )}

      <h2 class="section-title">If something is wrong</h2>
      <Confirm
        label="Erase everything and close up"
        confirm="Tap again: erase every page, go off duty, silence alerts"
        onConfirm={() => api('host/panic', { body: {} }).then(() => setSessions([]), () => {})}
      />
    </main>
  );
}

function Item(props: { s: SessionSummary; title: string; now: number; onOpen(): void }) {
  const { s, now } = props;
  const left = s.expiresAt - now;
  const status =
    s.state === 'prayed'
      ? s.prayedAt
        ? `Prayed at ${clock(s.prayedAt)}`
        : 'Prayed'
      : s.state === 'requested'
        ? 'New request'
        : `Opened at ${clock(s.createdAt)}`;
  return (
    <li>
      <button class={`item ${s.state === 'requested' || s.unread > 0 ? 'urgent' : ''}`} onClick={props.onOpen}>
        <span class="grow">
          <span class="what">{props.title}</span>
          <span class="when" style="display:block">
            {status} · <span class={left < 15 * 60000 ? 'when soon' : ''}>erases in {timeLeft(left)}</span>
          </span>
        </span>
        {s.hasChat && (
          <span class={`pill ${s.unread ? '' : 'plain'}`} aria-label={s.unread ? `${s.unread} unread chat messages` : 'Has a chat'}>
            💬{s.unread ? ` ${s.unread}` : ''}
          </span>
        )}
        <span class={`pill ${s.state === 'prayed' ? 'good' : s.state === 'opened' ? 'plain' : ''}`}>
          {s.state === 'prayed' ? '🙏 Done' : s.state === 'requested' ? 'New' : 'No request'}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------

function Detail(props: { me: Identity; id: string; title: string; onBack(): void }) {
  const { me, id } = props;
  const [view, setView] = useState<SessionView | null>(null);
  const [keys, setKeys] = useState<SessionKeys | null>(null);
  const [error, setError] = useState('');
  const { request, messages } = useDecrypted(view, keys?.enc ?? null);
  const now = useNow();

  const refresh = async () => {
    try {
      const fresh = await api<SessionView>(`sessions/${id}`);
      setView(fresh);
      return fresh;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) props.onBack();
      else setError('Could not load this page. Check your connection.');
      return null;
    }
  };

  useEffect(() => {
    let socket: Live | undefined;
    let cancelled = false;
    (async () => {
      const fresh = await refresh();
      if (!fresh || cancelled) return;
      try {
        // Only this device holds the private key that opens the rider's page key.
        setKeys(await deriveSessionKeys(await unwrapSessionKey(me.keys, fresh.wrappedKey!)));
      } catch {
        setError('This page was locked for a different key, so it cannot be read on this device.');
      }
      let first = true;
      socket = live<SessionEvent>(`sessions/${id}/ws`, {
        onEvent: (e) => {
          if (e.t === 'gone') return props.onBack();
          setView((v) => (v ? (applyEvent(v, e) ?? v) : v));
          // Seeing a message arrive on screen counts as reading it.
          if (e.t === 'msg' && e.msg.from === 'rider' && document.visibilityState === 'visible') api(`sessions/${id}`).catch(() => {});
        },
        onUp: () => {
          if (!first) refresh();
          first = false;
        },
        onDown: refresh,
      });
      if (cancelled) socket.close();
    })();
    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [id]);

  return (
    <main>
      <div class="topbar">
        <button onClick={props.onBack}>← Back</button>
        {view && <span class="muted small grow" style="text-align:right">erases in {timeLeft(view.expiresAt - now)}</span>}
      </div>
      {error && <p class="error">{error}</p>}
      {!view ? (
        !error && <p class="muted">Opening…</p>
      ) : (
        <>
          <section class="card stack">
            <p class="eyebrow" style="margin:0">
              {view.request ? `Shared at ${clock(view.requestAt ?? view.createdAt)}` : `Opened at ${clock(view.createdAt)}`}
            </p>
            <h2>{props.title}</h2>
            {view.request ? (
              <>
                {request?.text ? <p class="shared">{request.text}</p> : request && <p class="muted">Shared a name only.</p>}
                {!request && <p class="muted">Unlocking…</p>}
              </>
            ) : (
              <p class="muted">They haven't written anything. You can still pray for them.</p>
            )}
          </section>

          {view.state === 'prayed' && view.prayedAt ? (
            <div class="banner good" role="status">
              🙏 Prayed at {clock(view.prayedAt)}. They can see this on their page.
            </div>
          ) : (
            <button
              class="primary hands"
              onClick={async () => {
                await api(`sessions/${id}/prayed`, { method: 'POST' });
                await refresh();
              }}
            >
              <span class="emoji" aria-hidden="true">
                🙏
              </span>
              I've prayed for this
            </button>
          )}

          <section class="card stack">
            <h2>Chat</h2>
            {messages.length === 0 && <p class="muted small">No messages yet. You can write first.</p>}
            {keys && (
              <Chat
                messages={messages}
                me="host"
                placeholder="Write a message"
                onSend={async (text) => {
                  const body = await seal(keys.enc, messageContext(id, 'host'), text);
                  await api(`sessions/${id}/messages`, { body: { body } });
                  await refresh();
                }}
              />
            )}
          </section>

          <Confirm
            label="Block this page"
            confirm="Tap again: erase it and pause new pages for 10 minutes"
            onConfirm={() => api(`sessions/${id}/block`, { method: 'POST', body: {} }).then(props.onBack, props.onBack)}
          />

          <Confirm
            label="Erase this page now"
            confirm="Tap again to erase for both of you"
            onConfirm={() => api(`sessions/${id}`, { method: 'DELETE' }).then(props.onBack, props.onBack)}
          />
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function Settings(props: { me: Identity; index: Index; setIndex(i: Index): void; onBack(): void }) {
  const { me, index } = props;
  const [name, setName] = useState(index.name);
  const [place, setPlace] = useState(index.place);
  const [saved, setSaved] = useState(false);
  const [pushNote, setPushNote] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const link = `${location.origin}/#k=${me.code}`;
  const qr = useMemo(() => renderSVG(link, { ecc: 'M', border: 2 }), [link]);

  const download = (filename: string, text: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const enablePush = async () => {
    setPushNote('');
    if (!index.pushKey) return setPushNote('Notifications are not configured on the server yet (VAPID keys are missing).');
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return setPushNote(
        'This browser cannot receive notifications here. On iPhone, tap Share → Add to Home Screen, then open Prayer Station from the new icon and try again.',
      );
    }
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        return setPushNote('Notifications are blocked for this site. Allow them in your browser settings and try again.');
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(index.pushKey) }));
      await api('host/push', { body: { subscription: sub.toJSON() } });
      props.setIndex({ ...index, pushEnabled: true });
      const { delivered } = await api<{ delivered: number }>('host/push/test', { method: 'POST' });
      setPushNote(delivered ? 'On. A test notification is on its way.' : 'Saved, but the test notification was not accepted. Try again shortly.');
    } catch {
      setPushNote('Could not turn notifications on. Check your connection and try again.');
    }
  };

  return (
    <main>
      <div class="topbar">
        <button onClick={props.onBack}>← Back</button>
        <h1 class="grow" style="font-size:24px;text-align:right">
          Settings
        </h1>
      </div>

      <section class="card stack">
        <h2>Your hat code</h2>
        <div class="qr" dangerouslySetInnerHTML={{ __html: qr }} />
        <p class="muted small center" style="overflow-wrap:anywhere">
          {link}
        </p>
        <button class="block" onClick={() => download('prayer-station-qr.svg', qr, 'image/svg+xml')}>
          Download for printing
        </button>
        <p class="muted small">
          Print it large with a white margin all round. The code never changes unless you create a new station, so it is safe to sew on.
        </p>
      </section>

      <section class="card stack">
        <h2>Notifications</h2>
        <p class="small">
          {index.pushEnabled ? 'On for at least one device.' : 'Off.'} Alerts say only that something is waiting, never what was written.
        </p>
        <button class="block" onClick={enablePush}>
          {index.pushEnabled ? 'Turn on for this device / send a test' : 'Turn on notifications'}
        </button>
        {pushNote && <p class="small" role="status">{pushNote}</p>}
      </section>

      <section class="card stack">
        <h2>How riders see you</h2>
        <div>
          <label for="name">Your first name</label>
          <input id="name" type="text" maxLength={40} value={name} onInput={(e) => (setName(e.currentTarget.value), setSaved(false))} />
        </div>
        <div>
          <label for="place">Where you'll be praying</label>
          <input id="place" type="text" maxLength={60} value={place} onInput={(e) => (setPlace(e.currentTarget.value), setSaved(false))} />
        </div>
        <button
          class="block"
          disabled={!name.trim()}
          onClick={async () => {
            await api('host/profile', { body: { name, place } });
            props.setIndex({ ...index, name: name.trim(), place: place.trim() || 'on the bus' });
            setSaved(true);
          }}
        >
          {saved ? 'Saved' : 'Save'}
        </button>
      </section>

      <section class="card stack">
        <h2>Back up your keys</h2>
        <p class="small">
          Your keys exist only on this device. If you lose it without a backup, open requests can never be read and you will need a new
          hat code. Choose a passphrase you will remember; the file is useless without it.
        </p>
        <div>
          <label for="pass">Passphrase</label>
          <input id="pass" type="password" autocomplete="new-password" value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} />
        </div>
        <button
          class="block"
          disabled={passphrase.length < 8}
          onClick={async () => {
            download('prayer-station-backup.json', await exportBackup(me.keys, passphrase), 'application/json');
            setPassphrase('');
          }}
        >
          {passphrase.length > 0 && passphrase.length < 8 ? 'Use at least 8 characters' : 'Download backup'}
        </button>
      </section>

      <section class="card stack">
        <h2>This device</h2>
        <Confirm
          class="block"
          label="Remove my keys from this device"
          confirm="Tap again: without a backup this cannot be undone"
          onConfirm={async () => {
            await api('logout', { method: 'POST' }).catch(() => {});
            await clearKeys();
            location.reload();
          }}
        />
      </section>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
