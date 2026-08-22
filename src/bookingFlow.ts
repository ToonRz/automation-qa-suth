// src/bookingFlow.ts
// Per-account booking flow with retry-with-fallback loop + parallel court discovery.
//
// Performance: 6 badminton courts are queried in PARALLEL via fetch() in the page
// context (~500ms) instead of sequentially via selectOption + AJAX wait (~2.7s).
// Parallel fetch returns BOTH the per-court availability filter AND the per-court
// slot list (computed as ALL_SLOTS − reserved), so we skip the redundant dropdown
// read that the page's onchange handler would force us into. Combined with short
// (3s) timeouts on selectOption/submit, this drops per-account cost to ~2-3s even
// when falling back to multiple courts.
//
// Flow:
//   1. Login (fresh BrowserContext per call — BR-01/02)
//   2. Parallel-fetch reserved times for all 6 badminton courts in one page.evaluate
//      (must include `date` — server returns [] without it)
//   3. Compute available slots per court from parallel-fetch data
//   4. Iterate priority queue (config-driven COURT_PRIORITY → remaining badminton)
//      trying ONLY the account's own slot per court
//   5. For each "has-my-slot" court: selectOption(court) → selectOption(slot) → submit
//      (race-loss with another parallel account is caught by short timeout)
//   6. Bail out on success / "already booked today" / 30s deadline
//
// Spec note: this implements requirements §3.4 (slot-time-first, court-priority-second).
// The court priority list comes from `COURT_PRIORITY` in config/accounts.json (see
// src/server/configLoader.ts). Per-court slot fallback is intentionally disabled —
// every account tries ONLY its own slot across the priority list.

import { Browser, BrowserContext, Dialog, Locator, Page, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface Account {
  username: string;
  password: string;
  /** @deprecated Use COURT_PRIORITY in config/accounts.json (see
   *  src/server/configLoader.ts). Kept for backward compat with running
   *  accounts that still have the field set; the booking flow no longer
   *  consults it — court selection is config-driven via `FlowOptions.courtPriority`. */
  court?: string;
  slot: string;  // e.g. "17:30_18:30"
}

export interface AttemptRecord {
  court: string;
  slot: string;
  outcome: 'success' | 'slot-not-available' | 'submit-fail' | 'dry-run-would-book' | 'no-slots-on-court';
  reason?: string;
}

export interface BookingResult {
  username: string;
  triggered_at: string;
  court_attempted: string;
  court_booked: string | null;
  slot: string;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'DRY-RUN';
  fail_reason: string | null;
  screenshot: string;
  duration_ms: number;
  /** Full trail of (court, slot) attempts — useful for post-mortem and tuning. */
  attempts: AttemptRecord[];
}

export interface FlowOptions {
  dryRun?: boolean;        // skip the final submit click
  screenshotsDir?: string; // override default screenshot directory
  browser?: Browser;       // reuse an existing browser (single launch across N contexts)
  retryDeadlineMs?: number;// override 30s retry budget (for tests)
  /**
   * Ordered list of courts every account tries first with their own slot.
   * Sourced from `COURT_PRIORITY` in config/accounts.json (see
   * src/server/configLoader.ts). The booking loop appends remaining badminton
   * courts in dropdown order as a safety net after this list.
   *
   * Optional in the type for caller convenience — every production caller
   * (runner.ts, scheduler.ts, bookingEngine.ts) injects COURTS from
   * configLoader. bookOneAccount treats undefined as `[]` and degrades to
   * the safety-net-only path (every court is tried in dropdown order).
   */
  courtPriority?: string[];
  /**
   * A page that has ALREADY been navigated to login.php and had username/password
   * filled in but NOT submitted. Used by the pre-warm optimization: open N contexts
   * + fill forms during the countdown, then click submit on all N in the same tick
   * to shave ~500-1000ms off the noon race.
   *
   * When provided: the function reuses the existing page/context and only clicks
   * submit. When omitted: standard navigate + fill + submit.
   */
  prewarmedLoginPage?: Page;
  /**
   * A page that has ALREADY been logged in, navigated to booking.php, and had
   * #court + #time pre-selected for (account.court, account.slot). The confirm
   * button is NOT clicked yet — the noon-tick phase clicks it.
   *
   * Used by `runWithDeepPrewarm` (DEEP_PREWARM=1): at T-5min, submit login +
   * select court + select slot on N pages in parallel; at 12:00:00.000 click
   * confirm on all N in the same tick.
   *
   * When provided: skips login and immediately attempts ONE confirm click on
   * the already-selected (court, slot), with no dropdown read/re-select or
   * availability request first. On submit-fail, it then falls through to the
   * existing retry-with-fallback loop and re-queries /get_reserved_times.
   *
   * Note: when this is set, `bookOneAccount` does NOT own the context — the
   * caller (the engine) is responsible for closing it.
   */
  prewarmedBookingPage?: Page;
  /**
   * Court label selected during deep prewarm. Passing it from the engine avoids
   * any dropdown read before the noon fast-confirm click.
   */
  prewarmedCourtLabel?: string;
}

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';
const BOOKING_URL = 'https://susport.sc.su.ac.th/booking.php';
const RESERVED_TIMES_PATH = 'get_reserved_times';
const DEFAULT_SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'screenshots');
const DEFAULT_RETRY_DEADLINE_MS = 30_000;

