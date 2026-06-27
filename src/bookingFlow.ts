// src/bookingFlow.ts
// Per-account booking flow with retry-with-fallback loop + parallel court discovery.
//
// Performance: 6 badminton courts are queried in PARALLEL via fetch() in the page
// context (~500ms) instead of sequentially via selectOption + AJAX wait (~2.7s).
// This drops per-account cost from ~2.7s to ~1s for the all-empty path.
//
// Flow:
//   1. Login (fresh BrowserContext per call — BR-01/02)
//   2. Parallel-fetch reserved times for all 6 badminton courts in one page.evaluate
//      (must include `date` — server returns [] without it, see fetchAllReservedTimes)
//   3. Use parallel fetch as a BINARY HINT — which courts *might* have available slots
//   4. Iterate priority queue: assigned court → fallback → other badminton
//   5. For each "maybe-available" court: re-select court to refresh #time dropdown,
//      READ the dropdown (source of truth), then submit slot
//   6. Bail out on success / "already booked today" / 30s deadline
//
// Source of truth: the page's #time dropdown after selectOption(court). It applies
// time-of-day / date filters the parallel fetch can't see. We use the dropdown for
// the actual slot list, parallel fetch only for "skip fully-booked courts fast".
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
  slot: string;  // e.g. "17:00_18:00"
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
}

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';
const BOOKING_URL = 'https://susport.sc.su.ac.th/booking.php';
const RESERVED_TIMES_PATH = 'get_reserved_times';
const DEFAULT_SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'screenshots');
const DEFAULT_RETRY_DEADLINE_MS = 30_000;
const FALLBACK_COURT = 'แบดมินตัน4';

// All slot values available on the booking system (per discoverSlots finding).
// Used to compute "available = ALL_SLOTS − reserved".
const ALL_SLOTS = [
  '17:00_18:00',
  '18:00_19:00',
  '19:00_20:00',
  '20:00_21:00',
  '21:00_22:00',
];

// Heuristic text indicators. These are brittle — if the site copy changes,
// update here. Failure indicators also catch the "court full" rejection.
const ALREADY_BOOKED_INDICATORS = [
  'ได้จองสนามวันนี้แล้ว',
  'จองแล้ว',
  'already booked',
];
const SUCCESS_INDICATORS = ['สำเร็จ', 'จองเรียบร้อย', 'success', 'เรียบร้อย', 'ยืนยัน'];
const FAILURE_INDICATORS = ['ล้มเหลว', 'ผิดพลาด', 'ไม่สำเร็จ', 'error', 'เต็ม', 'ซ้ำ'];

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
async function getBadmintonCourts(page: Page): Promise<CourtInfo[]> {
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
async function fetchAllReservedTimes(
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
 * Select the court in the page's #court dropdown and read the actual #time options.
 * This is the SOURCE OF TRUTH for which slots are currently bookable — the page's
 * onchange handler applies time-of-day / date / session filters that the parallel
 * fetch doesn't see.
 *
 * Returns array of slot values (e.g. ['17:00_18:00', '18:00_19:00']). Empty array
 * means no slots are bookable for this court right now.
 */
async function getDropdownSlots(page: Page, court: CourtInfo): Promise<string[]> {
  await page.locator('#court').selectOption(court.value);
  await waitForSlotDropdown(page);
  return await page.locator('#time').evaluate((el) => {
    const sel = el as HTMLSelectElement;
    return Array.from(sel.options)
      .map((o) => o.value)
      .filter((v) => v !== '');
  });
}

/**
 * Attempt to submit a booking for the currently-selected court and the given slot.
 * Court must already be selected (so #time dropdown is populated).
 */
async function attemptSubmitBooking(page: Page, slot: string): Promise<AttemptOutcome> {
  await page.locator('#time').selectOption(slot);
  const submitBtn = page
    .locator('button:has-text("จอง"), input[type="submit"][value*="จอง" i]')
    .first();

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null),
    submitBtn.click({ timeout: 5000 }),
  ]);

  const bodyText = (await page.locator('body').textContent()) ?? '';

  if (ALREADY_BOOKED_INDICATORS.some((s) => bodyText.includes(s))) {
    return { type: 'already-booked' };
  }

  const hasSuccess = SUCCESS_INDICATORS.some((s) => bodyText.includes(s));
  const hasFailure = FAILURE_INDICATORS.some((s) => bodyText.includes(s));

  if (hasFailure && !hasSuccess) {
    return {
      type: 'submit-fail',
      reason: bodyText.replace(/\s+/g, ' ').trim().slice(0, 200),
    };
  }
  if (hasSuccess) {
    return { type: 'success' };
  }

  return {
    type: 'submit-fail',
    reason: `submit result unclear (url=${page.url()})`,
  };
}

