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
  CREATE_LIMIT?: RateLimit;
  WRITE_LIMIT?: RateLimit;
}
