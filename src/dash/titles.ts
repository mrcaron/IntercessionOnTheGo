// What to call each person in the dashboard list: their name if they gave one, otherwise "Anonymous N".

import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../shared/client';
import { deriveSessionKeys, open, requestContext, unwrapSessionKey, type StationKeys } from '../shared/crypto';
import type { SessionSummary, SessionView } from '../shared/types';
import { AnonRegistry, type AnonStore } from './anon';

const STORAGE_KEY = 'mps-anon-v1';

function browserStore(): AnonStore {
  let memory: string | null = null;
  return {
    get() {
      try {
        return localStorage.getItem(STORAGE_KEY) ?? memory;
      } catch {
        return memory;
      }
    },
    set(value) {
      memory = value;
      try {
        localStorage.setItem(STORAGE_KEY, value);
      } catch {
        /* storage unavailable: numbers last until the page is closed */
      }
    },
  };
}

export const OPENED_TITLE = 'Someone opened your page';
const LOADING_TITLE = 'Prayer request';

/** Decrypts one request on this device and returns the name in it ('' if none was given). */
async function readName(keys: StationKeys, id: string): Promise<string> {
  // `peek` reads the page without marking its chat messages as read.
  const view = await api<SessionView>(`sessions/${id}?peek=1`);
  if (!view.request || !view.wrappedKey) return '';
  const pageKey = await unwrapSessionKey(keys, view.wrappedKey);
  const { enc } = await deriveSessionKeys(pageKey);
  const parsed = JSON.parse(await open(enc, requestContext(id), view.request)) as { name?: unknown };
  return String(parsed.name ?? '').trim();
}

export function useTitles(keys: StationKeys, sessions: SessionSummary[]) {
  const registry = useRef<AnonRegistry | undefined>(undefined);
  registry.current ??= new AnonRegistry(browserStore());
  const [names, setNames] = useState<Record<string, string>>({});
  const [, redraw] = useState(0);
  const inflight = useRef(new Set<string>());

  // Learn the name from each request as it arrives.
  useEffect(() => {
    for (const s of sessions) {
      if (!s.hasRequest || names[s.id] !== undefined || inflight.current.has(s.id)) continue;
      inflight.current.add(s.id);
      readName(keys, s.id)
        .then(
          (name) => setNames((n) => ({ ...n, [s.id]: name })),
          () => {
            /* try again the next time the list changes */
          },
        )
        .finally(() => inflight.current.delete(s.id));
    }
  }, [sessions, names]);

  // Number the people who gave no name: a request with a blank name, or a chat with no request.
  useEffect(() => {
    const anonymous = sessions.filter((s) => (s.hasRequest ? names[s.id] === '' : s.hasChat));
    if (registry.current!.assign(anonymous)) redraw((n) => n + 1);
  }, [sessions, names]);

  return function title(s: SessionSummary | undefined): string {
    if (!s) return LOADING_TITLE;
    const name = names[s.id];
    if (name) return name;
    if (s.hasRequest && name === undefined) return LOADING_TITLE;
    const n = registry.current!.numberFor(s.id);
    return n !== undefined ? `Anonymous ${n}` : OPENED_TITLE;
  };
}