/**
 * Re-select the court to ensure #time dropdown is populated, then submit the slot.
 * Used after the parallel-fetch phase (where the #time dropdown state is unknown).
 */
async function selectCourtAndSubmit(
  page: Page,
  court: CourtInfo,
  slot: string
): Promise<AttemptOutcome> {
  const slotsReady = waitForSlotDropdown(page);
  await page.locator('#court').selectOption(court.value);
  await slotsReady;
  return attemptSubmitBooking(page, slot);
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
function prioritizeCourts(assigned: string, available: CourtInfo[]): CourtInfo[] {
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

  try {
    // ---- Fresh context (BR-01/02) ----
    if (!browser) {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      ownBrowser = true;
    }
    context = await browser.newContext({ storageState: undefined });
    page = await context.newPage();

    // ---- Login ----
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('input[name="username"]').fill(account.username);
    await page.locator('input[name="password"]').fill(account.password);
    await page.locator('input[type="submit"]').click();
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);

    if (!page.url().includes('booking.php')) {
      result.status = 'FAIL';
      result.fail_reason = `login failed (landed on ${page.url()})`;
      if (!options.dryRun) await shoot(page, screenshot);
      return result;
    }

    // ---- Parallel discovery: query all 6 courts in one round-trip ----
    // This is used as a BINARY HINT only — which courts might have any open slot.
    // The actual slot list comes from the #time dropdown (source of truth) because
    // the page applies time-of-day / session filters the parallel fetch can't see.
    const allBadmintonCourts = await getBadmintonCourts(page);
    const courtValues = allBadmintonCourts.map((c) => c.value);
    const reservedByValue = await fetchAllReservedTimes(page, courtValues);

    const maybeAvailable = new Set<string>();
    for (const court of allBadmintonCourts) {
      const reserved = reservedByValue.get(court.value) ?? [];
      if (ALL_SLOTS.some((s) => !reserved.includes(s))) {
        maybeAvailable.add(court.value);
      }
    }

    // ---- Retry-with-fallback loop ----
    const deadline = Date.now() + deadlineMs;
    const courtsToTry = prioritizeCourts(account.court, allBadmintonCourts);

    let booked: { court: string; slot: string } | null = null;
    let earlyExit: 'already-booked' | null = null;
    // Track which courts we've read the dropdown for (source-of-truth check)
    let dropdownRead = false;

    outer: for (const court of courtsToTry) {
      if (Date.now() >= deadline) break;

      // Fast skip: parallel fetch said this court has NO open slots.
      if (!maybeAvailable.has(court.value)) {
        result.attempts.push({ court: court.label, slot: '-', outcome: 'no-slots-on-court' });
        continue;
      }

      // Source of truth: read #time dropdown after selectOption(court).
      // This catches cases where parallel fetch is stale / filtered differently.
      await resetToBookingPage(page);
      const available = await getDropdownSlots(page, court);
      dropdownRead = true;

      if (available.length === 0) {
        result.attempts.push({ court: court.label, slot: '-', outcome: 'no-slots-on-court' });
        continue;
      }

      // Slot priority: assigned first, then any other available
      const slotOrder = [account.slot, ...available.filter((s) => s !== account.slot)];

      for (const slot of slotOrder) {
        if (Date.now() >= deadline) break;
        if (!available.includes(slot)) continue;

        if (options.dryRun) {
          result.attempts.push({ court: court.label, slot, outcome: 'dry-run-would-book' });
          booked = { court: court.label, slot };
          break outer;
        }

        // Real path: re-select court (so #time dropdown populates for this court),
        // then submit slot. After submit, server may redirect — resetToBookingPage
        // handles that on next iteration if needed.
        await resetToBookingPage(page);
        const outcome = await selectCourtAndSubmit(page, court, slot);
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
          outcome: outcome.type === 'slot-not-available' ? 'slot-not-available' : 'submit-fail',
          reason: outcome.type === 'submit-fail' ? outcome.reason : undefined,
        });
        // slot-not-available or submit-fail — try next slot/court
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
      .filter((c) => !maybeAvailable.has(c.value))
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