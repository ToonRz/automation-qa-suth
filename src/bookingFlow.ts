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
//   4. Iterate priority queue: assigned court → fallback → other badminton
//   5. For each "has-slots" court: selectOption(court) → selectOption(slot) → submit
//      (race-loss with another parallel account is caught by short timeout)
//   6. Bail out on success / "already booked today" / 30s deadline
//
// Spec note: this extends requirements §3.4 (originally PRIMARY=1, FALLBACK=4, ABORT=both
// full) with an EXTENDED layer that walks other badminton courts. Approved by user.

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface Account {
  username: string;
  password: string;
  court: string; // e.g. "แบดมินตัน1"
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
   * When provided: skips login, uses the live #time dropdown to compute the
   * assigned court's reserved set, attempts ONE confirm click on the assigned
   * (court, slot). On submit-fail, falls through to the existing retry-with-
   * fallback loop after re-querying /get_reserved_times.
   *
   * Note: when this is set, `bookOneAccount` does NOT own the context — the
   * caller (the engine) is responsible for closing it.
   */
  prewarmedBookingPage?: Page;
}

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';
const BOOKING_URL = 'https://susport.sc.su.ac.th/booking.php';
const RESERVED_TIMES_PATH = 'get_reserved_times';
const DEFAULT_SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'screenshots');
const DEFAULT_RETRY_DEADLINE_MS = 30_000;
const FALLBACK_COURT = 'แบดมินตัน4';

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
const ALREADY_BOOKED_INDICATORS = [
  'ได้จองสนามวันนี้แล้ว',
  'จองแล้ว',
  'already booked',
];
// Success: must be on a confirmation page (post-submit redirect). These phrases
// don't appear on the booking form page itself.
const SUCCESS_INDICATORS = ['จองเรียบร้อย', 'จองสำเร็จ', 'booking success', 'success'];
// Failure words that NEVER appear on the post-acknowledge status page —
// 'เต็ม' (without แล้ว) used to be here but was a false-positive trap:
// the status page lists every booked slot as "เต็มแล้ว" and a substring
// match on 'เต็ม' flipped real-success into submit-fail. Use the header
// check below instead for the status-page case.
const FAILURE_INDICATORS = ['ล้มเหลว', 'ผิดพลาด', 'ไม่สำเร็จ', 'error', 'ซ้ำ', 'ไม่ว่าง'];
// Post-submit "การจองสนามวันนี้" view — every booked slot renders "เต็มแล้ว"
// but no explicit-failure word. We use the page header ("การจองสนาม") as
// a distinctive marker rather than row count, since real failures can
// also contain "เต็ม" in a short message.
const STATUS_PAGE_HEADER = 'การจองสนาม';

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

