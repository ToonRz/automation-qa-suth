# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Playwright-based E2E automation for booking badminton courts on `https://susport.sc.su.ac.th/login.php`. 9 accounts run **in parallel, triggered exactly at 12:00:00 local time** (no tolerance).

## Project rule — scope discipline (user instruction)

> **สำคัญคือ base on requirement ถ้านอกเหนือให้ถามก่อน**
> All changes must be grounded in `requirements.md`. If a task goes outside the spec — new tooling, new dependencies, new behavior, new acceptance criteria — **stop and ask the user first** before implementing.

## Source of truth

- **`requirements.md`** — full functional spec. Treat it as the contract; this file only summarizes it.
- **`config/accounts.json`** — credentials + per-account slot time. Currently all slots are `TBD` (see §9 of the spec). Do not invent slot values.

## Stack (per requirements §4)

| Component | Choice |
|-----------|--------|
| Language | TypeScript (Node.js) |
| Automation | Playwright |
| Parallelism | `Promise.all()` across 9 isolated `BrowserContext`s |
| Browser | Chromium built-in or `channel: 'chrome'` |
| Scheduler | Node.js native `setTimeout` against `Date` |
| Config | `accounts.json` (credentials + slot) — never hardcoded in source |
| Report | JSON + Playwright HTML reporter + per-account screenshot |

## Develop / Run

After the initial scaffold (package.json + playwright.config.ts + src/), the day-to-day commands are:

```bash
npm install
npx playwright install chromium

# Run the scheduled booking bot (waits until 12:00:00, then fires all 9)
npm start

# Run a single account's flow end-to-end (debugging aid)
npm run account -- <username>

# Tests — Playwright Test runner
npx playwright test                # full suite
npx playwright test --grep "login" # single test by name
npx playwright test --headed       # watch locally
```

## Project layout (per requirements §5)

```
court-booking-bot/
├── package.json
├── playwright.config.ts
├── config/accounts.json      ← credentials + per-account slot (slots are TBD)
├── src/
│   ├── scheduler.ts          ← waitUntilNoonThenRun()
│   ├── runner.ts             ← Promise.all of 9 contexts
│   └── bookingFlow.ts        ← per-account: login → court → book
├── reports/                  ← auto-generated JSON + HTML
└── screenshots/              ← one per account, PASS and FAIL
```

## Hard rules from requirements

These are non-negotiable. They are the basis for every fix, refactor, and review.

1. **Strict 12:00:00 trigger, no tolerance** (SC-04). Scheduler fires on the exact local-noon millisecond.
2. **Never reuse a context** (BR-01/02). Each account = `browser.newContext()` with `storageState: undefined`. `context.close()` on every exit path — success or failure.
3. **Court fallback is fixed** (§3.4): แบดมินตัน1 → แบดมินตัน4 → `FAIL` with reason `"ทั้ง 2 สนามเต็ม"`. No other court, no reordered fallback.
4. **Parallel release** (SC-05). All 9 contexts must start in the same tick via `Promise.all`. One slow login must not delay the others.
5. **Screenshot every account** (Report Requirements, §7). Both PASS and FAIL.
6. **Per-account report fields** (requirements §7): `username`, `triggered_at`, `court_attempted`, `court_booked`, `slot`, `status`, `fail_reason`, `screenshot`, `duration_ms`.

## Per-account flow (requirements §3.3)

```
newContext → https://susport.sc.su.ac.th/login.php
  → fill username/password → submit → confirm login
  → navigate to booking page
  → select แบดมินตัน1 (fallback แบดมินตัน4) → pick slot → submit
  → verify booking success → record result + screenshot
  → context.close()
```

## Known gap

`requirements.md` §9: **slot times per account are still `TBD`.** Do not fabricate values — surface this to the user before running.