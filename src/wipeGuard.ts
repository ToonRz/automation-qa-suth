// src/wipeGuard.ts
// Post-noon wipe guard (2026-10-01).
//
// What the site does: susport deletes EVERY row of today's reservations list
// that was inserted before about 12:00:02 local — every user's, not only ours —
// and keeps the rows inserted after that. Seen on 2026-09-28, 09-30 and 10-01
// (the cut fell between +1.97s and +2.35s; the local clock was within ~70ms of
// NTP and the server within ~0.2s of local, so this is not clock skew). The
// first wave got success answers at 12:00:00.3–2.0 and was reported PASS, then
// those rows vanished: 14–15 "PASS" a day, 1–7 real bookings. Only accounts
// whose POST sat in the server's queue past the cut kept a booking.
//
// What the guard does: from FIRE+1s it reads reservations.php — the global list
// (ชื่อผู้ใช้ / สนาม / เวลา / ลำดับการจอง) — through the accounts' own logged-in
// pages, publishes each snapshot, and flags the wipe when most rows seen in the
// previous snapshot are gone at once. bookingFlow's holdForWipe waits on these
// snapshots after an account's first-wave result: when the account's row is
// missing it books again (first free court in its rotation over the courts that
// still work), and its final status comes from the list as it stands at the end
// of the hold window — PASS only if its own row is there.
//
// Nothing here runs before the first-wave submits are in flight (SC-04): the
// guard is built before the tick and its first poll fires at FIRE+1s.
// WIPE_GUARD=0 turns it off (the pre-2026-10-01 behavior).

import type { Page } from 'playwright';
import { getCourtId } from './courtIdCache';

/** First poll this long after FIRE — the first wave is answered by then and
 *  the cut has never come earlier than +1.97s. */
const WATCH_START_MS = 1_000;
/** Default hold window: every account keeps watching (and re-booking if its
 *  row disappears) until FIRE + this. ~4x the latest cut seen so far. */
const DEFAULT_HOLD_MS = 10_000;
const FAST_POLL_MS = 150;
const SLOW_POLL_MS = 1_000;
/** Poll fast until this long after the wipe was seen (re-books need fresh
 *  lists), or until FIRE + NO_WIPE_SLOW_AFTER_MS when no wipe has shown up. */
const FAST_AFTER_WIPE_MS = 2_000;
const NO_WIPE_SLOW_AFTER_MS = 5_000;
/** Two polls in flight at most: each one is a full reservations.php render on
 *  a server that is at its busiest. */
const MAX_IN_FLIGHT = 2;
const SNAPSHOT_FETCH_TIMEOUT_MS = 5_000;
/** A wipe = at least this many rows of the previous snapshot gone at once… */
const WIPE_MIN_VANISHED = 3;
/** …and at least this share of them. A single deleted row (a duplicate being
 *  resolved, a cancellation) is not a wipe. */
const WIPE_MIN_SHARE = 0.5;
/** A court is skipped by re-books after this many DB errors with no booking on
 *  it today — while some other court does work (so a site-wide error can never
 *  mark every court dead). */
const COURT_DEAD_MIN_ERRORS = 2;

const RESERVATION_PAGE_HEADER = 'การจองสนามในวันที่';
const DB_ERROR_MARKER = 'เกิดข้อผิดพลาดในการบันทึกข้อมูล';
const RACE_LOSS_MARKERS = ['มีคนยืนยันการจอง', 'มีผู้จอง'];

/** WIPE_GUARD=0 disables the guard (kill-switch). */
export function wipeGuardEnabled(): boolean {
  return process.env.WIPE_GUARD !== '0';
}

/** Hold window after FIRE, from WIPE_HOLD_SEC (default 10). */
export function wipeHoldMs(): number {
  const sec = Number(process.env.WIPE_HOLD_SEC);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_HOLD_MS;
}

export interface ReservationRow {
  user: string;
  court: string;
  slot: string;
  /** ลำดับการจอง (booking number); '' if the column is missing. */
  no: string;
}

export interface ReservationSnapshot {
  /** When the request left — every write answered before this is reflected. */
  issuedAt: number;
  receivedAt: number;
  rows: ReservationRow[];
}

