// src/server/bookingEngine.ts
// The bot's booking engine. ONE batch run covers every user's accounts (single
// browser, one isolated context per account, one Promise.all dispatch at the
// tick — fair race for everyone; BR-01/02 only forbid reusing a *context*).
//
// Per-account prewarm state, degraded gracefully:
//
//   page-ready   — logged in + (court, slot) pre-selected at T-lead. Noon
//                  fires the submit immediately (~50ms in fetch mode).
//   login-ready  — logged in, parked on booking.php, but pre-select was
//                  impossible (the 11:55 dropdown still reflects YESTERDAY's
//                  bookings — the server resets at 12:00 — so fully-booked
//                  courts have no <option>). Noon injects the cached court id
//                  and POSTs, or reloads once when no id is cached.
//   needs-standard — login redirected to reservations.php (account already
//                  holds a booking). Standard path at noon reports it.
//   failed       — login/navigation broke. Retried every RETRY_INTERVAL_MS
//                  until T-RETRY_STOP_BEFORE_MS; whatever is still failed
//                  falls back to the standard full-login path at noon.
//
// Modes (bot.ts picks): DEEP_PREWARM=0 → skip prewarm entirely, runStandard at
// noon (kill-switch). Anything else → runPrewarmedBatch. The old shallow
// prewarm (fill login form, don't submit) was removed — login-ready strictly
// dominates it.
//
// Cleanup (contexts + browser) is DETACHED: it starts after the results are
// returned, with per-step timing logs and a 30s hang watchdog
// (closeWithTiming). On 2026-08-22 the teardown was where ~11 minutes
// disappeared between "all bookings done" and "results DM'd" — it can no
// longer block reporting, and the logs will name the culprit if it recurs.

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import {
  bookOneAccount,
  closeWithTiming,
  Account,
  BookingResult,
  FlowOptions,
  getBadmintonCourts,
  fetchAllReservedTimes,
  buildCourtPriority,
} from '../bookingFlow';
import { updateCourtIds } from '../courtIdCache';
import { waitUntilLocalTimestamp } from '../localClock';
import { COURTS } from './configLoader';
import { getOwner } from './userStore';

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';
const SCREENSHOTS_DIR = '/app/screenshots'; // overridden via env in deploy

/** How many ms BEFORE targetTime the prewarm fires. Read lazily so callers
 *  (rehearse) can set PREWARM_LEAD_SEC before the first call, not before
 *  module load. Default 300s = 11:55 for a 12:00 target. */
export function prewarmLeadMs(): number {
  return Number(process.env.PREWARM_LEAD_SEC ?? '300') * 1000;
}

// Transient-failure retry cadence inside the prewarm window.
const RETRY_INTERVAL_MS = 30_000;
const RETRY_STOP_BEFORE_MS = 40_000; // no retry starts after T-40s

// If the engine wakes up this far past the tick, the slot race is already
// lost — surface a clear FAIL instead of probing for 30s per account.
const DRIFT_SKIP_MS = 30_000;

type PrewarmStatus = 'page-ready' | 'login-ready' | 'needs-standard' | 'failed';

interface PrewarmedAccount {
  account: Account;
  context: BrowserContext | null;
  page: Page | null;
  status: PrewarmStatus;
  courtLabel?: string;
  courtValue?: string;
  /** From the prewarm availability probe (PRE-reset data): is the account's
   *  slot open on at least one priority/safety-net court? Informational only —
   *  see the heads-up below. undefined when the probe didn't run. */
  slotOpenSomewhere?: boolean;
  error?: string;
}

export interface EngineResult {
  results: BookingResult[];
  mode: 'prewarm' | 'standard';
  total_ms: number;
}

