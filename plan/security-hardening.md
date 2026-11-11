# Security hardening plan

**Status:** proposed. Nothing here is built yet. Written 2026-11-11.

## 1. Where the encryption stands today

- The server stores and relays only ciphertext, plus timing, status and message sizes.
- **Page key:** a random 256-bit key made on the rider's phone, locked to the station's public key (one-time ECDH P-256, HKDF, AES-GCM). Requests and chat use AES-256-GCM with that key. The station's public key travels in the QR code's `#k=` fragment, which browsers never send to the server.
- It is a custom design built from standard browser primitives. It is **not** the Signal Protocol and has **not** had an independent review.
- **Gaps compared with Signal:**
  - No forward secrecy for the long-lived station key. Someone who steals it can read every page they recorded earlier.
  - The page key never changes during a page's life.
  - Message order and deletion are not authenticated (the server numbers messages).
  - The browser must trust the code the site serves.
- **Why not Signal:** setup is anonymous, there is one intercessor, and pages last about an hour. Signal's protocol is built for long-lived conversations between known accounts and would add a lot of complexity for little gain here.

## 2. Threat assessment

- **Likely, low harm:** trolls and bots scanning the hat, or a QR code shown in a public video or photo; alert flooding. Existing limits: the duty switch, the erase button, one-hour expiry, and a per-visitor limit of 10 new pages a minute.
- **Possible, higher harm:** a lost or stolen unlocked phone (the keys sit in browser storage with no extra lock); takeover of the Cloudflare account (could swap the site's code).
- **Unlikely:** breaking the encryption directly; legal demands (the server holds only ciphertext, deleted within the hour).

## 3. Proposed work, in priority order

### A. Notification cap

Limit pushes per station across all visitors (for example a few per minute, collapsing the rest into one "several people are waiting" alert).

- Files: `src/worker/station-do.ts` (`sessionEvent`, `push`).
- Test in `test/api.test.ts`.

### B. Duty switch stays off by default

Already true: `onDutyUntil` starts at 0 and turns itself off after 2 hours. Keep it, and add a test that a fresh station refuses new pages.

### C. Passkey lock for the dashboard

- Gate the dashboard with a passkey (Face ID or fingerprint) and encrypt the stored keys with a secret from the WebAuthn PRF extension, so a copy of the browser data is unreadable. A lock on the screen alone is not enough.
- **Fallback:** a long passphrase (a short PIN can be guessed offline). The backup passphrase code in `src/shared/crypto.ts` (`exportBackup`, `importBackup`) can be reused.
- Auto-lock after about two minutes in the background. Notifications still arrive without unlocking.
- **Before building:** verify PRF support on the owner's actual iPhone and Android, including the installed home-screen app.
- Files: `src/dash/keystore.ts`, `src/dash/main.tsx`, new `src/dash/lock.ts`.

### D. Rotate the station decryption key

- The QR carries a never-rotating **signing** key. The phone signs each new decryption key, and the rider's browser verifies the signature before using it. The printed hat code stays valid and the server still cannot substitute a key.
- Each page stays locked to the key that was current when it opened. The phone deletes an old key once every page using it has erased.
- Add a maximum page age (proposed 7 days) so repeated pausing cannot keep old keys alive forever.
- Backups go stale after each rotation, so prompt the owner to re-export.
- Cheaper to do before hats are printed, since no printed code depends on the current design.
- Files: `src/shared/crypto.ts`, `src/worker/station-do.ts`, `src/worker/index.ts`, `src/rider/main.tsx`, `src/dash/*`, and tests.

### E. Independent review

Have a cryptography reviewer check the design before people share real hardships with it.

## 4. Actions for the owner (not code)

- Delete the setup code (`npx wrangler secret delete SETUP_TOKEN`) once the station exists.
- Turn on two-factor login for the Cloudflare account.

## 5. Open decisions

- Go-ahead for A, B and C (asked, not yet answered).
- Go-ahead for D, how often to rotate (daily or per shift), and whether a 7-day page cap is acceptable.
- Deployment to Cloudflare is deferred until the owner says they are ready.

## 6. How each item would be verified

- `npm test`, `npm run e2e` and `npm run typecheck` must all pass.
- C: manual test on real phones through a tunnel run (`wrangler dev --tunnel` on the owner's computer).
- D: tests that an old key still opens its pages, a deleted key does not, and a hat code from before a rotation still works.