// Submit-outcome timing. The submit click no longer BLOCKS on the POST
// navigation (see attemptSubmit* — we click with noWaitAfter and observe the
// POST response separately). These bound how long we wait for the server to
// answer the booking POST before classifying, and how long we give a possible
// success-redirect to reach reservations.php once the POST has responded.
//
// Why this matters: Playwright's default click waits for the triggered
// navigation to commit. At noon susport frequently answers the booking POST in
// 1.5-2.5s (occasionally slower), so a 3s click timeout used to THROW while the
// POST was still in flight — the account was misreported ERROR/submit-fail even
// though it had booked. Waiting for the POST response with a generous timeout
// fixes that.
const SUBMIT_RESULT_TIMEOUT_MS = 15_000;
const SUBMIT_REDIRECT_SETTLE_MS = 1_500;

/**
 * Grace retry window for soft-hold slot recovery at T+0.
 *
 * Catches server clock skew (50-200ms) where the assigned slot's server-side
 * fairness reset hasn't completed by the time the bot's fast-confirm clicks
 * submit. A single retry within this window recovers the slot.
 *
 * Cost: ~150-200ms (one attemptSubmitBooking). Bounded to 200ms so the total
 * per-account cost stays well under DEEP_PREWARM_DRIFT_SKIP_MS (30s) even when
 * all 9 accounts hit the grace path.
 *
 * Set to 0 to disable.
 */
const MAX_GRACE_MS = 200;

// All slot values available on the booking system (per discoverSlots finding).
// Used to compute "available = ALL_SLOTS − reserved".
export const ALL_SLOTS = [
  '16:30_17:30',
  '17:30_18:30',
  '18:30_19:30',
  '19:30_20:30',
  '20:30_21:30',
  '21:30_22:30',
];

// Heuristic text indicators. These are brittle — if the site copy changes,
// update here. We use TIGHT success indicators only — the word "ยืนยัน"
// appears in the rules text on every booking.php page and would cause false
// positive PASS if used as success.
// "You have already booked a court today" (server's 1-booking-per-day limit) —
// TERMINAL: the account must NOT try other courts.
//
// Must stay SPECIFIC. The bare substring 'จองแล้ว' was removed because it also
// matches race-loss copy like "เวลานี้มีผู้จองแล้ว" (someone ELSE booked this
// slot) — which is the opposite case and must fall back to the next court, not
// stop. This matters now that dialog text is fed into the classifier (see
// classifySubmissionResult); before, race-loss alerts were never read.
const ALREADY_BOOKED_INDICATORS = [
  'ได้จองสนามวันนี้แล้ว',
  'จองสนามวันนี้แล้ว',
  'already booked today',
];
// Success (secondary signal): explicit "booked" confirmation copy, from either
// a dialog message or the page body. The PRIMARY success signal is landing on
// reservations.php with our own username in a booking row — see
// classifySubmissionResult. Kept TIGHT: the bare word "success" was removed
// because it can appear in unrelated markup/analytics and risks a false PASS.
const SUCCESS_INDICATORS = ['จองเรียบร้อย', 'จองสำเร็จ', 'จองสนามสำเร็จ', 'booking success'];
// Failure words that NEVER appear on the post-acknowledge status page —
// 'เต็ม' (without แล้ว) used to be here but was a false-positive trap:
// the status page lists every booked slot as "เต็มแล้ว" and a substring
// match on 'เต็ม' flipped real-success into submit-fail.
const FAILURE_INDICATORS = ['ล้มเหลว', 'ผิดพลาด', 'ไม่สำเร็จ', 'error', 'ซ้ำ', 'ไม่ว่าง'];
// The post-submit reservations view is titled "การจองสนามในวันที่ <date>".
// This exact phrase does NOT appear on the booking FORM page (whose only
// similar copy is the rules line "ระเบียบการจองสนามกีฬา"), so it is a safe
// marker for "we are on the reservations page".
//
// The old marker was the bare substring 'การจองสนาม', which ALSO matched the
// rules line "ระเบียบ*การจองสนาม*กีฬา" on the empty booking form — so any bounce
// back to the form was misclassified as a PASS (5 empty-form screenshots were
// reported PASS on 2026-08-22). Tightened to the full title here, and success
// now additionally requires our own username to be present in the page.
const RESERVATION_PAGE_HEADER = 'การจองสนามในวันที่';
const RESERVATIONS_URL_MARKER = 'reservations.php';