export type AttemptKind = 'success' | 'race-loss' | 'db-error' | 'other';

/** How a failed submit reads: the server's DB error, a lost race, or neither. */
export function failKind(reason: string | undefined): AttemptKind {
  if (!reason) return 'other';
  if (reason.includes(DB_ERROR_MARKER)) return 'db-error';
  if (RACE_LOSS_MARKERS.some((m) => reason.includes(m))) return 'race-loss';
  return 'other';
}

/**
 * Read today's reservations list through `page`'s session (in-page fetch, the
 * page does not navigate). Returns null unless the answer is the reservations
 * page AND has the bookings table (a header row labelled ชื่อผู้ใช้ and สนาม):
 * a login redirect, an error page or a layout change must never look like an
 * empty list — an empty list makes every account re-book.
 */
export async function fetchReservationSnapshot(
  page: Page,
  timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS
): Promise<ReservationSnapshot | null> {
  const issuedAt = Date.now();
  try {
    const res = await page.evaluate(
      async ({ timeoutMs: ms, header }) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try {
          const r = await fetch('reservations.php', {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: ctrl.signal,
          });
          const text = await r.text();
          if (!r.ok || !text.includes(header)) return null;
          const doc = new DOMParser().parseFromString(text, 'text/html');
          const cellTexts = (tr: Element): string[] =>
            Array.from(tr.querySelectorAll('th, td')).map((c) => (c.textContent ?? '').trim());
          for (const table of Array.from(doc.querySelectorAll('table'))) {
            const trs = Array.from(table.querySelectorAll('tr'));
            // The header row is found by its labels, <th> or plain <td> alike —
            // the live markup has never been captured, only screenshots.
            const headRow = trs.find((tr) => {
              const t = cellTexts(tr);
              return t.includes('ชื่อผู้ใช้') && t.includes('สนาม');
            });
            if (!headRow) continue;
            const heads = cellTexts(headRow);
            const userCol = heads.indexOf('ชื่อผู้ใช้');
            const courtCol = heads.indexOf('สนาม');
            const slotCol = heads.indexOf('เวลา');
            const noCol = heads.indexOf('ลำดับการจอง');
            const rows: { user: string; court: string; slot: string; no: string }[] = [];
            for (const tr of trs) {
              if (tr === headRow) continue;
              const cells = cellTexts(tr);
              if (cells.length <= Math.max(userCol, courtCol)) continue;
              rows.push({
                user: cells[userCol],
                court: cells[courtCol],
                slot: slotCol >= 0 ? cells[slotCol] ?? '' : '',
                no: noCol >= 0 ? cells[noCol] ?? '' : '',
              });
            }
            return rows;
          }
          return null; // reservations page without the bookings table
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      },
      { timeoutMs, header: RESERVATION_PAGE_HEADER }
    );
    return res ? { issuedAt, receivedAt: Date.now(), rows: res } : null;
  } catch {
    return null; // page closed / navigating
  }
}

export interface GuardMember {
  username: string;
  slot: string;
  /** Position in its same-slot group (bookingEngine computeSlotRotations). */
  rotation: number;
}

export interface GuardCourt {
  label: string;
  value: string;
}

interface PollPage {
  page: Page;
  busy: boolean;
  lastPolledAt: number;
}

const rowKey = (r: ReservationRow): string => `${r.user}|${r.court}|${r.slot}|${r.no}`;

function rotate<T>(list: T[], k: number): T[] {
  const n = list.length;
  if (n === 0) return [];
  const r = ((k % n) + n) % n;
  return [...list.slice(r), ...list.slice(0, r)];
}

/**
 * One per noon batch. Accounts register their page when their first wave is
 * over; the guard polls through those pages (never one that is mid-submit) and
 * hands snapshots to the waiting accounts. Stops at FIRE + hold, or on stop().
 */
export class WipeGuard {
  readonly fireAt: number;
  readonly deadline: number;
  /** issuedAt of the first snapshot that showed the wipe; null = not seen. */
  wipeAt: number | null = null;
  latest: ReservationSnapshot | null = null;

