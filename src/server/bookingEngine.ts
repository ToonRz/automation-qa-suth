// src/server/bookingEngine.ts
// The bot's booking entry point. Three modes:
//
//   - runStandard(accounts): launch browser, run all N in parallel, no warmup.
//     Always-safe baseline.
//
//   - runWithPrewarm(accounts, targetTime): during the countdown, open N contexts
//     and fill each login form WITHOUT submitting. At the exact tick, click submit
//     on all N in the same Promise.all. This saves ~500-1000ms vs navigating at
//     12:00:00.000.
//
//   - runWithDeepPrewarm(accounts, targetTime): OPT-IN via DEEP_PREWARM=1.
//     Fires at PREWARM_LEAD_SEC seconds (default 300 = 5 min) before targetTime.
//     Each context: navigates login.php → fills → SUBMITS login → selects court
//     dropdown → selects slot dropdown. The confirm button is NOT clicked yet.
//     At the exact tick, click confirm on all N in the same Promise.all. If the
//     pre-warm fails for some accounts (login error, navigation timeout, slot
//     dropdown did not populate), those accounts fall back to runStandard
//     behavior at noon — the per-account mixed mode keeps the rest fast.
//
// Selection: bot.ts picks the mode per user via env. Default is shallow prewarm
// (runWithPrewarm) which preserves the proven 6/9 baseline; DEEP_PREWARM=1
// upgrades owner tasks to runWithDeepPrewarm.
//
// Each account's prewarmed context has its OWN browser context (BR-01/02).

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import {
  bookOneAccount,
  Account,
  BookingResult,
  FlowOptions,
  getBadmintonCourts,
  fetchAllReservedTimes,
  buildCourtPriority,
  ALL_SLOTS,
} from '../bookingFlow';
import { getServerNow } from '../timeSync';
import { COURTS } from './configLoader';
import { getOwner } from './userStore';

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';
const SCREENSHOTS_DIR = '/app/screenshots'; // overridden via env in deploy

// Deep-prewarm timing: how many seconds BEFORE targetTime the deep pre-warm
// fires. 5 minutes balances PHP session GC (default 1440s) and slot-volatility
// risk (other users may book between pre-warm and noon). Override via env.
const PREWARM_LEAD_MS = Number(process.env.PREWARM_LEAD_SEC ?? '300') * 1000;
// If server-clock skew is detected between pre-warm and tick, we still try the
// fast confirm — per-account state drift is caught by bookOneAccount's sanity
// check. Reserved for future use if telemetry shows skew matters.
const CLOCK_SKEW_THRESHOLD_MS = 1000;

interface PrewarmedContext {
  account: Account;
  context: BrowserContext;
  page: Page;
}

interface PrewarmedDeepContext {
  account: Account;
  context: BrowserContext | null;
  page: Page | null;
  status: 'page-ready' | 'needs-standard' | 'failed';
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open N contexts and pre-fill each login form. Does NOT submit.
 * Throws on navigation/timeout errors — caller falls back to standard mode.
 */
async function prewarmContexts(
  browser: Browser,
  accounts: Account[]
): Promise<PrewarmedContext[]> {
  return await Promise.all(
    accounts.map(async (account) => {
      const context = await browser.newContext({ storageState: undefined });
      const page = await context.newPage();
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.locator('input[name="username"]').fill(account.username);
      await page.locator('input[name="password"]').fill(account.password);
      return { account, context, page };
    })
  );
}

async function spinUntil(targetMs: number): Promise<void> {
  while (getServerNow() < targetMs) {
    await sleep(1);
  }
}

/**
 * Best-effort Telegram DM to the owner listing accounts whose assigned slot
 * was reserved on every court at T-5min. Mirrors the native-fetch +
 * AbortController pattern in src/server/telegramSend.ts. Failure to send must
 * NOT abort the booking — the console line in the caller is the source of
 * truth.
 */
async function sendDeepPrewarmAbortAlert(
  stuckAccounts: { username: string; slot: string }[]
): Promise<void> {
  const owner = getOwner();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!owner || !token) return; // console line above is the source of truth
  const text =
    `⛔ DEEP PREWARM ABORTED (T-5min)\n\n` +
    `${stuckAccounts.length} account(s) ไม่มีสนามว่างสำหรับ slot ที่จอง:\n` +
    stuckAccounts.map((s) => `  - ${s.username} (slot=${s.slot})`).join('\n') +
    `\n\nBot จะรัน standard mode ตอนเที่ยงแทน — ตรวจสอบ slot ที่ถูกจองไปก่อนหน้า`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: owner.chat_id, text }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) {
      console.warn(`[bookingEngine] abort-alert DM ${res.status}`);
    }
  } finally {
    clearTimeout(t);
  }
}

export interface EngineResult {
  results: BookingResult[];
  mode: 'prewarm' | 'standard';
  total_ms: number;
}

