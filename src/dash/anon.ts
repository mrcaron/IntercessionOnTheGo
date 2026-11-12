// Numbers for riders who gave no name: "Anonymous 1", "Anonymous 2", ...
//
// Names live inside the encrypted request, so the server cannot tell who is anonymous. The numbering
// therefore lives on the intercessor's own device. A number belongs to a page for good, and the counter
// only ever goes up, so "Anonymous 2" never turns into someone else when an earlier page erases.

export interface AnonStore {
  get(): string | null;
  set(value: string): void;
}

interface State {
  next: number;
  ids: Record<string, { n: number; at: number }>;
}

const FORGET_AFTER_MS = 60 * 24 * 60 * 60 * 1000; // pages are long gone by then

export class AnonRegistry {
  private state: State = { next: 1, ids: {} };

  constructor(private store: AnonStore) {
    try {
      const raw = store.get();
      const parsed = raw ? (JSON.parse(raw) as State) : null;
      if (parsed && Number.isInteger(parsed.next) && parsed.next >= 1 && parsed.ids && typeof parsed.ids === 'object') {
        this.state = { next: parsed.next, ids: {} };
        for (const [id, v] of Object.entries(parsed.ids)) {
          if (v && Number.isInteger(v.n) && v.n >= 1 && Number.isFinite(v.at)) this.state.ids[id] = { n: v.n, at: v.at };
        }
        // Never hand out a number that is already in use, whatever the stored counter says.
        for (const { n } of Object.values(this.state.ids)) this.state.next = Math.max(this.state.next, n + 1);
      }
    } catch {
      /* unreadable: start again from 1 */
    }
  }

  numberFor(id: string): number | undefined {
    return this.state.ids[id]?.n;
  }

  /** Gives numbers to pages that have none, oldest first. Returns true if anything changed. */
  assign(pages: { id: string; createdAt: number }[], now = Date.now()): boolean {
    let changed = false;
    for (const page of [...pages].sort((a, b) => a.createdAt - b.createdAt)) {
      if (this.state.ids[page.id]) continue;
      this.state.ids[page.id] = { n: this.state.next++, at: now };
      changed = true;
    }
    for (const [id, v] of Object.entries(this.state.ids)) {
      if (now - v.at > FORGET_AFTER_MS) {
        delete this.state.ids[id];
        changed = true;
      }
    }
    if (changed) this.store.set(JSON.stringify(this.state));
    return changed;
  }
}