  private readonly courtOrder: string[];
  private readonly members = new Map<string, GuardMember>();
  private readonly pages = new Map<string, PollPage>();
  private waiters: { after: number; resolve: (s: ReservationSnapshot | null) => void }[] = [];
  private readonly courtStats = new Map<string, { success: number; dbError: number }>();
  /** Courts that held a row in any snapshot — someone could book them today. */
  private readonly courtsWithRows = new Set<string>();
  private inFlight = 0;
  private polls = 0;
  private unreadable = 0;
  /** Sum of answered polls' round-trips — re-book speed hinges on it. */
  private pollMsTotal = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly deadlineTimer: NodeJS.Timeout;

  constructor(opts: {
    fireAt: number;
    courtOrder: string[];
    members: GuardMember[];
    holdMs?: number;
  }) {
    this.fireAt = opts.fireAt;
    this.deadline = opts.fireAt + (opts.holdMs ?? wipeHoldMs());
    this.courtOrder = opts.courtOrder;
    for (const m of opts.members) this.members.set(m.username, m);
    this.schedule(Math.max(0, opts.fireAt + WATCH_START_MS - Date.now()));
    this.deadlineTimer = setTimeout(
      () => this.stop('hold window over'),
      Math.max(0, this.deadline - Date.now())
    );
    this.deadlineTimer.unref?.();
  }

  /** ms since FIRE, for log lines. */
  since(t: number = Date.now()): number {
    return t - this.fireAt;
  }

  /** Lend `page` (logged in, first wave over) to the poller. */
  register(username: string, page: Page): void {
    this.pages.set(username, { page, busy: false, lastPolledAt: 0 });
  }

  /** While busy the page is never polled — its own submit goes first. */
  setBusy(username: string, busy: boolean): void {
    const p = this.pages.get(username);
    if (p) p.busy = busy;
  }

  /** The account is finished; its page may close any moment. */
  release(username: string): void {
    this.pages.delete(username);
  }

  /** Record a submit outcome on `label` (dead-court detection). */
  noteAttempt(label: string, kind: AttemptKind): void {
    if (kind !== 'success' && kind !== 'db-error') return;
    const s = this.courtStats.get(label) ?? { success: 0, dbError: 0 };
    if (kind === 'success') s.success += 1;
    else s.dbError += 1;
    this.courtStats.set(label, s);
  }

  /** Keeps answering the site's DB error, nobody holds a row on it today,
   *  and some other court does work. */
  isCourtDead(label: string): boolean {
    const s = this.courtStats.get(label);
    if (!s || s.dbError < COURT_DEAD_MIN_ERRORS || s.success > 0) return false;
    if (this.courtsWithRows.has(label)) return false;
    const otherWorks =
      [...this.courtsWithRows].some((l) => l !== label) ||
      [...this.courtStats].some(([l, st]) => l !== label && st.success > 0);
    return otherWorks;
  }

  /**
   * Courts to try for `username`'s slot against `snap`, best first: the
   * working courts (cached id, not dead) in COURT_PRIORITY order, rotated by
   * the account's same-slot position so siblings start on different courts
   * (rotating the WORKING list, not the full one, keeps them apart when some
   * courts are down), minus the courts where the slot is already taken.
   */
  candidatesFor(username: string, snap: ReservationSnapshot): GuardCourt[] {
    const m = this.members.get(username);
    if (!m) return [];
    const working = this.courtOrder.filter(
      (label) => getCourtId(label) !== undefined && !this.isCourtDead(label)
    );
    const taken = new Set(snap.rows.filter((r) => r.slot === m.slot).map((r) => r.court));
    return rotate(working, m.rotation)
      .filter((label) => !taken.has(label))
      .map((label) => ({ label, value: getCourtId(label)! }));
  }

  /** The newest snapshot issued after `after`, if there is one. */
  latestAfter(after: number): ReservationSnapshot | null {
    return this.latest && this.latest.issuedAt > after ? this.latest : null;
  }