async function shoot(page: Page, filePath: string): Promise<void> {
  ensureDir(path.dirname(filePath));
  await page.screenshot({ path: filePath, fullPage: true });
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

/** Returns all court dropdown entries with their backing values, filtered to badminton only. */
export async function getBadmintonCourts(page: Page): Promise<CourtInfo[]> {
  return await page.locator('#court').evaluate((el) => {
    const sel = el as HTMLSelectElement;
    return Array.from(sel.options)
      .map((o) => ({ label: (o.textContent ?? '').trim(), value: o.value }))
      .filter((o) => o.label.includes('แบดมินตัน') && !o.label.includes('เทนนิส'));
  });
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
 * Attempt to submit a booking for the given (court, slot). The page's #court
 * dropdown is selected first (triggers AJAX that populates #time), then #time
 * is selected, then the submit button is clicked.
 *
 * SHORT TIMEOUTS (3s) on selectOption and click — if the slot was taken by a
 * racing parallel account, the dropdown won't include it; we want to skip
 * fast, not wait 30s for the default Playwright actionability timeout.
 */
async function attemptSubmitBooking(
  page: Page,
  court: CourtInfo,
  slot: string
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
  try {
    await submitBtn.click({ timeout: 3000 });
  } catch {
    return { type: 'submit-fail', reason: 'submit click timeout' };
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
  console.log(`[perf] attempt court=${court.label} slot=${slot} submit=${Date.now() - tSubmit}ms`);

  const bodyText = (await page.locator('body').textContent()) ?? '';

  if (ALREADY_BOOKED_INDICATORS.some((s) => bodyText.includes(s))) {
    return { type: 'already-booked' };
  }

  const hasSuccess = SUCCESS_INDICATORS.some((s) => bodyText.includes(s));
  const hasExplicitFail = FAILURE_INDICATORS.some((s) => bodyText.includes(s));
  // Susport's post-acknowledge page (booking.php → "การจองสนามวันนี้"
  // status table) lists every booked slot as "เต็มแล้ว" but does NOT
  // include any explicit-failure word. Treat that page as success —
  // otherwise the server had accepted the booking but the bot recorded
  // submit-fail (false negative), and the next attempt would book a
  // second slot for the same account.
  const looksLikeStatusPage = bodyText.includes(STATUS_PAGE_HEADER);

  if (hasSuccess || looksLikeStatusPage) {
    return { type: 'success' };
  }
  if (hasExplicitFail) {
    return {
      type: 'submit-fail',
      reason: bodyText.replace(/\s+/g, ' ').trim().slice(0, 200),
    };
  }

  return {
    type: 'submit-fail',
    reason: `submit result unclear (url=${page.url()})`,
  };
}

/**
 * Navigate back to the booking page so the next attempt starts from a clean state.
 * After a submit, the server may redirect to a confirmation page; without this,
 * re-selecting a court would target the wrong page.
 */
async function resetToBookingPage(page: Page): Promise<void> {
  if (!page.url().includes('booking.php')) {
    await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  }
  await page.waitForSelector('#court', { timeout: 10000 });
}

/**
 * Build priority-ordered court list: assigned → FALLBACK_COURT → other badminton courts.
 */
export function prioritizeCourts(assigned: string, available: CourtInfo[]): CourtInfo[] {
  const priority: CourtInfo[] = [];
  const find = (label: string) => available.find((c) => c.label === label);
  const assignedCourt = find(assigned);
  if (assignedCourt) priority.push(assignedCourt);
  const fallback = find(FALLBACK_COURT);
  if (fallback && assigned !== FALLBACK_COURT) priority.push(fallback);
  for (const c of available) {
    if (!priority.includes(c)) priority.push(c);
  }
  return priority;
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

  const result: BookingResult = {
    username: account.username,
    triggered_at,
    court_attempted: account.court,
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
    // ---- Fresh context (BR-01/02) ----
    if (!browser) {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      ownBrowser = true;
    }
    // For deep-prewarmed accounts we still open a context so the `finally` close
    // call below has a non-null handle. The prewarmedBookingPage belongs to a
    // DIFFERENT context (owned by the engine); we close only the dummy one here
    // and let the engine's finally handle the real one. (This mirrors the
    // prewarmedLoginPage pattern above where the dummy context is closed and
    // the engine closes the actual prewarmed context.)
    context = await browser.newContext({ storageState: undefined });
    page = await context.newPage();

    // ---- Deep-prewarm fast path ----
    // The engine has already submitted login and pre-selected (court, slot).
    // Replace our dummy page with the prewarmed one, then verify state. Skip
    // the entire login block below.
    if (deepPrewarmed) {
      page = options.prewarmedBookingPage!;
      if (!page.url().includes('booking.php')) {
        result.status = 'FAIL';
        result.fail_reason = `deep-prewarm: page not on booking.php (${page.url()})`;
        if (!options.dryRun) await shoot(page, screenshot);
        return result;
      }
      // Sanity: dropdowns reflect the pre-warmed selection. If not, log a drift
      // event and let the retry loop below re-discover via /get_reserved_times.
      // We stay on booking.php (the URL check above confirmed) so no page-reset
      // is needed; attemptSubmitBooking will re-select the dropdowns.
      //
      // IMPORTANT: account.court is the OPTION LABEL (e.g. "แบดมินตัน1"), but
      // page.locator('#court').inputValue() returns the option's `value`
      // attribute (e.g. "2") — comparing the two is ALWAYS a phantom drift.
      // Confirmed via reports/slots-discovered.json: value="2" text="แบดมินตัน1".
      // account.slot on the other hand is the option VALUE (e.g. "17:30_18:30"),
      // matching the underscore format used in the AJAX response, so
      // inputValue() is the right comparison there.
      const selectedCourtLabel = await page
        .locator('#court option:checked')
        .textContent()
        .then((t) => (t ?? '').trim())
        .catch(() => null);
      const selectedSlotValue = await page
        .locator('#time')
        .inputValue()
        .catch(() => null);
      if (selectedCourtLabel !== account.court || selectedSlotValue !== account.slot) {
        result.attempts.push({
          court: account.court,
          slot: account.slot,
          outcome: 'submit-fail',
          reason: `deep-prewarm state drift: court=${selectedCourtLabel} slot=${selectedSlotValue}`,
        });
      }
    } else if (options.prewarmedLoginPage) {
      // Pre-warm path: caller already navigated to login.php and filled the form.
      // We just click submit on the existing page.
      page = options.prewarmedLoginPage;
      await page.locator('input[type="submit"]').click();
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
    } else {
      // Standard path: navigate, fill, submit.
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
    let reservedByValue: Map<string, string[]>;
    if (deepPrewarmed && result.attempts.length === 0) {
      // Deep-prewarm fast path: trust the pre-warmed state. The assigned court
      // is currently selected and the slot dropdown is populated by the page's
      // own onchange handler — its visible options ARE the available slots.
      // Fetch reservations for the OTHER courts (used by the late-fallback loop)
      // and override the assigned court's reserved set from the live dropdown.
      const liveSlotOptions = await page
        .locator('#time option')
        .evaluateAll((els) =>
          (els as HTMLOptionElement[])
            .map((o) => o.value)
            .filter((v) => v && v !== ''),
        )
        .catch(() => [] as string[]);
      const tFetchDp = Date.now();
      reservedByValue = await fetchAllReservedTimes(page, courtValues);
      console.log(`[perf] ${account.username} fetch_reserved=${Date.now() - tFetchDp}ms`);
      const assignedCourt = allBadmintonCourts.find((c) => c.label === account.court);
      if (assignedCourt) {
        // Reserved = ALL_SLOTS minus what's currently visible in the dropdown.
        reservedByValue.set(assignedCourt.value, ALL_SLOTS.filter((s) => !liveSlotOptions.includes(s)));
      }
    } else {
      const tFetchStd = Date.now();
      reservedByValue = await fetchAllReservedTimes(page, courtValues);
      console.log(`[perf] ${account.username} fetch_reserved=${Date.now() - tFetchStd}ms`);
    }

    const availableByValue = new Map<string, string[]>();
    for (const court of allBadmintonCourts) {
      const reserved = reservedByValue.get(court.value) ?? [];
      const available = ALL_SLOTS.filter((s) => !reserved.includes(s));
      availableByValue.set(court.value, available);
    }

    // ---- Retry-with-fallback loop ----
    const deadline = Date.now() + deadlineMs;
    const courtsToTry = prioritizeCourts(account.court, allBadmintonCourts);

    let booked: { court: string; slot: string } | null = null;
    let earlyExit: 'already-booked' | null = null;
    // After a failed submit, the server may redirect us to a confirmation/failure
    // page. We only need to navigate back to booking.php before the NEXT attempt.
    // On the first attempt we're already on booking.php — skip the reset.
    let onBookingPage = true;
    // Deep-prewarm fast-confirm: when set, we've already attempted the assigned
    // (court, slot) pair above, so the outer loop must skip the first iteration
    // of `account.court` to avoid double-submitting.
    let deepAttempted = false;

    // ---- Deep-prewarm fast-confirm: try assigned (court, slot) FIRST ----
    // The pre-warm engine has already selected these dropdowns and verified the
    // dropdown state. attemptSubmitBooking will (re-)select and click submit
    // without navigating, so the operation completes in ~tens of milliseconds.
    // On submit-fail (race-loss, slot already taken) we fall through to the
    // existing retry-with-fallback loop, which re-queries /get_reserved_times
    // and tries fallback courts — this is the late-fallback safety net.
    if (deepPrewarmed && result.attempts.length === 0) {
      const assignedCourt = allBadmintonCourts.find((c) => c.label === account.court);
      if (assignedCourt) {
        deepAttempted = true;
        if (options.dryRun) {
          result.attempts.push({
            court: assignedCourt.label,
            slot: account.slot,
            outcome: 'dry-run-would-book',
          });
          booked = { court: assignedCourt.label, slot: account.slot };
        } else {
          const outcome = await attemptSubmitBooking(page, assignedCourt, account.slot);
          if (outcome.type === 'success') {
            result.attempts.push({
              court: assignedCourt.label,
              slot: account.slot,
              outcome: 'success',
            });
            booked = { court: assignedCourt.label, slot: account.slot };
          } else if (outcome.type === 'already-booked') {
            result.attempts.push({
              court: assignedCourt.label,
              slot: account.slot,
              outcome: 'submit-fail',
              reason: 'already-booked',
            });
            earlyExit = 'already-booked';
          } else {
            result.attempts.push({
              court: assignedCourt.label,
              slot: account.slot,
              outcome: 'submit-fail',
              reason: outcome.type === 'submit-fail' ? outcome.reason : undefined,
            });

            // Grace retry: server fairness reset may not have completed yet
            // (clock skew 50-300ms). One more submit within MAX_GRACE_MS.
            if (Date.now() - start < MAX_GRACE_MS) {
              if (!onBookingPage) {
                await resetToBookingPage(page);
                onBookingPage = true;
              }
              const retryOutcome = await attemptSubmitBooking(page, assignedCourt, account.slot);
              if (retryOutcome.type === 'success') {
                result.attempts.push({
                  court: assignedCourt.label,
                  slot: account.slot,
                  outcome: 'success',
                });
                booked = { court: assignedCourt.label, slot: account.slot };
              } else if (retryOutcome.type === 'already-booked') {
                result.attempts.push({
                  court: assignedCourt.label,
                  slot: account.slot,
                  outcome: 'submit-fail',
                  reason: 'grace-retry: already-booked',
                });
                earlyExit = 'already-booked';
              } else {
                result.attempts.push({
                  court: assignedCourt.label,
                  slot: account.slot,
                  outcome: 'submit-fail',
                  reason: `grace-retry: ${retryOutcome.type === 'submit-fail' ? retryOutcome.reason : 'unknown'}`,
                });
                onBookingPage = false;
              }
            } else {
              onBookingPage = false;
            }
          }
        }
      }
    }

    outer: for (const court of courtsToTry) {
      // Skip the assigned court if fast-confirm already attempted it.
      if (deepAttempted && court.label === account.court) continue;
      // Skip if fast-confirm already resolved (success / already-booked).
      if (booked || earlyExit) break;
      if (Date.now() >= deadline) break;

      const available = availableByValue.get(court.value) ?? [];

      // Grace retry for assigned court when the /get_reserved_times snapshot
      // says all slots are taken — but the server-side fairness reset may
      // have completed between snapshot and now. One more submit within
      // MAX_GRACE_MS catches the clock-skew window on the assigned court.
      // (For non-assigned courts we have no slot to retry with, so skip.)
      if (
        available.length === 0 &&
        court.label === account.court &&
        Date.now() - start < MAX_GRACE_MS
      ) {
        if (!onBookingPage) {
          await resetToBookingPage(page);
          onBookingPage = true;
        }
        const graceOutcome = await attemptSubmitBooking(page, court, account.slot);
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

      // Slot priority: assigned first, then reverse chronological order
      // (21:30_22:30 → 16:30_17:30) for any other available slots on this
      // court. Matches user preference for back-to-front priority within a
      // court.
      const reversedAllSlots = ['21:30_22:30', '20:30_21:30', '19:30_20:30', '18:30_19:30', '17:30_18:30', '16:30_17:30'];
      const slotOrder = [
        account.slot,
        ...reversedAllSlots.filter((s) => s !== account.slot && available.includes(s)),
      ];

      for (const slot of slotOrder) {
        if (Date.now() >= deadline) break;
        if (!available.includes(slot)) continue;

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
        const outcome = await attemptSubmitBooking(page, court, slot);
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
    const triedLabels = courtsToTry
      .filter((c) => (availableByValue.get(c.value)?.length ?? 0) === 0)
      .map((c) => `${c.label}: no slots`);
    const trail = triedLabels.length > 0 ? ` tried: ${triedLabels.slice(0, 6).join(', ')}` : '';
    result.status = 'FAIL';
    result.fail_reason = `no available (court, slot) within ${Math.round(deadlineMs / 1000)}s${trail}`;
    result.court_attempted = account.court;
    if (!options.dryRun) await shoot(page, screenshot);
    return result;
  } catch (err) {
    result.status = 'ERROR';
    result.fail_reason = `${err}`;
    if (page && !options.dryRun) {
      try {
        await shoot(page, screenshot);
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