type AttemptOutcome =
  | { type: 'success' }
  | { type: 'slot-not-available' }
  | { type: 'already-booked' }
  | { type: 'submit-fail'; reason: string };

interface CourtInfo {
  label: string;
  value: string;
}

// ---------- helpers ----------

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function shoot(page: Page, filePath: string, fullPage = false): Promise<void> {
  ensureDir(path.dirname(filePath));
  // Default = viewport-only screenshot (~150-400KB). fullPage screenshot pulls
  // the entire rendered body (~2-5MB) and dominates disk I/O at end-of-run for
  // 9 accounts. We keep fullPage available as an opt-in for the ERROR path so
  // a thrown exception's full stack context is preserved.
  await page.screenshot({ path: filePath, fullPage });
}

/**
 * Wait for the time dropdown to populate after a court selection.
 * The booking page fires an AJAX POST to /get_reserved_times.php when the court changes.
 * This races the network response against a DOM check.
 */
async function waitForSlotDropdown(page: Page, timeout = 10000): Promise<void> {
  await Promise.race([
    page.waitForResponse((r) => r.url().includes(RESERVED_TIMES_PATH), { timeout }),
    page.waitForFunction(
      () => {
        const sel = document.querySelector('#time') as HTMLSelectElement | null;
        return sel !== null && sel.options.length > 0 && sel.options[0].value !== '';
      },
      { timeout }
    ),
  ]).catch(() => {
    /* timeout — caller will treat empty dropdown as slot-not-available */
  });
}

/** Returns all court dropdown entries with their backing values, filtered to badminton only.
 *
 * Timeout: 8s (not Playwright's 30s default). If #court is absent the page is not
 * the booking form — e.g. we were redirected to reservations.php after an
 * already-booked login, or a submit navigated away. Waiting the full 30s there
 * only delays the inevitable FAIL and eats into the 30s retry budget (this is
 * exactly what turned two already-booked accounts into 33s ERRORs on 2026-08-22).
 */
export async function getBadmintonCourts(page: Page): Promise<CourtInfo[]> {
  return await page.locator('#court').evaluate((el) => {
    const sel = el as HTMLSelectElement;
    return Array.from(sel.options)
      .map((o) => ({ label: (o.textContent ?? '').trim(), value: o.value }))
      .filter((o) => o.label.includes('แบดมินตัน') && !o.label.includes('เทนนิส'));
  }, { timeout: 8_000 });
}

/**
 * Fetch reserved slot values for all 6 badminton courts IN PARALLEL via fetch()
 * inside the page context. Each request is a POST to /get_reserved_times.php with
 * court_id=<value>&date=<YYYY-MM-DD>. Response is a JSON array of reserved slot values.
 *
 * IMPORTANT: `date` must be included. Without it the server returns [] (empty) and
 * every court appears empty-booked → the flow picks slots that aren't in the actual
 * #time dropdown → selectOption fails with "did not find some options". We compute
 * the date in the page context using `new Date()` to match the page's own AJAX call.
 *
 * Returns Map<courtValue, reservedSlots[]>. If the server rejects all requests
 * (CSRF / 403 / HTML response), the map is empty for those courts — caller treats
 * it as "no available slots" and the account's retry loop bails.
 *
 * Performance: ~500ms (6 parallel POSTs) vs ~2.7s for sequential selectOption.
 * NOTE: result is used as a BINARY HINT (skip courts with all slots reserved).
 * The actual slot list comes from the #time dropdown (see getDropdownSlots).
 */
export async function fetchAllReservedTimes(
  page: Page,
  courtValues: string[]
): Promise<Map<string, string[]>> {
  const result = await page.evaluate(
    async (values) => {
      // Compute today's date in the page's local context — matches the date the
      // page's own onchange handler sends in its AJAX request.
      const d = new Date();
      const dateStr =
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0');

      const out: Record<string, string[]> = {};
      // Capture CSRF token if present (defensive — some Thai-uni booking systems require it)
      const csrfInput = document.querySelector(
        'input[name="csrf_token"], input[name="_token"], input[name="csrfmiddlewaretoken"]'
      ) as HTMLInputElement | null;
      const csrf = csrfInput?.value ?? '';

      await Promise.all(
        values.map(async (v) => {
          try {
            const body = new URLSearchParams();
            body.set('court_id', v);
            body.set('date', dateStr);
            if (csrf) body.set('csrf_token', csrf);
            const res = await fetch('/get_reserved_times.php', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: body.toString(),
              credentials: 'same-origin',
            });
            if (!res.ok) {
              out[v] = [];
              return;
            }
            const text = await res.text();
            try {
              const data = JSON.parse(text);
              out[v] = Array.isArray(data) ? data.filter((x) => typeof x === 'string') : [];
            } catch {
              // Server returned non-JSON (likely HTML error page) — treat as no data
              out[v] = [];
            }
          } catch {
            out[v] = [];
          }
        })
      );
      return out;
    },
    courtValues
  );

  const map = new Map<string, string[]>();
  for (const v of courtValues) {
    map.set(v, result[v] ?? []);
  }
  return map;
}