export interface BatchOptions {
  dryRun?: boolean;
  /** Called once per account, in dispatch order, the moment its booking
   *  settles — lets bot.ts DM each user as soon as THEIR slice completes
   *  instead of waiting for the whole batch. Never throws into the engine. */
  onAccountSettled?: (index: number, result: BookingResult) => void;
  /** Rehearsal: suppress the Telegram heads-up DM. */
  suppressAlerts?: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseFlowOptions(browser: Browser, opts: BatchOptions): FlowOptions {
  return {
    browser,
    courtPriority: COURTS,
    screenshotsDir: process.env.SCREENSHOTS_DIR ?? SCREENSHOTS_DIR,
    dryRun: opts.dryRun,
  };
}

/**
 * Prewarm ONE account: fresh context → login → booking.php → try to
 * pre-select (court, slot). Never throws; failures are encoded in `status`.
 */
async function prewarmOne(browser: Browser, account: Account): Promise<PrewarmedAccount> {
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('input[name="username"]').fill(account.username);
    await page.locator('input[name="password"]').fill(account.password);
    await page.locator('input[type="submit"]').click();
    await page.waitForURL(/booking\.php|reservations\.php/, { timeout: 10000 });
    if (page.url().includes('reservations.php')) {
      // Already holds a booking — the standard path at noon reports it.
      return { account, context, page, status: 'needs-standard', error: 'reservations.php after login' };
    }

    // ---- Pre-select (may legitimately fail on stale-dropdown days) ----
    try {
      const courts = await getBadmintonCourts(page);
      updateCourtIds(courts); // teach the login-ready fast path its ids
      const courtValues = courts.map((c) => c.value);
      const reservedMap = await fetchAllReservedTimes(page, courtValues);
      const prioritized = buildCourtPriority(COURTS, courts);
      const slotOpenSomewhere = prioritized.some(
        (c) => !(reservedMap.get(c.value) ?? []).includes(account.slot)
      );
      const alt =
        prioritized.find((c) => !(reservedMap.get(c.value) ?? []).includes(account.slot)) ??
        prioritized[0];
      if (!alt) throw new Error('no badminton court in dropdown (stale pre-reset data)');
      await page.locator('select#court').selectOption({ label: alt.label }, { timeout: 5000 });
      await page.waitForFunction(
        () => {
          const s = document.querySelector('select#time');
          return !!s && s.children.length > 1;
        },
        { timeout: 5000 }
      );
      await page.locator('select#time').selectOption({ value: account.slot }, { timeout: 5000 });
      return {
        account,
        context,
        page,
        status: 'page-ready',
        courtLabel: alt.label,
        courtValue: alt.value,
        slotOpenSomewhere,
      };
    } catch (preSelectErr) {
      // Login worked — KEEP the live context/page and finish selection at
      // noon (inject from the court-id cache, or reload once).
      const message =
        preSelectErr instanceof Error ? preSelectErr.message : String(preSelectErr);
      return {
        account,
        context,
        page,
        status: 'login-ready',
        error: `pre-select failed: ${message.split('\n')[0]}`,
      };
    }
  } catch (err) {
    // Login/navigation broke — transient candidates (goto timeout, network).
    const message = err instanceof Error ? err.message : String(err);
    if (context) await context.close().catch(() => null);
    return { account, context: null, page: null, status: 'failed', error: message.split('\n')[0] };
  }
}

function tallies(entries: PrewarmedAccount[]): string {
  const count = (s: PrewarmStatus): number => entries.filter((e) => e.status === s).length;
  return (
    `${count('page-ready')} page-ready / ${count('login-ready')} login-ready / ` +
    `${count('needs-standard')} needs-standard / ${count('failed')} failed`
  );
}

/**
 * Best-effort informational DM to the owner when the PRE-reset data says some
 * accounts' slots are taken on every court. Since 12:00 wipes the data this
 * is a "today is contested" signal, NOT a prediction — the engine changes
 * nothing based on it (the old version demoted accounts to standard mode,
 * which acted on yesterday's data; that behavior was removed).
 */