  /** Next snapshot issued after `after`; null once the hold window is over. */
  nextSnapshot(after: number): Promise<ReservationSnapshot | null> {
    const ready = this.latestAfter(after);
    if (ready) return Promise.resolve(ready);
    if (this.stopped) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ after, resolve }));
  }

  /** Stop polling and wake every waiter with null. Idempotent. */
  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    clearTimeout(this.deadlineTimer);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve(null);
    if (this.polls > 0) {
      const answered = this.polls - this.unreadable;
      const avg = answered > 0 ? Math.round(this.pollMsTotal / answered) : 0;
      console.log(
        `[wipe] watch end (${reason}) at +${this.since()}ms: polls=${this.polls} ` +
          `unreadable=${this.unreadable} wipe=${this.wipeAt === null ? 'none' : `+${this.since(this.wipeAt)}ms`} ` +
          `list avg=${avg}ms`
      );
    }
  }

  // ---- poller ----

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), ms);
    this.timer.unref?.();
  }

  private interval(): number {
    const now = Date.now();
    const fast =
      this.wipeAt === null
        ? now < this.fireAt + NO_WIPE_SLOW_AFTER_MS
        : now < this.wipeAt + FAST_AFTER_WIPE_MS;
    return fast ? FAST_POLL_MS : SLOW_POLL_MS;
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped) return;
    if (this.inFlight < MAX_IN_FLIGHT) {
      const pick = this.pickPage();
      if (pick) void this.poll(pick);
    }
    this.schedule(this.interval());
  }

  /** The idle registered page polled longest ago. */
  private pickPage(): PollPage | null {
    let best: PollPage | null = null;
    for (const p of this.pages.values()) {
      if (p.busy || p.page.isClosed()) continue;
      if (!best || p.lastPolledAt < best.lastPolledAt) best = p;
    }
    return best;
  }

  private async poll(p: PollPage): Promise<void> {
    if (this.polls === 0) {
      console.log(
        `[wipe] watching reservations.php from +${this.since()}ms ` +
          `(hold until +${this.since(this.deadline)}ms)`
      );
    }
    this.polls += 1;
    this.inFlight += 1;
    p.lastPolledAt = Date.now();
    const snap = await fetchReservationSnapshot(p.page);
    this.inFlight -= 1;
    if (this.stopped) return;
    if (!snap) {
      this.unreadable += 1;
      return;
    }
    this.pollMsTotal += snap.receivedAt - snap.issuedAt;
    this.publish(snap);
  }

  private publish(snap: ReservationSnapshot): void {
    const prev = this.latest;
    if (prev && snap.issuedAt <= prev.issuedAt) return; // overtaken by a newer poll
    this.latest = snap;
    for (const r of snap.rows) this.courtsWithRows.add(r.court);

    if (prev) {
      const now = new Set(snap.rows.map(rowKey));
      const vanished = prev.rows.filter((r) => !now.has(rowKey(r)));
      if (vanished.length > 0) {
        const ours = vanished.filter((r) => this.members.has(r.user)).map((r) => r.user);
        const nums = vanished.map((r) => Number(r.no)).filter((n) => Number.isFinite(n) && n > 0);
        const range = nums.length ? ` (#${Math.min(...nums)}–#${Math.max(...nums)})` : '';
        const isWipe =
          vanished.length >= WIPE_MIN_VANISHED && vanished.length >= prev.rows.length * WIPE_MIN_SHARE;
        if (isWipe && this.wipeAt === null) this.wipeAt = snap.issuedAt;
        console.log(
          `[wipe] ${isWipe ? 'WIPE detected' : 'rows vanished'} at +${this.since(snap.issuedAt)}ms: ` +
            `${vanished.length} of ${prev.rows.length} row(s) gone${range}, ${snap.rows.length} left` +
            (ours.length ? `; ours: ${ours.join(', ')}` : '') +
            ` (list answered in ${snap.receivedAt - snap.issuedAt}ms)`
        );
      }
    }

    const ready = this.waiters.filter((w) => snap.issuedAt > w.after);
    this.waiters = this.waiters.filter((w) => snap.issuedAt <= w.after);
    for (const w of ready) w.resolve(snap);
  }
}