/**
 * Classify the page state after a booking submit into success / already-booked /
 * submit-fail.
 *
 * `username` is REQUIRED: a real PASS is only granted when the server has taken
 * us to the reservations page AND our own account's row is present. This is the
 * fix for the false-PASS bug — the old logic granted success on the bare
 * substring "การจองสนาม", which is also inside the rules line
 * "ระเบียบการจองสนามกีฬา" on the empty booking FORM, so every bounce back to the
 * form was reported PASS.
 *
 * `dialogMessages` are any window.alert/confirm texts captured during the submit
 * (Playwright would otherwise auto-dismiss and discard them). They carry the
 * server's own reason on race-loss ("มีผู้จองแล้ว" etc.) — used for detection
 * and for a human-readable fail_reason.
 */
async function classifySubmissionResult(
  page: Page,
  username: string,
  dialogMessages: string[] = []
): Promise<AttemptOutcome> {
  const url = page.url();
  const bodyText = (await page.locator('body').textContent().catch(() => '')) ?? '';
  // Search both the rendered page and any captured dialog text.
  const haystacks = [bodyText, ...dialogMessages];
  const matches = (indicators: string[]): boolean =>
    haystacks.some((h) => indicators.some((s) => h.includes(s)));

  // 1. Already booked today — terminal (do NOT try other courts).
  if (matches(ALREADY_BOOKED_INDICATORS)) {
    return { type: 'already-booked' };
  }

  // 2. PRIMARY success: we are on the reservations page AND our own username
  //    appears in a booking row. Both conditions are required — a redirect
  //    without our row, or our username on some other page, is not proof.
  const onReservationsPage =
    url.includes(RESERVATIONS_URL_MARKER) || bodyText.includes(RESERVATION_PAGE_HEADER);
  const myRowPresent = bodyText.includes(username);
  if (onReservationsPage && myRowPresent) {
    return { type: 'success' };
  }

  // 3. Explicit failure (race-loss / server error) — caller retries next court.
  if (matches(FAILURE_INDICATORS)) {
    const reason = (dialogMessages[0] ?? bodyText).replace(/\s+/g, ' ').trim().slice(0, 200);
    return { type: 'submit-fail', reason: reason || 'server reported failure' };
  }

  // 4. SECONDARY success: server explicitly said "booked" (dialog or body) even
  //    though we could not confirm the reservations row (e.g. no redirect).
  if (matches(SUCCESS_INDICATORS)) {
    return { type: 'success' };
  }

  // 5. Anything else — including a bounce back to the empty booking form — is
  //    NOT a booking. This is the case the old code wrongly called PASS.
  const reason = dialogMessages.length
    ? `dialog: ${dialogMessages.join(' | ').slice(0, 180)}`
    : `no booking confirmed (url=${url})`;
  return { type: 'submit-fail', reason };
}

/**
 * Click a submit control and wait for the server to answer the booking POST,
 * WITHOUT letting the click block on that navigation.
 *
 * Playwright's default click waits for the POST-triggered navigation to commit,
 * so a 3s click timeout THROWS while the POST is still in flight — at noon
 * susport often answers in 1.5-2.5s (sometimes slower), which is why 12/17
 * accounts were misreported on 2026-08-22 even though their POST had been sent.
 * We click with noWaitAfter (returns once the button is pressed) and observe the
 * POST response + any success redirect explicitly, with generous timeouts.
 *
 * Returns captured dialog text and POST telemetry. Throws only if the click
 * itself cannot be performed (button missing/covered) — the caller treats that
 * as submit-fail.
 */
