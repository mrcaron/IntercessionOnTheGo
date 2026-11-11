# Native iOS app for the intercessor

**Status:** proposed, nothing built. Branch: `iOS`. Written 2026-11-11.

## Goal

A native iOS app (SwiftUI) that replaces the web dashboard as the intercessor's front end. The service stays on Cloudflare, unchanged for riders: they still scan the hat and use the web page. The app talks to the same Worker API, holds the same end-to-end keys, and gets notifications through Apple's push service.

Why: reliable push on iPhone without "Add to Home Screen", keys held in the Keychain behind Face ID, a proper lock screen and background behaviour, and a Stats screen with native charts later.

## What does not change

- The rider page, the hat QR code, and the server's end-to-end encryption design. The server still sees only ciphertext plus status and timing.
- The web dashboard keeps working. Both can sign in with the same keys, so it stays as a fallback.
- No Universal Links on the site's domain. They would open the app for anyone who scans the hat and has it installed, and the app is only for the intercessor.

## Prerequisites (owner)

- A Mac with Xcode (15 or later) and an Apple Developer Program membership (paid, yearly).
- A bundle identifier, and an APNs authentication key (`.p8`) with its Key ID and Team ID from the Apple Developer account.
- A deployed Cloudflare Worker with a stable HTTPS address (the Cloudflare deployment is not done yet).
- **This sandbox cannot build or run iOS apps.** Swift code can be written here, but compiling, simulator runs and device tests need the owner's Mac. GitHub Actions macOS runners can run the build and unit tests in CI.

## Architecture

- **Minimum iOS 17.** SwiftUI, Observation, Swift Charts (for Stats), URLSession, CryptoKit, LocalAuthentication, Keychain. No third-party dependencies.
- **Layout:** new top-level `ios/` directory.
  - `ios/PrayerCore/`: a Swift package with the crypto, API client, models and live-update client. No UI, so it is unit-testable.
  - `ios/PrayerStation/`: the app target (screens, notifications, settings).
- **Server address** is a build setting with an override in Setup, so the app works against a tunnel, workers.dev or the final domain.

### Crypto parity (the hard requirement)

The app must produce and read exactly what `src/shared/crypto.ts` does, or the web page and the app cannot interoperate. CryptoKit covers every primitive:

| Web (`crypto.ts`) | iOS |
|---|---|
| ECDH P-256 station key, 33-byte compressed public key in the QR | `P256.KeyAgreement`, `compressedRepresentation` |
| ECDSA P-256 login key, signatures in raw `r‖s` form | `P256.Signing`, `rawRepresentation` (same 64-byte layout) |
| Wrapped page key: ephemeral public (65) ‖ iv (12) ‖ AES-GCM (48); HKDF salt = ephemeral ‖ station public, info `mps/wrap` | `HKDF<SHA256>`, `AES.GCM` |
| Page keys: HKDF(K, empty salt, `mps/enc` / `mps/auth`) | `HKDF<SHA256>` |
| Messages: iv (12) ‖ ciphertext ‖ tag, AAD = `<page id>/request` or `<page id>/msg/<role>` | `AES.GCM` with `authenticating:` |
| Login: sign `mps-login:<station id>:<nonce>` | `P256.Signing` |
| Station id = base64url(SHA-256(compressed key))[0..16] | `SHA256` |
| Backup: PBKDF2-SHA256 310,000 iterations, AES-GCM, JWK keys | PBKDF2 via CommonCrypto, JWK converted to raw scalar and point |

**Cross-platform test vectors:** add a script that runs the existing TypeScript functions and writes fixtures to `test/vectors/` (wrapped keys, sealed messages, signatures, a backup file, codes and ids). The Swift unit tests must open every fixture, and a second set made by Swift must open in the TypeScript tests. This is how compatibility gets proved without guessing.

### Keys on the phone

- **Import the web backup** (the passphrase-protected file from Settings) so the same station, and the same printed hat code, carry over. Creating a new station in the app is also supported but gives a new hat code.
- Keys live in the Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and a biometric access control, so they are not in iCloud or device backups and need Face ID or Touch ID to use. This replaces the planned web passkey lock.
- Secure Enclave keys cannot be exported, so they would prevent backups. Use ordinary Keychain keys, with the passphrase backup as recovery. (Decision below.)
- Plaintext lives in memory only. The app blurs its content in the app switcher and locks after a short time in the background.

### Server changes (Worker, testable in this sandbox)