/** Standard parallel run — same shape as the CLI, no login pre-fill. */
export async function runStandard(accounts: Account[]): Promise<EngineResult> {
  const start = Date.now();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const results = await Promise.all(
      accounts.map((account) =>
        bookOneAccount(account, {
          browser,
          courtPriority: COURTS,
          screenshotsDir: process.env.SCREENSHOTS_DIR ?? SCREENSHOTS_DIR,
        })
      )
    );
    return { results, mode: 'standard', total_ms: Date.now() - start };
  } finally {
    await browser.close();
  }
}

/**
 * Pre-warm + fire. Saves ~500-1000ms vs standard by doing the navigate + form
 * fill during the countdown, leaving only the submit click for the noon tick.
 *
 * Falls back to runStandard() if prewarm throws (susport rate-limit, network
 * flakiness during warmup, etc.). The fallback is logged and surfaced in
 * `result.mode` so the bot can report it.
 */
export async function runWithPrewarm(
  accounts: Account[],
  targetTime: Date
): Promise<EngineResult> {
  const start = Date.now();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let contexts: PrewarmedContext[] = [];
  try {
    // Phase 1: warm up. If this fails, fall through to standard.
    try {
      contexts = await prewarmContexts(browser, accounts);
    } catch (err) {
      console.warn(`[bookingEngine] prewarm failed (${err}); falling back to standard`);
      await browser.close();
      return runStandard(accounts);
    }

    // Phase 2: spin-wait for the exact tick (server-synced clock).
    await spinUntil(targetTime.getTime());
    const fired_at = new Date();
    console.log(
      `[bookingEngine] FIRE at ${fired_at.toISOString()} ` +
        `(target ${targetTime.toISOString()}, drift ${fired_at.getTime() - targetTime.getTime()}ms)`
    );

    // Phase 3: click submit on all N in the same tick (one Promise.all).
    const results = await Promise.all(
      contexts.map(({ account, page }) =>
        bookOneAccount(account, {
          prewarmedLoginPage: page,
          browser,
          courtPriority: COURTS,
          screenshotsDir: process.env.SCREENSHOTS_DIR ?? SCREENSHOTS_DIR,
        })
      )
    );

    return { results, mode: 'prewarm', total_ms: Date.now() - start };
  } finally {
    // Close all contexts (BR-04) then the shared browser.
    await Promise.all(contexts.map(({ context }) => context.close().catch(() => null)));
    await browser.close();
  }
}

/**
 * Open N contexts, submit login on each, navigate to booking.php, and
 * pre-select the assigned (court, slot). The confirm button is NOT clicked.
 * Returns per-account outcomes — successful contexts have status='page-ready'
 * with a `page` handle ready for the noon confirm click; failures carry an
 * error message and a null page so the caller can route them to standard mode.
 *
 * Per-account errors do NOT reject the whole Promise.all — each account is
 * wrapped in its own try/catch so partial success is preserved (mixed mode).
 */
async function prewarmContextsDeep(
  browser: Browser,
  accounts: Account[]
): Promise<PrewarmedDeepContext[]> {
  return await Promise.all(
    accounts.map(async (account): Promise<PrewarmedDeepContext> => {
      let context: BrowserContext | null = null;
      try {
        context = await browser.newContext({ storageState: undefined });
        const page = await context.newPage();
        // 1. Login
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.locator('input[name="username"]').fill(account.username);
        await page.locator('input[name="password"]').fill(account.password);
        await page.locator('input[type="submit"]').click();
        await page.waitForURL(/booking\.php/, { timeout: 10000 });
        if (page.url().includes('reservations.php')) {
          // Already booked today — engine will run standard path which records
          // 'already booked today (reservations.php after login)' FAIL.
          return { account, context, page, status: 'needs-standard', error: 'reservations.php after login' };
        }
        // 2. Query all courts' availability at T-5min and pick the FIRST
        // priority-ordered court where `account.slot` is open. If the assigned
        // (court, slot) is soft-held by a pre-noon manual click, this avoids a
        // wasted pre-select + lets the noon-tick fast-confirm target a court
        // that's actually open. Falls back to the assigned court if no alt is
        // found — in that case the existing selectOption below is the original
        // behavior, and the grace retry in bookOneAccount handles server-side
        // fairness-reset skew at T+0.
        const allCourts = await getBadmintonCourts(page);
        const courtValues = allCourts.map((c) => c.value);
        const reservedMap = await fetchAllReservedTimes(page, courtValues);
        const prioritizedCourts = buildCourtPriority(COURTS, allCourts);
        const altCourt = prioritizedCourts.find((c) => {
          const reserved = reservedMap.get(c.value) ?? [];
          return !reserved.includes(account.slot);
        }) ?? prioritizedCourts[0];
        const targetCourtLabel = altCourt?.label ?? COURTS[0];
        // 3. Select court dropdown (assigned OR alt with same slot)
        await page.locator('select#court').selectOption({ label: targetCourtLabel });
        // 4. Wait for the AJAX-driven #time dropdown to populate (more than the
        // default placeholder option). On timeout the slot is unavailable OR
        // the page never hydrated — fall through to standard mode.
        await page.waitForFunction(
          () => {
            const s = document.querySelector('select#time');
            return !!s && s.children.length > 1;
          },
          { timeout: 5000 },
        );
        // 5. Select slot dropdown
        await page.locator('select#time').selectOption({ value: account.slot });
        return { account, context, page, status: 'page-ready' };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Close the partial context on failure to avoid leaking resources.
        if (context) await context.close().catch(() => null);
        return { account, context: null, page: null, status: 'failed', error: message };
      }
    }),
  );
}