async function clickSubmitAndAwaitOutcome(
  page: Page,
  submitBtn: Locator
): Promise<{ dialogMessages: string[]; postObserved: boolean; postDelayMs: number | null }> {
  const dialogMessages: string[] = [];
  const onDialog = (dialog: Dialog): void => {
    dialogMessages.push(dialog.message());
    // Match Playwright's default (auto-dismiss); we only add capture on top.
    dialog.dismiss().catch(() => {});
  };
  page.on('dialog', onDialog);

  const clickStartedAt = Date.now();
  let postObserved = false;
  let postDelayMs: number | null = null;

  // Arm the POST-response observer BEFORE the click so it is registered before
  // the request fires. Fires on both success and failure — it is the universal
  // "server has processed the submit" signal.
  const postResponse = page
    .waitForResponse(
      (r) => r.request().method() === 'POST' && !r.url().includes(RESERVED_TIMES_PATH),
      { timeout: SUBMIT_RESULT_TIMEOUT_MS }
    )
    .then(() => {
      postObserved = true;
      postDelayMs = Date.now() - clickStartedAt;
    })
    .catch(() => {
      /* no POST observed within the window — classifier will read the page */
    });

  try {
    await submitBtn.click({ timeout: 3000, noWaitAfter: true });
  } catch (err) {
    page.off('dialog', onDialog);
    throw err;
  }

  // Wait for the server to answer, then give a possible success redirect a short
  // window to land on reservations.php before we classify. On failure (no
  // redirect) this only costs SUBMIT_REDIRECT_SETTLE_MS.
  await postResponse;
  await page
    .waitForURL((u) => u.href.includes(RESERVATIONS_URL_MARKER), {
      timeout: SUBMIT_REDIRECT_SETTLE_MS,
    })
    .catch(() => null);
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);

  page.off('dialog', onDialog);
  return { dialogMessages, postObserved, postDelayMs };
}

/**
 * Noon fast path for a deep-prewarmed page. Court and slot were selected at
 * T-5min, so this function arms request telemetry and clicks confirm without
 * reading or changing any dropdown first.
 */
async function attemptSubmitPreselectedBooking(
  page: Page,
  username: string,
  courtLabel: string,
  slot: string
): Promise<AttemptOutcome> {
  const clickStartedAt = Date.now();
  const submitBtn = page
    .locator('button:has-text("จอง"), input[type="submit"][value*="จอง" i]')
    .first();

  let outcome;
  try {
    outcome = await clickSubmitAndAwaitOutcome(page, submitBtn);
  } catch {
    return { type: 'submit-fail', reason: 'deep-prewarm submit click failed' };
  }

  const requestDelay = outcome.postDelayMs === null ? 'not-observed' : `${outcome.postDelayMs}ms`;
  console.log(
    `[perf] ${username} fast_confirm court=${courtLabel} slot=${slot} ` +
      `click_started=${new Date(clickStartedAt).toISOString()} request_delay=${requestDelay} ` +
      `post_observed=${outcome.postObserved} url=${page.url()}`
  );

  return classifySubmissionResult(page, username, outcome.dialogMessages);
}

async function attemptSubmitBooking(
  page: Page,
  court: CourtInfo,
  slot: string,
  username: string
): Promise<AttemptOutcome> {
  const tStart = Date.now();
  try {
    await page.locator('#court').selectOption(court.value, { timeout: 3000 });
  } catch {
    return { type: 'submit-fail', reason: 'selectOption(court) timeout' };
  }

  // Wait for the AJAX response + dropdown to populate (short window)
  await Promise.race([
    page.waitForResponse(
      (r) => r.url().includes(RESERVED_TIMES_PATH),
      { timeout: 3000 }
    ),
    page.waitForFunction(
      () => {
        const sel = document.querySelector('#time') as HTMLSelectElement | null;
        return sel !== null && sel.options.length > 0 && sel.options[0].value !== '';
      },
      { timeout: 3000 }
    ),
  ]).catch(() => null);
  console.log(`[perf] attempt court=${court.label} slot=${slot} select_court_ajax=${Date.now() - tStart}ms`);

  const tSelectSlot = Date.now();
  try {
    await page.locator('#time').selectOption(slot, { timeout: 3000 });
  } catch {
    return { type: 'submit-fail', reason: 'slot not in dropdown (race?)' };
  }
  console.log(`[perf] attempt court=${court.label} slot=${slot} select_slot=${Date.now() - tSelectSlot}ms`);

  const submitBtn = page
    .locator('button:has-text("จอง"), input[type="submit"][value*="จอง" i]')
    .first();

  const tSubmit = Date.now();
  let outcome;
  try {
    outcome = await clickSubmitAndAwaitOutcome(page, submitBtn);
  } catch {
    return { type: 'submit-fail', reason: 'submit click failed' };
  }
  console.log(
    `[perf] attempt court=${court.label} slot=${slot} submit=${Date.now() - tSubmit}ms ` +
      `post_observed=${outcome.postObserved} url=${page.url()}`
  );
  return classifySubmissionResult(page, username, outcome.dialogMessages);
}

/**
 * Navigate back to the booking page so the next attempt starts from a clean state.
 * After a submit, the server may redirect to a confirmation page; without this,
 * re-selecting a court would target the wrong page.
 *
 * Perf: prefer `history.back()` (no network round-trip when the previous entry
 * in the tab's history is booking.php — typical after a submit-fail since
 * attemptSubmitBooking lands us on the post-submit confirm/failure page).
 * Falls back to `page.goto(BOOKING_URL)` if back doesn't land on booking.php
 * within 1.5s or the #court selector doesn't appear. Net effect on the retry
 * loop: ~1-3s saved per race-loss × N race-loss accounts.
 */
