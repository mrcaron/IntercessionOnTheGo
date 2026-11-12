// Shapes that cross the wire between browser and Worker.

export type SessionState = 'opened' | 'requested' | 'prayed';
export type Role = 'rider' | 'host';

export const HOUR = 60 * 60 * 1000;
export const SESSION_LIFETIME = HOUR;
export const PAUSE_EXTENSION = 24 * HOUR;
export const DUTY_LENGTH = 2 * HOUR;

// Station-wide intake budget: how many pages one intercessor will take on, however many
// addresses the requests come from. Env vars of the same names override these (tests).
export const MAX_LIVE_PAGES = 20;
export const MAX_NEW_PAGES_PER_MINUTE = 3;
export const MAX_PAGES_PER_SHIFT = 40;
export const RESERVATION_TTL = 30_000; // a reserved slot not claimed by a created page frees itself

// Per-page caps on what a rider can write, so one page can't keep pushing the intercessor for days.
// Hosts are not limited by these.
export const MAX_PAGE_LIFETIME = 72 * HOUR; // pauses can never push a page past this, counted from creation
export const MAX_PAUSES = 3;
export const MAX_REQUEST_EDITS = 2; // on top of the first write
export const MAX_RIDER_MESSAGES = 30;
export const MAX_RIDER_STREAK = 5; // rider messages in a row without a host reply
export const RIDER_MESSAGE_GAP = 3_000; // ms between rider messages

export const MAX_SEALED_REQUEST = 8_000; // characters of base64url
export const MAX_SEALED_MESSAGE = 4_000;
export const MAX_MESSAGES = 300;

/** At most one push per station in this window; events in between are merged into one. */
export const PUSH_WINDOW_MS = 60_000;

/** What the server knows about a prayer page: timing and status, never content. */
export interface SessionSummary {
  id: string;
  createdAt: number;
  expiresAt: number;
  state: SessionState;
  prayedAt: number | null;
  hasRequest: boolean;
  hasChat: boolean;
  unread: number;
}

export interface Message {
  seq: number;
  from: Role;
  ts: number;
  body: string; // sealed
}

/** Why a rider write was refused. Limit codes become HTTP 429; `already-prayed` is a 409 state conflict. */
export type WriteRefusal = 'limit-request' | 'limit-pause' | 'limit-chat' | 'wait-for-reply' | 'too-fast' | 'already-prayed';

/** What a rider has left on one page. Counts only, never content. */
export interface RiderLimits {
  pausesLeft: number;
  requestEditsLeft: number;
  messagesLeft: number;
  /** Rider messages allowed before the host must reply. */
  streakLeft: number;
}

export interface SessionView {
  id: string;
  station: string;
  createdAt: number;
  expiresAt: number;
  state: SessionState;
  prayedAt: number | null;
  request: string | null; // sealed JSON {name, text}
  requestAt: number | null;
  messages: Message[];
  /** Present for the intercessor only. */
  wrappedKey?: string;
  /** Present for the rider only. */
  limits?: RiderLimits;
  /** Present for the rider only. */
  host?: { name: string; place: string };
}

export interface RequestContent {
  name: string;
  text: string;
}

export interface StationPublic {
  name: string;
  place: string;
  onDuty: boolean;
}

export interface HostIndex {
  name: string;
  place: string;
  onDutyUntil: number;
  pushEnabled: boolean;
  sessions: SessionSummary[];
}

export type SessionEvent =
  | { t: 'state'; state: SessionState; prayedAt: number | null; expiresAt: number }
  | { t: 'request'; request: string; requestAt: number; state: SessionState }
  | { t: 'msg'; msg: Message }
  | { t: 'gone' };

export type StationEvent =
  | { t: 'upsert'; session: SessionSummary }
  | { t: 'remove'; id: string }
  | { t: 'duty'; onDutyUntil: number };

export type NotifyKind = 'opened' | 'requested' | 'message' | 'update';