export interface DeepPrewarmEngineResult extends EngineResult {
  perAccount: PrewarmedDeepContext[];
  /** True when the invariant check found accounts whose assigned slot is reserved
   *  on every priority + safety-net court. Bot can surface this in summary DMs. */
  prewarmAborted: boolean;
  /** Usernames whose slot was reserved on every court at T-5min. */
  abortedAccounts: string[];
}

/**
 * Deep pre-warm + fire. Saves ~3-5s vs standard by doing navigate + login +
 * court/slot selection during the countdown (default 5 min before noon),
 * leaving only the confirm-button click for the noon tick.
 *
 * Mixed mode: per-account outcomes are tracked individually. At noon, accounts
 * whose pre-warm succeeded get a fast confirm click (one Promise.all). Accounts
 * whose pre-warm failed (login error, dropdown drift, navigation timeout) fall
 * back to standard `bookOneAccount` (no `prewarmedBookingPage`) — they pay the
 * full login cost but still get the EXTENDED-court fallback safety net.
 *
 * Late fallback: if a fast confirm loses the slot race, the existing retry
 * loop in `bookOneAccount` re-queries `/get_reserved_times` and tries
 * fallback courts. This is the same safety net that saved 4 of 6 PASS accounts
 * in the 2026-06-28 run.
 *
 * Rollback: set DEEP_PREWARM=0 to bypass this and use runWithPrewarm instead.
 */
