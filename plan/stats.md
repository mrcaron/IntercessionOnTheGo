# Stats plan

**Status:** proposed, nothing built. Branch: `stats`. Written 2026-11-11.

## Goal

A Stats screen on the dashboard (next to Settings) with totals since the station began and recent trends. Counts only, never content.

Decisions already made:

- **Audience:** the intercessor, on the dashboard. Not shown to people who scan the hat.
- **"Prayers answered":** counts pages where the intercessor tapped "I've prayed for this", labelled "People prayed for". The app cannot know whether a prayer was answered.

## What it shows

- **People prayed for** (the headline number), with "counting since <date>".
- Pages opened (scans), requests shared, chats started, and chat messages (from riders / from you).
- Pages that erased before you prayed.
- Average time from request to prayer.
- Shifts and hours spent on duty.
- The last 14 days (bar chart of people prayed for) and this week vs last week.
- Busiest hours of the day (24 bars of pages opened).
- An empty state before the first page.

## Privacy design (the important part)

- The server already sees page status (opened, requested, prayed, chat started) but never content. Every metric here comes from that status, so the end-to-end encryption is unaffected.
- Only anonymous counters are kept: totals, per-day counts and a 24-bucket hour histogram. No page ids, no per-page timestamps, no text, no names.
- Not exposed to riders: the endpoint requires the intercessor's login.
- **The rider page says "zero record"**, which stops being strictly true once tallies exist. Change the footer to say the page and everything written on it erase, and that the only thing kept is an anonymous tally with nothing about them. Update the README privacy section too.
- Settings gets a **Stats on/off** switch and a **Reset stats** button (confirm twice). Off stops counting and deletes the tallies. Default on (open decision below).

## How it works

- **Counting happens in the station object** (`src/worker/station-do.ts`), which is single-threaded, so counters stay consistent.
- Today `SessionDO` tells the station only `opened | requested | message | update` (`notify()` in `src/worker/session-do.ts`), which cannot tell a prayer from a pause. Add an explicit stat event: `opened`, `requested`, `prayed`, `chat_started`, `msg_rider`, `msg_host`, `paused`, `ended_unprayed`.
- Per-page flags in the session's stored meta stop double counting: a page counts once for "requested", once for "prayed" and once for "chat started", even if the rider edits or the host taps again.
- `markPrayed()` (session-do.ts) computes request-to-prayer time the first time and sends it with the event. A page prayed for with no request counts as prayed, with no time.
- `destroy()` (session-do.ts) reports whether the page was prayed for; if not, count `ended_unprayed`.
- **Duty time:** `setDuty()` (station-do.ts) stores `dutyStartedAt`. On switch-off, or the next switch-on after an automatic expiry, add `min(now, until) - startedAt` to the hours.
- Counting is best effort: a failure must never make a rider's request or the prayer button fail (wrap in try/catch).
- **Storage:** one key per local day (`stat:YYYY-MM-DD`, a small JSON of counters), one all-time `stat:total`, and `stat:hours` (24 numbers). Days older than about 400 are deleted; the total is kept. The profile gets `createdAt` and `tz` (IANA zone from the browser at setup, editable in Settings) so "day" and "hour" mean the intercessor's local time.
- **API:** `GET /api/host/stats` returns `{ since, totals, days, hours, shifts }`. `POST /api/host/stats/reset` and `POST /api/host/stats/enabled`. All sit behind the host cookie (`requireHost` in `src/worker/index.ts`).
- **Types** go in `src/shared/types.ts`. The client is a new `Stats` view in `src/dash/main.tsx` alongside `Settings` and `Detail`. The chart is inline SVG in the existing style (`src/shared/style.css`): coral bars on black, with a text table fallback for screen readers. No chart library.

## Files

`src/worker/station-do.ts`, `src/worker/session-do.ts`, `src/worker/index.ts`, `src/shared/types.ts`, `src/dash/main.tsx`, new `src/dash/stats.tsx`, `src/shared/style.css`, `src/rider/main.tsx` (footer copy), `README.md`, `test/api.test.ts`, `test/e2e.mjs`.

## Alternatives rejected

- **Stats computed in the browser from remembered history:** loses everything with the device, and only sees pages opened while the dashboard was open.
- **A separate analytics database:** an extra place holding data about riders, for no benefit.

## Tests

- A full journey increments each counter once; repeats do not double count.
- A page that expires or is erased unprayed counts as `ended_unprayed`; a prayed page does not.
- Response time is computed correctly with controlled time.
- Day and hour buckets follow the station's time zone, including a day boundary.
- Station storage holds only numeric `stat:` keys, with no session ids and no text (inspect storage like the existing privacy test).
- Off stops counting and deletes tallies; reset clears them; the stats endpoint returns 401 without login.
- Browser run: after the existing journey, the Stats screen shows the expected numbers and the rider footer shows the new copy.

## Open decisions

- Stats default on (recommended) or off?
- Weekly comparison and hour-of-day chart in the first version, or totals and the 14-day chart only?
- Time zone: take it from the browser automatically (recommended) or ask?
- Optional later: a "how did it go?" button for riders so "answered" could be real. That is a separate feature.

## Interaction with other plans

Independent of `plan/security-hardening.md`. The passkey lock would also protect this screen. Key rotation does not touch it.

When this branch and the security plan branch are both merged, add an index line for this file to `plan/README.md`.
