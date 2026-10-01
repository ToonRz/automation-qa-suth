# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Playwright-based E2E automation for booking badminton courts on `https://susport.sc.su.ac.th/login.php`. In production it runs as a **Telegram bot** (`npm run bot`, kept alive by launchd) that books every account of every opted-in user (owner + friends — 17 accounts as of 2026-10) **in one parallel batch, dispatched exactly at 12:00:00 local time** (no tolerance).

## Project rule — scope discipline (user instruction)

> **สำคัญคือ base on requirement ถ้านอกเหนือให้ถามก่อน**
> All changes must be grounded in `requirements.md`. If a task goes outside the spec — new tooling, new dependencies, new behavior, new acceptance criteria — **stop and ask the user first** before implementing.

## Source of truth

- **`requirements.md`** — full functional spec. Treat it as the contract; this file only summarizes it.
  - §6.2 is the bot's daily timeline; §10 (user-approved operational divergences, 10.1–10.11) **wins** wherever it conflicts with §3–§8. §10.11 records the 2026-08 engine design (prewarm states, fetch submit, same-slot rotation, heads-up instead of abort).
- **`config/users.json`** (gitignored; template `config/users.example.json`) — the bot's users: role (`owner`/`friend`), cron on/off, `pending_booking`, and each user's accounts (credentials + slot). Edits are picked up live via mtime reload, but must be saved before the 11:55 cron.
- **`config/accounts.json`** (gitignored) — top-level `COURT_PRIORITY` (court order for every account; currently 6 courts) + the CLI runner's account list.
- **`config/court-ids.json`** — cache of court label → dropdown id, refreshed by every dropdown read; used to submit courts missing from the stale pre-noon dropdown.
- **`.env`** — `TELEGRAM_BOT_TOKEN`, `TZ=Asia/Bangkok`, `SCREENSHOTS_DIR`, `REPORTS_DIR`, and the kill-switches below.

Never hardcode credentials, slots, or the court order in source. Do not invent slot values.

## Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript (Node.js, run via `ts-node`) |
| Automation | Playwright, `channel: 'chrome'`, headless |
| Parallelism | One browser, one fresh `BrowserContext` per account, one `Promise.all` dispatch for all users |
| Scheduler | `node-cron` `55 11 * * *` (prewarm window) + `waitUntilLocalTimestamp` for the exact 12:00:00.000 tick |
| Interface | Telegram bot (raw Bot API long-poll + `src/server/telegramSend.ts`) |
| Report | `reports/bot-run-<ISO>.json` (§7 fields + extras), `screenshots/<YYYY-MM-DD>/<username>.png`, per-user DMs + owner summary; 30-day retention |

## Develop / Run

```bash
npm install
npx playwright install chromium

npm run bot          # production: Telegram bot + 11:55 cron (normally via launchd, see README §10)
npm run rehearse     # dry-run the bot engine end-to-end without booking
npm start            # CLI path: src/scheduler.ts waits for 12:00, books config/accounts.json
npm run account -- <username>   # one account now (debugging)
npm run discover     # list courts/slots on the live site

# Tests are ts-node scripts against a local mock server — never the real site or Telegram
npm run test:log-audit   # full log-audit suite (§10.5–10.10)
npm run test:wipe        # wipe-guard scenarios only
npm run test:fast-confirm
npm run bot:test-wizards
```

There is no `playwright.config.ts` and no Playwright Test runner.

## Project layout

```
config/            users.json, accounts.json (COURT_PRIORITY), court-ids.json, run-state.json
src/
├── server/
│   ├── bot.ts             ← Telegram commands, 11:55 cron, runScheduledBooking, missed-noon watchdog
│   ├── bookingEngine.ts   ← runPrewarmedBatch (prewarm → tick → dispatch) / runStandard
│   ├── runReport.ts       ← §7 JSON report + retention
│   ├── runState.ts        ← cron-fired / dispatched dates for the watchdog
│   ├── userStore.ts       ← users.json access
│   └── test*.ts, rehearse.ts
├── bookingFlow.ts     ← bookOneAccount: per-account login → court → submit → verify (+ holdForWipe)
├── wipeGuard.ts       ← post-noon reservations.php watcher (§10.10)
├── courtIdCache.ts
├── scheduler.ts, runner.ts   ← CLI path
reports/, screenshots/<date>/, bot.log
doc/               handoffs and fix plans
```

## Daily run (bot)

1. **11:55 cron** — pick users: owner + friends with cron on, plus cron-off friends who sent `/book`; prewarm DM to cron-on users.
2. **Prewarm** — arm the T-4m total-outage DM, launch Chrome, then every account logs in on a fresh context in parallel → `page-ready` (court+slot pre-selected) / `login-ready` (stale dropdown; use cached court id at noon) / `needs-standard` (already booked) / `failed` (retried every 30s until T-40s; all failed → fresh browser).
3. **T-40s → T** — resolve each account's target court, build the wipe guard. Nothing but the dispatch runs after 12:00:00.000.
4. **12:00:00.000** — dispatch every account in the same tick. Woke >30s late → no dispatch, FAIL `missed-deadline`.
5. **Wipe hold (FIRE+1s → +10s)** — poll `reservations.php`; a wiped account re-books. Final PASS only if its row is in the list.
6. **Report** — DM each user as soon as their accounts settle (90s budget → `ERROR`), write the JSON report, owner summary; browser teardown is detached.

Watchdog: from 12:05, if a cron-on user exists and nothing was dispatched today → one DM to the owner (no late booking).

## Hard rules from requirements

These are non-negotiable. They are the basis for every fix, refactor, and review.

1. **Strict 12:00:00 trigger, no tolerance** (SC-04). The dispatch fires on the exact local-noon millisecond; no new work may sit between the tick and the submits. Prewarm before noon is allowed; booking after a missed noon is not.
2. **Never reuse a context** (BR-01/02/04). Each account = `browser.newContext({ storageState: undefined })`. `context.close()` on every exit path — success, failure, cut prewarm round — detached and timed so it never blocks results.
3. **Court selection is slot-first** (§3.4, §10.4): each account books **only its own slot**, trying `COURT_PRIORITY` in order, then remaining badminton courts as a safety net. Accounts sharing a slot get the list **rotated** by their position in the group (de-confliction). No per-court slot fallback. Slot full everywhere → `FAIL` `slot {slot} ไม่ว่างในทุกสนาม`. Retry budget 30s per account.
4. **Parallel release** (SC-05). All accounts of all users dispatch in the same tick via one `Promise.all`. One slow account must not delay the others or another user's DM.
5. **PASS means the row is in `reservations.php`** (§10.10). The first-wave answer is provisional; `court_booked` comes from the list, not from the submitted id.
6. **Screenshot every account** (§7), PASS and FAIL, taken after the hold.
7. **Per-account report fields** (§7): `username`, `triggered_at`, `court_attempted`, `court_booked`, `slot`, `status`, `fail_reason`, `screenshot`, `duration_ms`.
8. **Every wait is bounded** (§10.5–10.6): page fetches use `AbortController`, per-account settle budget 90s, prewarm rounds have a deadline. A hung Chrome must never delay the DMs.

## Kill-switches (`.env`)

- `DEEP_PREWARM=0` — skip prewarm; full login for every account at noon (`runStandard`).
- `WIPE_GUARD=0` — disable the post-noon hold (pre-2026-10-01 behavior); `WIPE_HOLD_SEC` sets the hold window (default 10).
- `SUBMIT_VIA=click` — real button click instead of the default in-page `fetch` POST.
- `PREWARM_LEAD_SEC` — prewarm lead before noon (default 300; the cron itself is fixed at 11:55).