1. **Native sign-in token.** Login currently sets an HttpOnly cookie. Add an `Authorization: Host <station>.<token>` scheme and return the token in the login response for native clients. Do **not** reuse `Bearer`: `sessionAuth` in `src/worker/index.ts` already treats `Bearer` tokens as rider tokens, and the host token has the same length, so they would collide.
2. **Device registration.** `POST /api/host/devices` and `DELETE` with `{ token, environment: sandbox | production }`, stored in the station object (`src/worker/station-do.ts`) next to the web push subscriptions.
3. **APNs sender**, new `src/worker/apns.ts`: sign a short-lived ES256 JWT with WebCrypto (the same approach as `webpush.ts`) and POST to `api.push.apple.com` / `api.sandbox.push.apple.com` over HTTP/2. New secrets: `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (the bundle id). Verify early that Workers' `fetch` negotiates HTTP/2 to Apple; if not, relay through a small service.
4. **Push content stays generic** ("A new prayer request is waiting."), exactly like web push, with the same send rules. The notification cap from the security plan applies to both channels. Remove tokens APNs reports as dead (410).
5. The existing WebSocket endpoints work with `URLSessionWebSocketTask`. Native clients send no `Origin` header, which `sameOrigin()` already allows.

### App screens

Match the web dashboard, restyled natively in the 24-7 Prayer look (black `#252525`, coral `#ec5d56`, white text):

- **Setup / restore:** server address, name, place, setup code, or import the backup file (Files picker).
- **Dashboard:** duty switch, "waiting for you" and "prayed for" lists, countdowns, chat bubbles with unread counts, live over WebSocket while open.
- **Detail:** decrypted request, the 🙏 "I've prayed" button, chat, erase.
- **Settings:** hat QR code drawn with Core Image (error correction M) with share and print (PDF), notifications, profile, backup export, remove keys.
- **Stats** (from `plan/stats.md`): native Swift Charts, added after the stats feature ships on the server.

### Background and notifications

iOS suspends WebSockets in the background, so alerts rely on APNs. Use a standard alert push for new requests and messages; tapping it opens that page. Optionally a silent push to refresh the list. Later, a Live Activity or widget for "on duty, N waiting".

## Alternatives considered

- **Capacitor wrapper around the existing web dashboard:** fastest, reuses all the code, and gets push through a plugin. Rejected because the owner asked for a native app, and keys would still live in web storage.
- **React Native:** a second JavaScript stack and a bridge for crypto, for no gain over SwiftUI here.

## Phases

0. Prerequisites above; decide the open items below.
1. **Server** (sandbox-testable): host token scheme, device registration, APNs sender, tests in `test/api.test.ts` with APNs mocked.
2. **Crypto vectors and Swift core package** with unit tests.
3. **App skeleton:** setup/restore, login, dashboard list, detail with decrypt, pray, chat, erase.
4. **Push and background:** APNs registration, notification handling, deep link to a page.
5. **Hardening:** Face ID lock, app-switcher blur, auto-lock; settings, QR print.
6. **TestFlight** to the owner's own devices, then App Store submission if wanted.

## Testing

- **Server:** Vitest for the new endpoints (token auth, device add/remove, dead-token removal, APNs payload and JWT with a mock), `npm run typecheck`, and `npm run e2e` still passing.
- **Core package:** Swift unit tests against `test/vectors/`, in both directions.
- **App:** simulator UI tests for the main flows; `xcrun simctl push` to test notification handling without the server.
- **Device:** on a real iPhone with a TestFlight build against the real deployment: sign in with the imported backup, switch on duty, open the hat link on a second phone, send a request, and receive the push with the app closed; pray; chat.
- **Interop:** the same station signed in on the web dashboard and the app at once.

## App Store notes

- Privacy label: no data collected by the app; the service stores only ciphertext and anonymous counters. A privacy policy URL is required.
- Export compliance: the app uses standard encryption. Confirm the answers on submission rather than assuming.
- No accounts, so Sign in with Apple does not apply. Review is likely to ask what the app is for: describe it as a prayer-request inbox for the person wearing the hat.

## Decisions

Recommended, to confirm:

- **Distribution:** start with TestFlight for the owner and a few testers; decide on a public App Store release later.
- **Web dashboard:** keep it alongside the app as a fallback.
- **Keys:** ordinary Keychain keys with biometrics plus the passphrase backup, not the Secure Enclave, so recovery is possible.
- **Order of work:** settle the key-rotation question in `plan/security-hardening.md` first. If rotation is coming, build it once in the server and web client, then mirror it in Swift, rather than doing the crypto layer twice.

## Interaction with other plans

- `plan/security-hardening.md`: the native biometric Keychain lock replaces the web passkey lock; the notification cap applies to APNs too; key rotation must be mirrored in Swift.
- `plan/stats.md`: the server side is shared; the Stats screen is added natively afterwards.

When these plan branches are merged, add index lines for this file to `plan/README.md`.
