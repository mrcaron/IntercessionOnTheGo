import type { SessionDO } from './session-do';
import type { StationDO } from './station-do';

export interface Env {
  STATION: DurableObjectNamespace<StationDO>;
  SESSION: DurableObjectNamespace<SessionDO>;
  ASSETS: Fetcher;
  /** Secret that authorises creating a station. Remove it once setup is done. */
  SETUP_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Optional contact (https: or mailto:) sent to push services. Defaults to the site address. */
  VAPID_SUBJECT?: string;
  /** Optional override of the push merge window in ms (tests). Defaults to PUSH_WINDOW_MS. */
  PUSH_WINDOW_MS?: string;
  /** Optional overrides (numbers as text) for the station intake limits in shared/types.ts. */
  MAX_LIVE_PAGES?: string;
  MAX_NEW_PAGES_PER_MINUTE?: string;
  MAX_PAGES_PER_SHIFT?: string;
  CREATE_LIMIT?: RateLimit;
  WRITE_LIMIT?: RateLimit;
}