async function resetToBookingPage(page: Page): Promise<void> {
  if (page.url().includes('booking.php')) return;

  // Soft path — back-nav to booking.php if we can confirm it within 1.5s.
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 1500 });
    if (page.url().includes('booking.php')) {
      await page.waitForSelector('#court', { timeout: 2000 });
      return;
    }
  } catch {
    /* goBack timed out or no history entry — fall through to goto */
  }

  // Hard path — full re-navigation. Same semantics as before this optimization.
  await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#court', { timeout: 10000 });
}

/**
 * Build priority-ordered court list from a config-driven priority array.
 *
 * Layered behavior:
 *   1. Priority list (config-driven) — entries that exist in `available`,
 *      in given order.
 *   2. Safety net — remaining badminton courts (the dropdown order may have
 *      inserted แบดมินตัน3/5/6 after the priority entries) appended in
 *      their original dropdown order.
 *
 * Within a court the per-account slot is the ONLY slot tried (slot priority
 * is the user's chosen slot — no per-court slot fallback, by user direction).
 *
 * Replaces the older `prioritizeCourts(assigned, available)` which was driven
 * by the now-deprecated per-account `court` field.
 */
export function buildCourtPriority(
  priorityList: string[],
  available: CourtInfo[]
): CourtInfo[] {
  const out: CourtInfo[] = [];
  const seen = new Set<string>();
  // Layer 1: config-driven priority, only entries present in the dropdown.
  for (const label of priorityList) {
    const court = available.find((c) => c.label === label);
    if (court && !seen.has(court.label)) {
      out.push(court);
      seen.add(court.label);
    }
  }
  // Layer 2: safety net — remaining badminton courts in dropdown order.
  for (const court of available) {
    if (!seen.has(court.label)) {
      out.push(court);
      seen.add(court.label);
    }
  }
  return out;
}

// ---------- main entry ----------