export async function runWithDeepPrewarm(
  accounts: Account[],
  targetTime: Date
): Promise<DeepPrewarmEngineResult> {
  const start = Date.now();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let contexts: PrewarmedDeepContext[] = [];
  try {
    // Sleep until the pre-warm fire window opens (T - PREWARM_LEAD_MS).
    const prewarmFireAt = targetTime.getTime() - PREWARM_LEAD_MS;
    const now = getServerNow();
    if (now < prewarmFireAt) {
      const waitMs = prewarmFireAt - now;
      console.log(`[bookingEngine] deep-prewarm sleeping ${Math.round(waitMs / 1000)}s until fire window`);
      await sleep(waitMs);
    }

    // Phase 1: deep prewarm. Each account is wrapped so partial failure is OK.
    contexts = await prewarmContextsDeep(browser, accounts);
    const ready = contexts.filter((c) => c.status === 'page-ready').length;
    const std = contexts.filter((c) => c.status === 'needs-standard').length;
    const fail = contexts.filter((c) => c.status === 'failed').length;
    console.log(
      `[bookingEngine] deep-prewarm: ${ready} ready / ${std} needs-standard / ${fail} failed`
    );
    // Surface per-account failure reasons for debugging.
    for (const c of contexts) {
      if (c.status !== 'page-ready') {
        console.log(`[bookingEngine]   ${c.account.username}: ${c.status} (${c.error ?? 'no error'})`);
      }
    }

    // ---- INVARIANT CHECK: every account must have its own slot open in at least
    // one priority + safety-net court at T-5min. If a pre-noon manual booking
    // already took the slot everywhere, abort the prewarm with a loud alert so
    // the user can act before noon instead of wasting 3-5s on a doomed fast-
    // confirm. Stuck contexts are marked 'failed' and dispatched to standard
    // mode at noon (the 30s retry budget can still recover if the manual
    // bookings are withdrawn).
    const stuckAccounts: { username: string; slot: string }[] = [];
    for (const c of contexts) {
      if (c.status !== 'page-ready' || !c.page) continue;
      try {
        const courts = await getBadmintonCourts(c.page);
        const values = courts.map((cc) => cc.value);
        const reserved = await fetchAllReservedTimes(c.page, values);
        const priorityCourts = buildCourtPriority(COURTS, courts);
        const anyOpen = priorityCourts.some((court) => {
          const taken = reserved.get(court.value) ?? [];
          return !taken.includes(c.account.slot);
        });
        if (!anyOpen) {
          stuckAccounts.push({ username: c.account.username, slot: c.account.slot });
        }
      } catch (err) {
        // Reservation query failed — treat as "stuck" only if courts query succeeded.
        // Don't false-positive on transient network errors; log and continue.
        console.warn(
          `[bookingEngine] invariant check failed for ${c.account.username}: ${err}`
        );
      }
    }

    let prewarmAborted = false;
    let abortedAccounts: string[] = [];
    if (stuckAccounts.length > 0) {
      prewarmAborted = true;
      abortedAccounts = stuckAccounts.map((s) => s.username);
      console.error(
        `[bookingEngine] ABORT deep-prewarm — ${stuckAccounts.length} account(s) ` +
          `have NO viable court for their assigned slot at T-5min:\n` +
          stuckAccounts.map((s) => `  - ${s.username} (slot=${s.slot})`).join('\n')
      );
      await sendDeepPrewarmAbortAlert(stuckAccounts).catch((err) =>
        console.error(`[bookingEngine] telegram abort-alert failed: ${err}`)
      );
      for (const c of contexts) {
        if (stuckAccounts.some((s) => s.username === c.account.username)) {
          c.status = 'failed';
          c.error = `invariant: slot ${c.account.slot} ไม่ว่างในทุกสนาม at T-5min`;
          if (c.context) await c.context.close().catch(() => null);
          c.context = null;
          c.page = null;
        }
      }
    }

    // Tab-throttle mitigation: nudge each ready page so backgrounded Chromium
    // tabs don't drift into a throttled state during the 5-min idle window.
    for (const c of contexts) {
      if (c.page) await c.page.evaluate(() => 1).catch(() => null);
    }

    // Phase 2: spin to the exact tick (server-synced clock).
    await spinUntil(targetTime.getTime());
    const firedAt = new Date();
    const driftMs = firedAt.getTime() - targetTime.getTime();

    // Drift guard: if the engine woke up well past the fire time, the slot
    // race is already lost (other bots have claimed the (court, slot) pairs).
    // Skip the dispatch instead of wasting 30s probing for doomed attempts.
    // Seen on 2026-07-06: friend task drifted 69s past fire after waiting for
    // owner dispatch to complete in the sequential loop at bot.ts:1386, then
    // every probe timed out. This guard turns that into a surfaced FAIL with
    // a clear reason, instead of a "no available within 30s" mystery.
    const DEEP_PREWARM_DRIFT_SKIP_MS = 30_000;
    if (driftMs > DEEP_PREWARM_DRIFT_SKIP_MS) {
      console.warn(
        `[bookingEngine] deep-prewarm SKIPPED (drift ${driftMs}ms > ` +
          `${DEEP_PREWARM_DRIFT_SKIP_MS}ms threshold — slot race already lost)`
      );
      const missResults: BookingResult[] = accounts.map((account) => ({
        username: account.username,
        triggered_at: firedAt.toISOString(),
        court_attempted: COURTS[0] ?? account.court ?? '',
        court_booked: null,
        slot: account.slot,
        status: 'FAIL',
        fail_reason: `missed-deadline: prewarm started ${driftMs}ms past fire time`,
        screenshot: '',
        duration_ms: 0,
        attempts: [],
      }));
      return {
        results: missResults,
        mode: 'prewarm',
        total_ms: Date.now() - start,
        perAccount: contexts,
        prewarmAborted,
        abortedAccounts,
      };
    }

    console.log(
      `[bookingEngine] deep-prewarm FIRE at ${firedAt.toISOString()} ` +
        `(target ${targetTime.toISOString()}, drift ${driftMs}ms)`
    );

    // Phase 3: per-account dispatch (mixed mode).
    // - page-ready → fast confirm via prewarmedBookingPage
    // - needs-standard / failed → standard path (full login + retry loop)
    const results = await Promise.all(
      contexts.map(({ account, page, status }) => {
        const baseOpts: FlowOptions = {
          browser,
          courtPriority: COURTS,
          screenshotsDir: process.env.SCREENSHOTS_DIR ?? SCREENSHOTS_DIR,
        };
        if (status === 'page-ready' && page) {
          return bookOneAccount(account, { ...baseOpts, prewarmedBookingPage: page });
        }
        return bookOneAccount(account, baseOpts);
      })
    );

    return { results, mode: 'prewarm', total_ms: Date.now() - start, perAccount: contexts, prewarmAborted, abortedAccounts };
  } finally {
    // Close ALL deep-prewarmed contexts (BR-04) — engine owns them because
    // bookOneAccount received them via prewarmedBookingPage and did not own
    // their context. Standard-path accounts created their own contexts in
    // bookOneAccount and close them in their own finally.
    for (const c of contexts) {
      if (c.context) await c.context.close().catch(() => null);
    }
    await browser.close();
  }
}