async function sendPrewarmHeadsUp(stuck: { username: string; slot: string }[]): Promise<void> {
  const owner = getOwner();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!owner || !token) return;
  const text =
    `⚠️ Prewarm heads-up (ข้อมูลก่อน reset เที่ยง)\n\n` +
    `slot ของ ${stuck.length} account เต็มทุกสนามตามข้อมูลเมื่อวาน:\n` +
    stuck.map((s) => `  - ${s.username} (slot=${s.slot})`).join('\n') +
    `\n\nข้อมูลชุดนี้จะถูกล้างตอน 12:00 — bot จะยิงตามปกติทุก account ` +
    `(วันนี้น่าจะแข่งสูง)`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: owner.chat_id, text }),
      signal: ctrl.signal,
    });
    if (!res.ok) console.warn(`[bookingEngine] heads-up DM ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}

/** Detached teardown with per-step timing. Never awaited by callers. */
async function cleanupBatch(entries: PrewarmedAccount[], browser: Browser): Promise<void> {
  const t0 = Date.now();
  for (const e of entries) {
    if (!e.context) continue;
    const ctx = e.context;
    await closeWithTiming(`ctx ${e.account.username}`, () => ctx.close());
    e.context = null;
    e.page = null;
  }
  await closeWithTiming('browser (batch)', () => browser.close());
  console.log(`[cleanup] batch teardown total=${Date.now() - t0}ms`);
}

/** Standard parallel run — full login per account at call time, no prewarm.
 *  The kill-switch path (DEEP_PREWARM=0) and the engine's own fallback. */
export async function runStandard(
  accounts: Account[],
  opts: BatchOptions = {}
): Promise<EngineResult> {
  const start = Date.now();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const results = await Promise.all(
      accounts.map((account, i) =>
        bookOneAccount(account, baseFlowOptions(browser, opts)).then((r) => {
          try {
            opts.onAccountSettled?.(i, r);
          } catch {
            /* callback errors must not affect the batch */
          }
          return r;
        })
      )
    );
    return { results, mode: 'standard', total_ms: Date.now() - start };
  } finally {
    // Accounts closed their own contexts (they own them on the standard
    // path); only the shared browser remains — detached, timed.
    void closeWithTiming('browser (standard)', () => browser.close());
  }
}

/**
 * The main engine: prewarm every account at T-lead (with transient-failure
 * retries), wait for the exact local tick, then dispatch ALL accounts in one
 * synchronous map — page-ready and login-ready fire their submits in the same
 * JavaScript tick; needs-standard/failed take the full-login path.
 */
export async function runPrewarmedBatch(
  accounts: Account[],
  targetTime: Date,
  opts: BatchOptions = {}
): Promise<EngineResult> {
  const start = Date.now();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let entries: PrewarmedAccount[] = [];
  try {
    // Phase 0: sleep until the prewarm window opens.
    const prewarmFireAt = targetTime.getTime() - prewarmLeadMs();
    if (Date.now() < prewarmFireAt) {
      const waitMs = prewarmFireAt - Date.now();
      console.log(`[bookingEngine] prewarm sleeping ${Math.round(waitMs / 1000)}s until window`);
      await sleep(waitMs);
    }

    // Phase 1: prewarm all accounts in parallel.
    entries = await Promise.all(accounts.map((a) => prewarmOne(browser, a)));
    console.log(`[bookingEngine] prewarm: ${tallies(entries)}`);
    for (const e of entries) {
      if (e.status !== 'page-ready') {
        console.log(`[bookingEngine]   ${e.account.username}: ${e.status} (${e.error ?? 'no error'})`);
      }
    }

    // Phase 1b: retry transient failures until T-RETRY_STOP_BEFORE_MS.
    // Only 'failed' retries — login-ready/needs-standard are deterministic
    // states, not errors (retrying them re-does work for the same answer).
    const retryDeadline = targetTime.getTime() - RETRY_STOP_BEFORE_MS;
    while (entries.some((e) => e.status === 'failed') && Date.now() < retryDeadline) {
      const wait = Math.min(RETRY_INTERVAL_MS, retryDeadline - Date.now());
      if (wait <= 0) break;
      await sleep(wait);
      if (Date.now() >= retryDeadline) break;
      const failedIdx = entries
        .map((e, i) => (e.status === 'failed' ? i : -1))
        .filter((i) => i >= 0);
      console.log(`[bookingEngine] prewarm retry for ${failedIdx.length} failed account(s)`);
      const retried = await Promise.all(failedIdx.map((i) => prewarmOne(browser, entries[i].account)));
      retried.forEach((r, k) => {
        entries[failedIdx[k]] = r;
      });
      console.log(`[bookingEngine] prewarm after retry: ${tallies(entries)}`);
    }

    // Phase 1c: informational heads-up (pre-reset data — changes NOTHING).
    const stuck = entries
      .filter((e) => e.slotOpenSomewhere === false)
      .map((e) => ({ username: e.account.username, slot: e.account.slot }));
    if (stuck.length > 0) {
      console.warn(
        `[bookingEngine] heads-up: ${stuck.length} account slot(s) full everywhere in PRE-reset data — ` +
          `booking proceeds normally at noon`
      );
      if (!opts.suppressAlerts) {
        await sendPrewarmHeadsUp(stuck).catch((err) =>
          console.error(`[bookingEngine] heads-up DM failed: ${err}`)
        );
      }
    }

    // Phase 1d: nudge pages so idle renderers don't drift into throttling.
    for (const e of entries) {
      if (e.page) await e.page.evaluate(() => 1).catch(() => null);
    }

    // Phase 2: the exact local tick (SC-01/SC-04).
    await waitUntilLocalTimestamp(targetTime.getTime());
    const firedAt = new Date();
    const driftMs = firedAt.getTime() - targetTime.getTime();

    if (driftMs > DRIFT_SKIP_MS) {
      console.warn(
        `[bookingEngine] dispatch SKIPPED (drift ${driftMs}ms > ${DRIFT_SKIP_MS}ms — race already lost)`
      );
      const missResults: BookingResult[] = accounts.map((account) => ({
        username: account.username,
        triggered_at: firedAt.toISOString(),
        court_attempted: COURTS[0] ?? account.court ?? '',
        court_booked: null,
        slot: account.slot,
        status: 'FAIL',
        fail_reason: `missed-deadline: dispatch started ${driftMs}ms past fire time`,
        screenshot: '',
        duration_ms: 0,
        attempts: [],
      }));
      missResults.forEach((r, i) => {
        try {
          opts.onAccountSettled?.(i, r);
        } catch {
          /* ignore */
        }
      });
      return { results: missResults, mode: 'prewarm', total_ms: Date.now() - start };
    }

    console.log(
      `[bookingEngine] FIRE at ${firedAt.toISOString()} ` +
        `(target ${targetTime.toISOString()}, drift ${driftMs}ms) — ${tallies(entries)}`
    );

    // Phase 3: single synchronous dispatch across ALL accounts.
    const results = await Promise.all(
      entries.map((e, i) => {
        const base = baseFlowOptions(browser, opts);
        let p: Promise<BookingResult>;
        if (e.status === 'page-ready' && e.page) {
          p = bookOneAccount(e.account, {
            ...base,
            prewarmedBookingPage: e.page,
            prewarmedCourtLabel: e.courtLabel,
            prewarmedCourtValue: e.courtValue,
          });
        } else if (e.status === 'login-ready' && e.page) {
          p = bookOneAccount(e.account, { ...base, loginReadyPage: e.page });
        } else {
          p = bookOneAccount(e.account, base);
        }
        return p.then((r) => {
          try {
            opts.onAccountSettled?.(i, r);
          } catch {
            /* callback errors must not affect the batch */
          }
          return r;
        });
      })
    );

    return { results, mode: 'prewarm', total_ms: Date.now() - start };
  } finally {
    // Detached teardown — results/DMs never wait on Chrome shutdown.
    void cleanupBatch(entries, browser).catch((err) =>
      console.warn(`[bookingEngine] detached cleanup error: ${err}`)
    );
  }
}