export async function bookOneAccount(
  account: Account,
  options: FlowOptions = {}
): Promise<BookingResult> {
  const triggered_at = new Date().toISOString();
  const start = Date.now();
  const screenshotsDir = options.screenshotsDir ?? DEFAULT_SCREENSHOTS_DIR;
  const screenshot = path.join(screenshotsDir, `${account.username}.png`);
  const deadlineMs = options.retryDeadlineMs ?? DEFAULT_RETRY_DEADLINE_MS;
  // Treat undefined courtPriority as "no priority list" — degrades to the
  // safety-net-only path (every court tried in dropdown order).
  const priorityCourts = options.courtPriority ?? [];

  const result: BookingResult = {
    username: account.username,
    triggered_at,
    court_attempted: priorityCourts[0] ?? account.court ?? '',
    court_booked: null,
    slot: account.slot,
    status: 'ERROR',
    fail_reason: null,
    screenshot,
    duration_ms: 0,
    attempts: [],
  };

  let browser: Browser | null = options.browser ?? null;
  let ownBrowser = false;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const deepPrewarmed = options.prewarmedBookingPage !== undefined;

  try {
    // ---- Deep-prewarm fast path ----
    // The engine already verified and selected (court, slot) at T-5min. There
    // must be no await, dropdown read, context creation, or availability fetch
    // before this click: Promise.all callers therefore dispatch every account's
    // click in the same JavaScript tick.
    if (deepPrewarmed) {
      page = options.prewarmedBookingPage!;
      if (!page.url().includes('booking.php')) {
        result.status = 'FAIL';
        result.fail_reason = `deep-prewarm: page not on booking.php (${page.url()})`;
        if (!options.dryRun) await shoot(page, screenshot);
        return result;
      }
      const courtLabel = options.prewarmedCourtLabel ?? priorityCourts[0];
      if (!courtLabel) {
        result.status = 'FAIL';
        result.fail_reason = 'deep-prewarm: selected court label missing';
        if (!options.dryRun) await shoot(page, screenshot);
        return result;
      }

      if (options.dryRun) {
        result.attempts.push({
          court: courtLabel,
          slot: account.slot,
          outcome: 'dry-run-would-book',
        });
        result.court_booked = courtLabel;
        result.status = 'DRY-RUN';
        result.fail_reason = `would book ${courtLabel}/${account.slot} (submit skipped)`;
        await shoot(page, screenshot);
        return result;
      }

      const outcome = await attemptSubmitPreselectedBooking(
        page,
        account.username,
        courtLabel,
        account.slot
      );
      if (outcome.type === 'success') {
        result.attempts.push({ court: courtLabel, slot: account.slot, outcome: 'success' });
        result.court_booked = courtLabel;
        result.status = 'PASS';
        result.fail_reason = null;
        await shoot(page, screenshot);
        return result;
      }
      if (outcome.type === 'already-booked') {
        result.attempts.push({
          court: courtLabel,
          slot: account.slot,
          outcome: 'submit-fail',
          reason: 'already-booked',
        });
        result.status = 'FAIL';
        result.fail_reason = 'server: already booked today';
        await shoot(page, screenshot);
        return result;
      }

      result.attempts.push({
        court: courtLabel,
        slot: account.slot,
        outcome: 'submit-fail',
        reason:
          outcome.type === 'submit-fail'
            ? outcome.reason
            : 'slot-not-available after deep-prewarm submit',
      });
      // Only a failed fast-confirm is allowed to enter the slower discovery +
      // fallback path. Restore booking.php if the submit response navigated away.
      await resetToBookingPage(page);
    } else if (options.prewarmedLoginPage) {
      // Pre-warm path: caller already navigated to login.php and filled the form.
      // Click immediately; the engine owns and closes this context.
      page = options.prewarmedLoginPage;
      await page.locator('input[type="submit"]').click();
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
    } else {
      // Standard path: create the account's isolated context, navigate, fill,
      // and submit. Prewarmed paths already own their isolated contexts.
      if (!browser) {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        ownBrowser = true;
      }
      context = await browser.newContext({ storageState: undefined });
      page = await context.newPage();
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('input[name="username"]').fill(account.username);
      await page.locator('input[name="password"]').fill(account.password);
      await page.locator('input[type="submit"]').click();
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);
    }

    // Login can land on either booking.php (normal) or reservations.php (if user
    // already booked today — server redirects to their existing reservation view).
    // reservations.php is not a login failure; it's a "already booked" state.
    if (page.url().includes('reservations.php')) {
      result.status = 'FAIL';
      result.fail_reason = 'already booked today (reservations.php after login)';
      if (!options.dryRun) await shoot(page, screenshot);
      return result;
    }
    if (!page.url().includes('booking.php')) {
      result.status = 'FAIL';
      result.fail_reason = `login failed (landed on ${page.url()})`;
      if (!options.dryRun) await shoot(page, screenshot);
      return result;
    }

    console.log(`[perf] ${account.username} login_end=${Date.now() - start}ms`);

    // ---- Parallel discovery: query all 6 courts in one round-trip ----
    // Computes BOTH (a) which courts have open slots AND (b) the per-court slot
    // list. With `date` included, the response matches what the page's own onchange
    // handler shows in the #time dropdown — so we don't need a separate dropdown
    // read per court (saves ~500ms × courts-to-try).
    const allBadmintonCourts = await getBadmintonCourts(page);
    const courtValues = allBadmintonCourts.map((c) => c.value);
    const tFetchStd = Date.now();
    const reservedByValue = await fetchAllReservedTimes(page, courtValues);
    console.log(`[perf] ${account.username} fetch_reserved=${Date.now() - tFetchStd}ms`);

    const availableByValue = new Map<string, string[]>();
    for (const court of allBadmintonCourts) {
      const reserved = reservedByValue.get(court.value) ?? [];
      const available = ALL_SLOTS.filter((s) => !reserved.includes(s));
      availableByValue.set(court.value, available);
    }

    // ---- Retry-with-fallback loop ----
    const deadline = Date.now() + deadlineMs;
    const courtsToTry = buildCourtPriority(priorityCourts, allBadmintonCourts);

    let booked: { court: string; slot: string } | null = null;
    let earlyExit: 'already-booked' | null = null;
    // After a failed submit, the server may redirect us to a confirmation/failure
    // page. We only need to navigate back to booking.php before the NEXT attempt.
    // On the first attempt we're already on booking.php — skip the reset.
    let onBookingPage = true;

    outer: for (const court of courtsToTry) {
      if (Date.now() >= deadline) break;

      const available = availableByValue.get(court.value) ?? [];

      // Grace retry for the priority[0] court when the /get_reserved_times
      // snapshot says all slots are taken — but the server-side fairness reset
      // may have completed between snapshot and now. One more submit within
      // MAX_GRACE_MS catches the clock-skew window on the priority court.
      // (For other courts we still retry the same account.slot — see below.)
      if (
        available.length === 0 &&
        court.label === priorityCourts[0] &&
        Date.now() - start < MAX_GRACE_MS
      ) {
        if (!onBookingPage) {
          await resetToBookingPage(page);
          onBookingPage = true;
        }
        const graceOutcome = await attemptSubmitBooking(page, court, account.slot, account.username);
        if (graceOutcome.type === 'success') {
          result.attempts.push({
            court: court.label,
            slot: account.slot,
            outcome: 'success',
          });
          booked = { court: court.label, slot: account.slot };
          break outer;
        } else if (graceOutcome.type === 'already-booked') {
          result.attempts.push({
            court: court.label,
            slot: account.slot,
            outcome: 'submit-fail',
            reason: 'already-booked',
          });
          earlyExit = 'already-booked';
          break outer;
        }
        result.attempts.push({
          court: court.label,
          slot: account.slot,
          outcome: 'submit-fail',
          reason: `grace-retry: ${graceOutcome.type === 'submit-fail' ? graceOutcome.reason : 'unknown'}`,
        });
        onBookingPage = false;
      }

      if (available.length === 0) {
        result.attempts.push({ court: court.label, slot: '-', outcome: 'no-slots-on-court' });
        continue;
      }

      // Per user direction: only the account's own slot is attempted within any
      // court. No per-court slot fallback — if my slot isn't available here, we
      // move on to the next priority court (or fail at the end if all are full).
      const slot = account.slot;
      if (!available.includes(slot)) {
        result.attempts.push({ court: court.label, slot, outcome: 'slot-not-available' });
        continue;
      }

      if (options.dryRun) {
        result.attempts.push({ court: court.label, slot, outcome: 'dry-run-would-book' });
        booked = { court: court.label, slot };
        break outer;
      }

      // Real path: selectOption(court) + selectOption(slot) + submit. Race-loss
      // with a parallel account is caught by the 3s selectOption timeout — the
      // dropdown won't include the slot, so we skip and try the next (court, slot).
      if (!onBookingPage) {
        await resetToBookingPage(page);
        onBookingPage = true;
      }
      const outcome = await attemptSubmitBooking(page, court, slot, account.username);
      if (outcome.type === 'success') {
        result.attempts.push({ court: court.label, slot, outcome: 'success' });
        booked = { court: court.label, slot };
        break outer;
      }
      if (outcome.type === 'already-booked') {
        result.attempts.push({
          court: court.label,
          slot,
          outcome: 'submit-fail',
          reason: 'already-booked',
        });
        earlyExit = 'already-booked';
        break outer;
      }
      result.attempts.push({
        court: court.label,
        slot,
        outcome: 'submit-fail',
        reason: outcome.type === 'submit-fail' ? outcome.reason : undefined,
      });
      // submit-fail (race or other) — page is now off booking.php, must reset
      onBookingPage = false;
    }

    // ---- Result classification ----
    if (booked) {
      result.court_booked = booked.court;
      result.slot = booked.slot;
      if (options.dryRun) {
        result.status = 'DRY-RUN';
        result.fail_reason = `would book ${booked.court}/${booked.slot} (submit skipped)`;
      } else {
        result.status = 'PASS';
        result.fail_reason = null;
      }
      await shoot(page, screenshot);
      return result;
    }

    if (earlyExit === 'already-booked') {
      result.status = 'FAIL';
      result.fail_reason = 'server: already booked today';
      if (!options.dryRun) await shoot(page, screenshot);
      return result;
    }

    // Exhausted all (court, slot) combinations within deadline.
    // Distinguish "slot reserved on every court" (the new invariant violation)
    // from a generic "no (court, slot) pair available" — the former is a
    // clearer signal for the user and matches the deep-prewarm abort reason.
    const slotTakenEverywhere = courtsToTry.every(
      (c) => !(availableByValue.get(c.value) ?? []).includes(account.slot)
    );
    if (slotTakenEverywhere) {
      result.status = 'FAIL';
      result.fail_reason = `slot ${account.slot} ไม่ว่างในทุกสนาม (priority + safety net exhausted)`;
      result.court_attempted = priorityCourts[0] ?? account.court ?? '';
    } else {
      const triedLabels = courtsToTry
        .filter((c) => (availableByValue.get(c.value)?.length ?? 0) === 0)
        .map((c) => `${c.label}: no slots`);
      const trail = triedLabels.length > 0 ? ` tried: ${triedLabels.slice(0, 6).join(', ')}` : '';
      result.status = 'FAIL';
      result.fail_reason = `no available (court, slot) within ${Math.round(deadlineMs / 1000)}s${trail}`;
      result.court_attempted = priorityCourts[0] ?? account.court ?? '';
    }
    if (!options.dryRun) await shoot(page, screenshot);
    return result;
  } catch (err) {
    result.status = 'ERROR';
    result.fail_reason = `${err}`;
    if (page && !options.dryRun) {
      try {
        // fullPage on ERROR — exception context (stack trace, console errors)
        // may render far below the fold and the post-mortem author needs it.
        await shoot(page, screenshot, true);
      } catch {
        /* ignore */
      }
    }
    return result;
  } finally {
    result.duration_ms = Date.now() - start;
    if (context) await context.close();
    if (browser && ownBrowser) await browser.close();
  }
}
