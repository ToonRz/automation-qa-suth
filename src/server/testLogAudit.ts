// src/server/testLogAudit.ts
//
// Mock-server harness for the 2026-09-28 log-audit fixes
// (doc/fix-plan-2026-09-28-log-audit.md — tasks C, D, A, B, E, F) and the
// 2026-10-01 post-noon wipe guard (scenarios w-*, src/wipeGuard.ts).
//
// The mock keeps ONE global reservations list like the live site (every user
// sees every row; one row per (court, slot) and per user) and can wipe it,
// add outsiders' rows, delay or hold answers, and fail chosen courts with the
// site's DB error.
//
// Drives the REAL engine and a REAL headless Chrome against a node:http mock
// of susport. Every context the engine opens gets a route that forwards
// https://susport.sc.su.ac.th/** to the mock, which can answer, reset, or hang
// any endpoint. Nothing reaches the live site or Telegram:
//   - sendTelegramMessage / getOwner are replaced in-process (fake owner),
//   - TELEGRAM_BOT_TOKEN is deleted (the heads-up DM returns early),
//   - COURT_IDS_PATH / SCREENSHOTS_DIR / REPORTS_DIR / RUN_STATE_PATH point
//     into a temp dir, so production cache/report/state files are untouched.
// Every username is fake.
//
// Run:  npm run test:log-audit                    (every scenario, in order)
//       npm run test:log-audit -- c-late a-budget (a subset, by name)

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Browser, BrowserContext, LaunchOptions, Page, Route } from 'playwright';
import type { Account, BookingResult } from '../bookingFlow';

// ---- isolation: must happen before any project module is required ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'log-audit-'));
process.env.COURT_IDS_PATH = path.join(TMP, 'court-ids.json');
process.env.SCREENSHOTS_DIR = path.join(TMP, 'screenshots');
process.env.REPORTS_DIR = path.join(TMP, 'reports');
process.env.RUN_STATE_PATH = path.join(TMP, 'run-state.json');
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.SUBMIT_VIA; // fetch mode — the production default

/* eslint-disable @typescript-eslint/no-var-requires */
const playwright = require('playwright') as typeof import('playwright');
const telegramSend = require('./telegramSend') as typeof import('./telegramSend');
const userStore = require('./userStore') as typeof import('./userStore');
const engine = require('./bookingEngine') as typeof import('./bookingEngine');
const runReport = require('./runReport') as typeof import('./runReport');
let runState = require('./runState') as typeof import('./runState');
const botLog = require('./botLog') as typeof import('./botLog');
/* eslint-enable @typescript-eslint/no-var-requires */

const SITE = 'https://susport.sc.su.ac.th';
const COURT_IDS: Record<string, string> = {
  'แบดมินตัน1': '101',
  'แบดมินตัน2': '102',
  'แบดมินตัน3': '103',
  'แบดมินตัน4': '104',
  'แบดมินตัน5': '105',
  'แบดมินตัน6': '106',
};
const SLOTS = ['16:30_17:30', '17:30_18:30', '18:30_19:30', '19:30_20:30', '20:30_21:30', '21:30_22:30'];
const FAKE_OWNER = { chat_id: 1, telegram_id: 1, display_name: 'mock-owner', role: 'owner', accounts: [] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockAccounts(n: number, slot = '18:30_19:30'): Account[] {
  return Array.from({ length: n }, (_, i) => ({
    username: `mock-u${i + 1}`,
    password: 'mock-pw',
    slot,
  }));
}

// ---------------------------------------------------------------- mock site

type PostMode = 'ok' | 'hang' | 'hang-books';

interface MockPlan {
  login: 'ok' | 'hang' | 'reset';
  reservedTimes: 'ok' | 'hang';
  reservations: 'ok' | 'hang';
  /** Outcome of a user's n-th (0-based) book_court.php POST. 'hang-books'
   *  records the booking server-side and then never answers. */
  bookPost: (user: string, n: number) => PostMode;
  /** Server queue: ms between a POST arriving and the booking being decided.
   *  The row is inserted at the END of the wait, as on the real site, whose
   *  noon POSTs sat 0.3–4s in its queue. */
  postDelayMs: (user: string, n: number) => number;
  /** ms between the decision (row already inserted) and the answer. */
  respondDelayMs: (user: string, n: number) => number;
  /** Courts whose every booking fails with the site's DB error
   *  (แบดมินตัน1/2 on 2026-10-01). */
  courtErrors: Set<string>;
  /** A site that still counts WIPED rows for its one-booking-per-day rule. */
  countsWipedRows: boolean;
  /** Render the reservations header with <td> instead of <th> (the live
   *  markup has only been seen in screenshots). */
  tdHeader: boolean;
}

interface MockRequest {
  at: number;
  method: string;
  path: string;
  user: string;
  body: string;
}

/** One row of the site's global reservations list. */
interface MockRow {
  user: string;
  court: string;
  slot: string;
  no: number;
  at: number;
}

// The site's own alert() copy (dialogs captured live; already-booked is a guess
// that matches ALREADY_BOOKED_INDICATORS — the live site has never shown it).
const RACE_LOSS_ALERT =
  'เสียใจด้วยครับ มีคนยืนยันการจองสนามนี้ในเวลาเดียวกันไปก่อนหน้าคุณแล้ว (ระบบให้สิทธิ์ผู้ที่ยืนยันก่อน)';
const DB_ERROR_ALERT = 'เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้ง';
const ALREADY_BOOKED_ALERT = 'คุณได้จองสนามวันนี้แล้ว';

function courtLabelOf(courtId: string): string {
  return Object.keys(COURT_IDS).find((k) => COURT_IDS[k] === courtId) ?? `id-${courtId}`;
}

class MockSusport {
  plan: MockPlan = {
    login: 'ok',
    reservedTimes: 'ok',
    reservations: 'ok',
    bookPost: () => 'ok',
    postDelayMs: () => 0,
    respondDelayMs: () => 0,
    courtErrors: new Set(),
    countsWipedRows: false,
    tdHeader: false,
  };
  requests: MockRequest[] = [];
  /** Today's global list — what reservations.php shows to every user, as the
   *  live site does. One row per (court, slot) and per user. */
  rows: MockRow[] = [];
  /** Every row ever inserted; a wipe does not touch this. */
  inserted: MockRow[] = [];
  /** When each wipe() ran. */
  wipes: number[] = [];
  frozen = false;
  private wipedUsers = new Set<string>();
  private nextNo = 1;
  private timers: NodeJS.Timeout[] = [];
  private held: Array<() => void> = [];
  private posts = new Map<string, number>();
  private server = http.createServer((req, res) => this.onRequest(req, res));
  port = 0;

  rowOf(user: string): MockRow | undefined {
    return this.rows.find((r) => r.user === user);
  }

  /** The post-noon wipe: every row goes, booking numbers keep counting. */
  wipe(): void {
    for (const r of this.rows) this.wipedUsers.add(r.user);
    this.rows = [];
    this.wipes.push(Date.now());
  }

  /** Run `fn` at wall-clock `atMs` (cancelled by stop()). */
  at(atMs: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, Math.max(0, atMs - Date.now())));
  }

  /** Someone who is not one of our accounts books (court, slot), if free. */
  outsider(user: string, court: string, slot: string): boolean {
    return this.decide(user, court, slot) === 'ok';
  }

  /** The site's booking decision; inserts the row on 'ok'. */
  private decide(user: string, court: string, slot: string): 'ok' | 'race' | 'already' | 'db-error' {
    if (this.plan.courtErrors.has(court)) return 'db-error';
    if (this.rows.some((r) => r.user === user)) return 'already';
    if (this.plan.countsWipedRows && this.wipedUsers.has(user)) return 'already';
    if (this.rows.some((r) => r.court === court && r.slot === slot)) return 'race';
    const row: MockRow = { user, court, slot, no: this.nextNo++, at: Date.now() };
    this.rows.push(row);
    this.inserted.push(row);
    return 'ok';
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Stop answering anything (HTTP) — pages are frozen separately. */
  freeze(): void {
    this.frozen = true;
  }

  /** Answer everything that was held, and everything from now on. */
  release(): void {
    this.frozen = false;
    const held = this.held;
    this.held = [];
    for (const answer of held) answer();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const user = String(req.headers['x-mock-user'] ?? '');
      const p = new URL(req.url ?? '/', 'http://mock').pathname;
      this.requests.push({ at: Date.now(), method: req.method ?? 'GET', path: p, user, body });
      const answer = (): void => this.answer(req.method ?? 'GET', p, user, body, res);
      if (this.frozen) this.held.push(answer);
      else answer();
    });
  }

  private answer(
    method: string,
    p: string,
    user: string,
    body: string,
    res: http.ServerResponse
  ): void {
    const send = (status: number, type: string, text: string): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(text);
    };
    const html = (text: string): void => send(200, 'text/html; charset=utf-8', text);
    switch (p) {
      case '/login.php':
        if (this.plan.login === 'hang') return;
        if (this.plan.login === 'reset') {
          res.socket?.destroy();
          return;
        }
        return html(LOGIN_HTML);
      case '/booking.php':
        // GET = reload; POST = the login form submit (action="booking.php").
        return html(BOOKING_HTML);
      case '/get_reserved_times.php': {
        if (this.plan.reservedTimes === 'hang') return;
        const court = courtLabelOf(new URLSearchParams(body).get('court_id') ?? '');
        const reserved = this.rows.filter((r) => r.court === court).map((r) => r.slot);
        return send(200, 'application/json', JSON.stringify(reserved));
      }
      case '/book_court.php': {
        const n = this.posts.get(user) ?? 0;
        this.posts.set(user, n + 1);
        const mode = this.plan.bookPost(user, n);
        if (mode === 'hang') return;
        const params = new URLSearchParams(body);
        const court = courtLabelOf(params.get('court_id') ?? '');
        const slot = params.get('time_slot') ?? '';
        const decideAndAnswer = (): void => {
          const verdict = this.decide(user, court, slot);
          if (mode === 'hang-books') return;
          // Rendered at decision time, delivered after respondDelayMs: a
          // success page can reach us after the wipe already removed its row.
          const msg =
            verdict === 'race'
              ? RACE_LOSS_ALERT
              : verdict === 'already'
                ? ALREADY_BOOKED_ALERT
                : DB_ERROR_ALERT;
          const page =
            verdict === 'ok'
              ? this.reservationsHtml()
              : `<html><body><script>alert('${msg}'); location = 'booking.php';</script></body></html>`;
          const later = this.plan.respondDelayMs(user, n);
          if (later > 0) setTimeout(() => html(page), later);
          else html(page);
        };
        const queued = this.plan.postDelayMs(user, n);
        if (queued > 0) setTimeout(decideAndAnswer, queued);
        else decideAndAnswer();
        return;
      }
      case '/reservations.php':
        if (this.plan.reservations === 'hang' && method === 'GET') return;
        return html(this.reservationsHtml());
      default:
        return send(404, 'text/plain', 'not found');
    }
  }

  /** The live layout: one global table, sorted by court then booking number. */
  private reservationsHtml(): string {
    const rows = [...this.rows].sort((a, b) => a.court.localeCompare(b.court) || a.no - b.no);
    const c = this.plan.tdHeader ? 'td' : 'th';
    return (
      '<html><body><h2>การจองสนามในวันที่ 2026-09-28</h2>' +
      `<table><tr><${c}>ชื่อผู้ใช้</${c}><${c}>สนาม</${c}><${c}>เวลา</${c}><${c}>ลำดับการจอง</${c}></tr>` +
      rows
        .map((r) => `<tr><td>${r.user}</td><td>${r.court}</td><td>${r.slot}</td><td>${r.no}</td></tr>`)
        .join('') +
      '</table></body></html>'
    );
  }

  postsBy(user: string): MockRequest[] {
    return this.requests.filter((r) => r.user === user && r.path === '/book_court.php');
  }
}

const LOGIN_HTML =
  '<html><body><form method="post" action="booking.php">' +
  '<input name="username"><input name="password" type="password">' +
  '<input type="submit" value="เข้าสู่ระบบ"></form></body></html>';

const BOOKING_HTML =
  '<html><body><h3>ระเบียบการจองสนามกีฬา</h3>' +
  '<form method="post" action="book_court.php">' +
  '<select id="court" name="court_id"><option value="">เลือกสนาม</option>' +
  Object.entries(COURT_IDS)
    .map(([label, id]) => `<option value="${id}">${label}</option>`)
    .join('') +
  '</select><select id="time" name="time_slot"><option value="">เลือกเวลา</option></select>' +
  '<button type="submit" name="submit" value="1">จอง</button></form>' +
  `<script>
    const SLOTS = ${JSON.stringify(SLOTS)};
    document.getElementById('court').addEventListener('change', async function () {
      const t = document.getElementById('time');
      t.innerHTML = '<option value="">เลือกเวลา</option>';
      const r = await fetch('get_reserved_times.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'court_id=' + this.value + '&date=2026-09-28',
      });
      const reserved = await r.json();
      for (const s of SLOTS) if (!reserved.includes(s)) t.add(new Option(s, s));
    });
  </script></body></html>`;

// ------------------------------------------------------- harness / patches

interface CtxRecord {
  id: number;
  browser: number;
  createdAt: number;
  closeCalledAt: number | null;
  closeCalls: number;
  user: string | null;
}

interface LogLine {
  at: number;
  text: string;
}

class Harness {
  mock = new MockSusport();
  lines: LogLine[] = [];
  dms: { chatId: number; text: string; at: number }[] = [];
  launches: { idx: number; startedAt: number; doneAt: number }[] = [];
  contexts: CtxRecord[] = [];
  browsers: Browser[] = [];
  launchDelayMs = 0;
  launchFail = false;
  pagesFrozen = false;
  newContextFrozen = false;
  private heldPages: Array<() => void> = [];
  private heldContexts: Array<() => void> = [];

  contextGate(): Promise<void> {
    if (!this.newContextFrozen) return Promise.resolve();
    return new Promise((resolve) => this.heldContexts.push(resolve));
  }

  releaseContexts(): void {
    this.newContextFrozen = false;
    const held = this.heldContexts;
    this.heldContexts = [];
    for (const r of held) r();
  }

  freezeAll(): void {
    this.mock.freeze();
    this.pagesFrozen = true;
  }

  releaseAll(): void {
    this.releaseContexts();
    this.pagesFrozen = false;
    const held = this.heldPages;
    this.heldPages = [];
    for (const r of held) r();
    this.mock.release();
  }

  pageGate(): Promise<void> {
    if (!this.pagesFrozen) return Promise.resolve();
    return new Promise((resolve) => this.heldPages.push(resolve));
  }

  has(re: RegExp): boolean {
    return this.lines.some((l) => re.test(l.text));
  }

  find(re: RegExp): LogLine[] {
    return this.lines.filter((l) => re.test(l.text));
  }

  async waitFor(re: RegExp, timeoutMs: number): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.lines.find((l) => re.test(l.text));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for log ${re}`);
      await sleep(100);
    }
  }

  async shutdown(): Promise<void> {
    this.releaseAll();
    await sleep(1_500); // let detached cleanup log its [cleanup] lines
    await this.mock.stop();
    for (const b of this.browsers) await b.close().catch(() => {});
  }
}

let h: Harness;

// Console capture (the engine logs through console.*).
const rawWrite = process.stdout.write.bind(process.stdout);
for (const level of ['log', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]): void => {
    const text =
      (level === 'warn' ? '[WARN] ' : level === 'error' ? '[ERROR] ' : '') +
      args.map(String).join(' ');
    h?.lines.push({ at: Date.now(), text });
    rawWrite(`  ${new Date().toISOString().slice(11, 23)} ${text}\n`);
  };
}

// Telegram + owner: in-process fakes.
(telegramSend as { sendTelegramMessage: unknown }).sendTelegramMessage = async (
  chatId: number,
  text: string
): Promise<void> => {
  h.dms.push({ chatId, text, at: Date.now() });
};
(userStore as { getOwner: unknown }).getOwner = () => FAKE_OWNER;

// Chrome: real launch, optional injected delay, every context routed to the mock.
const realLaunch = playwright.chromium.launch.bind(playwright.chromium);
(playwright.chromium as { launch: unknown }).launch = async (
  options?: LaunchOptions
): Promise<Browser> => {
  const idx = h.launches.length;
  const rec = { idx, startedAt: Date.now(), doneAt: 0 };
  h.launches.push(rec);
  if (h.launchDelayMs > 0) await sleep(h.launchDelayMs);
  if (h.launchFail) throw new Error('mock chromium.launch failure');
  const browser = await realLaunch(options);
  rec.doneAt = Date.now();
  h.browsers.push(browser);
  wrapBrowser(browser, idx);
  return browser;
};

function wrapBrowser(browser: Browser, idx: number): void {
  const realNewContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    // A hung newContext: the context is requested now, the answer is late.
    const creating = realNewContext(options);
    await h.contextGate();
    const ctx = await creating;
    const rec: CtxRecord = {
      id: h.contexts.length,
      browser: idx,
      createdAt: Date.now(),
      closeCalledAt: null,
      closeCalls: 0,
      user: null,
    };
    h.contexts.push(rec);
    const realClose = ctx.close.bind(ctx);
    ctx.close = async (opts) => {
      rec.closeCalls += 1;
      if (rec.closeCalledAt === null) rec.closeCalledAt = Date.now();
      return realClose(opts);
    };
    // Fails only when the context is already gone (browser closed meanwhile).
    await ctx.route(`${SITE}/**`, (route) => forward(route, rec)).catch(() => {});
    const realNewPage = ctx.newPage.bind(ctx);
    ctx.newPage = async () => {
      const page = await realNewPage();
      gatePage(page);
      return page;
    };
    return ctx as BrowserContext;
  };
}

/** Freezable page: while frozen, the Playwright calls the booking path makes
 *  never return — the "Chrome stopped answering" state of 2026-09-11/15. */
function gatePage(page: Page): void {
  const p = page as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const m of ['evaluate', 'goto', 'screenshot', 'waitForURL', 'waitForLoadState']) {
    const real = p[m].bind(page);
    p[m] = async (...args: unknown[]) => {
      await h.pageGate();
      return real(...args);
    };
  }
}

async function forward(route: Route, rec: CtxRecord): Promise<void> {
  const req = route.request();
  const url = new URL(req.url());
  const body = req.postData() ?? '';
  if (req.method() === 'POST' && /(^|&)password=/.test(body)) {
    rec.user = new URLSearchParams(body).get('username');
  }
  const answer = await new Promise<{ status: number; type: string; body: Buffer } | null>(
    (resolve) => {
      const out = http.request(
        {
          host: '127.0.0.1',
          port: h.mock.port,
          method: req.method(),
          path: url.pathname + url.search,
          headers: {
            'content-type': req.headers()['content-type'] ?? 'text/plain',
            'x-mock-user': rec.user ?? '',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 500,
              type: String(res.headers['content-type'] ?? 'text/html'),
              body: Buffer.concat(chunks),
            })
          );
          res.on('error', () => resolve(null));
        }
      );
      out.on('error', () => resolve(null));
      out.end(body);
    }
  );
  if (!answer) {
    await route.abort().catch(() => {});
    return;
  }
  await route
    .fulfill({ status: answer.status, contentType: answer.type, body: answer.body })
    .catch(() => {});
}

// ------------------------------------------------------------ scenarios

type Scenario = { name: string; about: string; run: () => Promise<void> };

function collectSettled(): {
  settled: { index: number; result: BookingResult; at: number }[];
  onAccountSettled: (index: number, result: BookingResult) => void;
} {
  const settled: { index: number; result: BookingResult; at: number }[] = [];
  return {
    settled,
    onAccountSettled: (index, result) => settled.push({ index, result, at: Date.now() }),
  };
}

const OUTAGE_DM = /Prewarm ล้มทั้งหมด/;

/** The per-account fields requirements §7 demands in the report. */
const S7_FIELDS = [
  'username',
  'triggered_at',
  'court_attempted',
  'court_booked',
  'slot',
  'status',
  'fail_reason',
  'screenshot',
  'duration_ms',
];

/** Mirror of runScheduledBooking's wiring (bot.ts cannot be imported — it
 *  starts the Telegram bot on load): [result] line + reporter per settle. */
function botWiring(fireTime: Date, count: number) {
  const reporter = runReport.createRunReporter({ fireTime, mode: 'prewarm', count });
  const { settled, onAccountSettled: collect } = collectSettled();
  const onAccountSettled = (index: number, result: BookingResult): void => {
    console.log(runReport.formatResultLine(result));
    reporter.settle(index, result);
    collect(index, result);
  };
  return { reporter, settled, onAccountSettled };
}

function readReport(file: string | null): Record<string, unknown> & { accounts: BookingResult[] } {
  assert.ok(file, 'report path returned');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function assertS7(accounts: BookingResult[], n: number): void {
  assert.equal(accounts.length, n, `${n} accounts in the report`);
  for (const a of accounts) {
    for (const f of S7_FIELDS) assert.ok(f in a, `${a.username} has §7 field ${f}`);
  }
}

/** Invariants of a healthy run that the new bounds must never disturb. */
function assertUntouchedNormalRun(): void {
  const bad = h.lines.filter((l) =>
    /timeout|did not settle|result-late|round CUT|fresh browser/i.test(l.text)
  );
  assert.deepEqual(bad.map((l) => l.text), [], 'no timeout / late / CUT / fresh-browser lines');
  assert.equal(h.launches.length, 1, 'one browser launch');
}

/** Freeze pages + HTTP just before the tick; release `releaseAfterMs` after it. */
function freezeAroundTick(target: Date, releaseAfterMs: number): void {
  setTimeout(() => h.freezeAll(), target.getTime() - Date.now() - 300);
  setTimeout(() => h.releaseAll(), target.getTime() - Date.now() + releaseAfterMs);
}

/** When the mock site wipes its list after the tick — the live cut fell at
 *  +1.97s..+2.35s on 2026-09-28/30 and 10-01. */
const WIPE_AFTER_MS = 2_000;

function daysAgo(n: number): string {
  return runReport.bangkokDate(new Date(Date.now() - n * 86_400_000));
}

const scenarios: Scenario[] = [
  {
    name: 'c-late',
    about: 'C: T-4m already past when the batch starts + slow launch + every prewarm fails → 1 outage DM, after round 1',
    run: async () => {
      h.mock.plan.login = 'reset';
      h.launchDelayMs = 1_500;
      process.env.PREWARM_LEAD_SEC = '50';
      const target = new Date(Date.now() + 50_000);
      const { settled, onAccountSettled } = collectSettled();
      await engine.runPrewarmedBatch(mockAccounts(3), target, { onAccountSettled });

      const outage = h.dms.filter((d) => OUTAGE_DM.test(d.text));
      assert.equal(outage.length, 1, 'exactly one outage DM');
      const firstRound = h.find(/\[bookingEngine\] prewarm: /)[0];
      assert.ok(firstRound, 'first-round tally logged');
      assert.ok(outage[0].at >= firstRound.at, 'outage DM sent after the first round');
      assert.ok(h.has(/total outage at after first round/), 'post-round check fired');
      const launchLines = h.find(/\[perf\] browser launch=(\d+)ms/);
      assert.equal(launchLines.length, 1, 'one [perf] browser launch= line');
      const ms = Number(/launch=(\d+)ms/.exec(launchLines[0].text)?.[1]);
      assert.ok(ms >= 1_500, `launch time includes the injected delay (${ms}ms)`);
      assert.equal(settled.length, 3, 'every account settled');
    },
  },
  {
    name: 'c-timer',
    about: 'C: launch slower than T-4m (timer armed before launch) + every prewarm fails for 7 rounds → still exactly 1 outage DM',
    run: async () => {
      h.mock.plan.login = 'reset';
      h.launchDelayMs = 6_000;
      process.env.PREWARM_LEAD_SEC = '243';
      const target = new Date(Date.now() + 243_000);
      const { settled, onAccountSettled } = collectSettled();
      await engine.runPrewarmedBatch(mockAccounts(3), target, { onAccountSettled });

      const outage = h.dms.filter((d) => OUTAGE_DM.test(d.text));
      assert.equal(outage.length, 1, 'exactly one outage DM across every retry round');
      assert.ok(
        outage[0].at < h.launches[0].doneAt,
        'DM fired by the T-4m timer while the browser was still launching'
      );
      assert.ok(h.find(/prewarm retry for/).length >= 5, 'several retry rounds ran');
      assert.equal(h.find(/\[perf\] browser launch=/).length, 1, 'one [perf] browser launch= line');
      assert.equal(settled.length, 3, 'every account settled');
    },
  },
  {
    name: 'c-normal',
    about: 'C: healthy run → no outage DM, one [perf] browser launch= line, every account PASS',
    run: async () => {
      process.env.PREWARM_LEAD_SEC = '45';
      const target = new Date(Date.now() + 45_000);
      const { settled, onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(3), target, { onAccountSettled });

      assert.equal(h.dms.filter((d) => OUTAGE_DM.test(d.text)).length, 0, 'no outage DM');
      assert.equal(h.find(/\[perf\] browser launch=/).length, 1, 'one [perf] browser launch= line');
      assert.ok(h.has(/prewarm: 3 page-ready/), 'every account page-ready');
      assert.deepEqual(
        res.results.map((r) => r.status),
        ['PASS', 'PASS', 'PASS'],
        'every account PASS'
      );
      assert.equal(settled.length, 3);
      assertUntouchedNormalRun();
    },
  },
  {
    name: 'd-report',
    about: 'D: healthy run → bot-run-*.json with §7 fields, [result] per account, dated screenshots, 30-day retention',
    run: async () => {
      const reports = process.env.REPORTS_DIR!;
      const shots = process.env.SCREENSHOTS_DIR!;
      const old = daysAgo(31);
      const recent = daysAgo(29);
      const keep = [
        `bot-run-${recent}T05-00-00-000Z.json`,
        'run-2026-07-09T04-33-55-319Z.json',
        'slots-discovered.json',
      ];
      const drop = [`bot-run-${old}T05-00-00-000Z.json`, `bot-run-${old}T05-00-00-000Z.late.json`];
      fs.mkdirSync(reports, { recursive: true });
      for (const f of [...keep, ...drop]) fs.writeFileSync(path.join(reports, f), '{}');
      for (const d of [old, recent, 'not-a-date']) {
        fs.mkdirSync(path.join(shots, d), { recursive: true });
        fs.writeFileSync(path.join(shots, d, 'x.png'), '');
      }
      fs.writeFileSync(path.join(shots, 'legacy-root.png'), '');

      process.env.PREWARM_LEAD_SEC = '45';
      const target = new Date(Date.now() + 45_000);
      const { reporter, settled, onAccountSettled } = botWiring(target, 3);
      const dispatches: { skipped: boolean; drift_ms: number | null }[] = [];
      const res = await engine.runPrewarmedBatch(mockAccounts(3), target, {
        onAccountSettled,
        onDispatched: (info) => dispatches.push(info),
      });
      assert.equal(dispatches.length, 1, 'dispatch recorded once');
      assert.equal(dispatches[0].skipped, false);
      const report = readReport(reporter.write(res));

      assertS7(report.accounts, 3);
      assert.equal(settled.length, 3);
      assert.deepEqual(report.counts, { PASS: 3, FAIL: 0, ERROR: 0, 'DRY-RUN': 0 });
      assert.equal(report.mode, 'prewarm');
      assert.equal(report.fire_time, target.toISOString());
      assert.equal(typeof report.fired_at, 'string');
      assert.equal(typeof report.drift_ms, 'number');
      assert.equal(typeof report.total_ms, 'number');
      assert.deepEqual(report.prewarm, {
        page_ready: 3,
        login_ready: 0,
        needs_standard: 0,
        failed: 0,
        retry_rounds: 0,
      });
      const resultLines = h.find(/^\[result\] mock-u\d PASS court=แบดมินตัน\d slot=18:30_19:30 \d+ms reason=-$/);
      assert.equal(resultLines.length, 3, 'one [result] line per account');
      const day = runReport.bangkokDate(target);
      for (const a of report.accounts) {
        assert.equal(a.screenshot, path.join(shots, day, `${a.username}.png`), 'dated screenshot path');
        assert.ok(fs.existsSync(a.screenshot), `screenshot written for ${a.username}`);
      }
      assertUntouchedNormalRun();
      for (const f of keep) assert.ok(fs.existsSync(path.join(reports, f)), `kept ${f}`);
      for (const f of drop) assert.ok(!fs.existsSync(path.join(reports, f)), `removed ${f}`);
      assert.ok(!fs.existsSync(path.join(shots, old)), 'removed the 31-day-old screenshot folder');
      assert.ok(fs.existsSync(path.join(shots, recent)), 'kept the 29-day-old screenshot folder');
      assert.ok(fs.existsSync(path.join(shots, 'not-a-date')), 'kept a non-date folder');
      assert.ok(fs.existsSync(path.join(shots, 'legacy-root.png')), 'kept root-level screenshots');
    },
  },
  {
    name: 'd-skip',
    about: 'D: dispatch SKIPPED by the drift guard → report still written, every account FAIL missed-deadline with §7 fields',
    run: async () => {
      const target = new Date(Date.now() - 35_000);
      const { reporter, onAccountSettled } = botWiring(target, 3);
      const dispatches: { skipped: boolean }[] = [];
      const res = await engine.runPrewarmedBatch(mockAccounts(3), target, {
        onAccountSettled,
        suppressAlerts: true,
        onDispatched: (info) => dispatches.push(info),
      });
      assert.ok(h.has(/dispatch SKIPPED/), 'drift guard skipped the dispatch');
      assert.deepEqual(dispatches.map((d) => d.skipped), [true], 'SKIPPED counts as dispatched (E3)');
      const report = readReport(reporter.write(res));
      assertS7(report.accounts, 3);
      for (const a of report.accounts) {
        assert.equal(a.status, 'FAIL');
        assert.match(String(a.fail_reason), /^missed-deadline/);
      }
      assert.ok((report.drift_ms as number) > 30_000, 'drift recorded');
      assert.equal(h.find(/^\[result\] mock-u\d FAIL /).length, 3, '[result] line per skipped account');
    },
  },
  {
    name: 'd-throw',
    about: 'D: batch throws (launch failure) → report of what settled + error; unwritable reports dir → warn, no throw',
    run: async () => {
      h.launchFail = true;
      const target = new Date(Date.now() + 60_000);
      const { reporter, onAccountSettled } = botWiring(target, 3);
      let thrown: unknown;
      try {
        await engine.runPrewarmedBatch(mockAccounts(3), target, { onAccountSettled });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, 'engine threw');
      const report = readReport(reporter.write(undefined, thrown));
      assert.equal(report.accounts.length, 0);
      assert.match(String(report.error), /mock chromium\.launch failure/);

      const saved = process.env.REPORTS_DIR;
      const blocker = path.join(TMP, 'not-a-dir');
      fs.writeFileSync(blocker, '');
      process.env.REPORTS_DIR = path.join(blocker, 'reports');
      try {
        const bad = runReport.createRunReporter({ fireTime: target, mode: 'prewarm', count: 1 });
        assert.equal(bad.write(undefined, 'x'), null, 'write failure returns null');
        assert.ok(h.has(/\[WARN\] \[report\] write failed/), 'write failure is a warning');
      } finally {
        process.env.REPORTS_DIR = saved;
      }
    },
  },
  {
    name: 'a-post-hang',
    about: 'A: booking POST never answers → abort at 15s, reservations checked first; row found → no next court, no row → next attempt',
    run: async () => {
      h.mock.plan.bookPost = (user, n) =>
        n > 0 ? 'ok' : user === 'mock-u1' ? 'hang-books' : user === 'mock-u2' ? 'hang' : 'ok';
      process.env.PREWARM_LEAD_SEC = '45';
      const target = new Date(Date.now() + 45_000);
      const { settled, onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(2), target, { onAccountSettled });
      const byUser = new Map(res.results.map((r) => [r.username, r]));
      const reservationsGets = (user: string) =>
        h.mock.requests.filter((r) => r.user === user && r.path === '/reservations.php');

      // mock-u1: the server booked, the answer never came.
      const u1Posts = h.mock.postsBy('mock-u1');
      assert.equal(u1Posts.length, 1, 'mock-u1: no second POST after reservations showed the row');
      assert.equal(byUser.get('mock-u1')?.status, 'PASS', 'mock-u1: PASS via reservations.php');
      const u1Perf = h.find(
        /\[perf\] mock-u1 fetch_submit .*post=(\d+)ms status=- outcome=success \(submit timeout\)/
      );
      assert.equal(u1Perf.length, 1, 'mock-u1: submit timeout logged once');
      const u1Ms = Number(/post=(\d+)ms/.exec(u1Perf[0].text)?.[1]);
      assert.ok(u1Ms >= 15_000 && u1Ms < 16_500, `mock-u1: aborted at ~15s (${u1Ms}ms incl. check)`);
      const u1Check = reservationsGets('mock-u1')[0];
      assert.ok(
        u1Check && u1Check.at - u1Posts[0].at >= 14_900,
        'mock-u1: reservations checked after the abort'
      );

      // mock-u2: nothing booked — the check comes back empty, the next attempt follows.
      const u2Posts = h.mock.postsBy('mock-u2');
      assert.equal(u2Posts.length, 2, 'mock-u2: one retry after the empty check');
      const u2Check = reservationsGets('mock-u2')[0];
      assert.ok(
        u2Check && u2Check.at > u2Posts[0].at && u2Check.at < u2Posts[1].at,
        'mock-u2: reservations checked between the timed-out POST and the retry'
      );
      assert.equal(byUser.get('mock-u2')?.status, 'PASS');
      assert.equal(settled.length, 2);
    },
  },
  {
    name: 'a-budget',
    about: 'A: Chrome + site stop answering at the tick → every account ERROR timeout at 90s ±1s, settled at once, later [result-late] + .late.json',
    run: async () => {
      process.env.PREWARM_LEAD_SEC = '45';
      const target = new Date(Date.now() + 45_000);
      freezeAroundTick(target, 95_000);
      const { reporter, settled, onAccountSettled } = botWiring(target, 3);
      const res = await engine.runPrewarmedBatch(mockAccounts(3), target, {
        onAccountSettled,
        onAccountLate: (i, r) => reporter.late(i, r),
      });
      const firedAt = Date.parse(res.fired_at);
      assert.equal(settled.length, 3, 'each account settled exactly once');
      for (const st of settled) {
        assert.equal(st.result.status, 'ERROR');
        assert.equal(
          st.result.fail_reason,
          'timeout: ไม่จบภายใน 90s — ผลจริงไม่ทราบ ให้เช็ค reservations.php'
        );
        const after = st.at - firedAt;
        assert.ok(Math.abs(after - 90_000) <= 1_000, `${st.result.username} settled at +${after}ms`);
      }
      const file = reporter.write(res);
      assertS7(readReport(file).accounts, 3);

      for (const n of [1, 2, 3]) {
        await h.waitFor(new RegExp(`^\\[result-late\\] mock-u${n} PASS `), 20_000);
      }
      await h.waitFor(/\[report\] late results → /, 5_000);
      await sleep(500);
      const lateFile = file!.replace(/\.json$/, '.late.json');
      const lateReport = JSON.parse(fs.readFileSync(lateFile, 'utf-8')) as { late: BookingResult[] };
      assert.equal(lateReport.late.length, 3, '.late.json holds every late result');
      assert.equal(settled.length, 3, 'no second settle (no second DM) for late results');
    },
  },
  {
    name: 'a-newcontext',
    about: 'A: browser.newContext() hangs on the standard path → ERROR at 20s; the context that shows up later is closed',
    run: async () => {
      h.mock.plan.login = 'reset'; // every prewarm fails → standard path at the tick
      process.env.PREWARM_LEAD_SEC = '45';
      const target = new Date(Date.now() + 45_000);
      setTimeout(() => (h.newContextFrozen = true), target.getTime() - Date.now() - 300);
      setTimeout(() => h.releaseContexts(), target.getTime() - Date.now() + 25_000);
      const { settled, onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(2), target, {
        onAccountSettled,
        suppressAlerts: true,
      });
      const firedAt = Date.parse(res.fired_at);
      assert.equal(settled.length, 2);
      for (const st of settled) {
        assert.equal(st.result.status, 'ERROR');
        assert.match(String(st.result.fail_reason), /newContext timeout \(20s\)/);
        const after = st.at - firedAt;
        assert.ok(after >= 19_500 && after < 22_000, `${st.result.username} gave up at +${after}ms`);
      }
      await h.waitFor(/\[cleanup\] late ctx mock-u1 close=/, 15_000);
      await h.waitFor(/\[cleanup\] late ctx mock-u2 close=/, 5_000);
      const lateCtx = h.contexts.filter((c) => c.createdAt >= firedAt + 20_000);
      assert.equal(lateCtx.length, 2, 'both late contexts were created after the release');
      assert.ok(lateCtx.every((c) => c.closeCalls === 1), 'each late context closed exactly once');
    },
  },
  {
    name: 'b-cut',
    about: 'B: login.php hangs → round 2 is CUT, its contexts closed ≤1s after the CUT, one close per round per account; all failed → fresh browser used by Phase 3',
    run: async () => {
      h.mock.plan.login = 'hang';
      process.env.PREWARM_LEAD_SEC = '100';
      const target = new Date(Date.now() + 100_000);
      const { settled, onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(3), target, {
        onAccountSettled,
        suppressAlerts: true,
      });
      const firedAt = Date.parse(res.fired_at);

      const cuts = h.find(/prewarm round CUT — cancelled 3 in-flight context\(s\)$/);
      assert.equal(cuts.length, 1, 'the second round was cut with 3 contexts in flight');
      assert.equal(h.find(/prewarm retry for 3 failed/).length, 1, 'two rounds in total');
      const cutAt = cuts[0].at;
      const prewarmCtx = h.contexts.filter((c) => c.browser === 0);
      assert.equal(prewarmCtx.length, 6, '3 accounts × 2 rounds of prewarm contexts');
      assert.ok(prewarmCtx.every((c) => c.closeCalls === 1), 'every prewarm context closed exactly once');
      const cutRound = prewarmCtx.filter((c) => c.createdAt < cutAt && c.createdAt > cutAt - 15_000);
      assert.equal(cutRound.length, 3, 'three contexts belong to the cut round');
      for (const c of cutRound) {
        const lag = (c.closeCalledAt ?? Infinity) - cutAt;
        assert.ok(lag >= 0 && lag <= 1_000, `cut-round context closed ${lag}ms after the CUT`);
      }
      for (const n of [1, 2, 3]) {
        const closes = h.find(new RegExp(`\\[cleanup\\] prewarm ctx mock-u${n} close`));
        assert.equal(closes.length, 2, `mock-u${n}: one prewarm close per round`);
      }

      const fresh = h.find(/\[bookingEngine\] fresh browser for standard path \(launch=\d+ms\)/);
      assert.equal(fresh.length, 1, 'fresh browser launched');
      assert.ok(fresh[0].at < firedAt, 'fresh browser ready before the tick');
      assert.equal(h.launches.length, 2);
      const phase3 = h.contexts.filter((c) => c.createdAt >= firedAt);
      assert.equal(phase3.length, 3, 'three standard-path contexts at the tick');
      assert.ok(phase3.every((c) => c.browser === 1), 'Phase 3 ran on the fresh browser');
      assert.equal(settled.length, 3);
      await h.waitFor(/browser \(fresh\) close(=| hung)/, 40_000);
      await h.waitFor(/browser \(batch\) close(=| hung)/, 40_000);
    },
  },
  {
    name: 'b-opening',
    about: 'B: newContext() still pending when the round is CUT → context closed on arrival; Phase 3 books on the fresh browser',
    run: async () => {
      process.env.PREWARM_LEAD_SEC = '50';
      const target = new Date(Date.now() + 50_000);
      h.newContextFrozen = true;
      setTimeout(() => h.releaseContexts(), target.getTime() - Date.now() - 35_000);
      const { settled, onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(3), target, {
        onAccountSettled,
        suppressAlerts: true,
      });
      assert.equal(
        h.find(/prewarm round CUT — cancelled 0 in-flight context\(s\), 3 still opening \(closed on arrival\)/).length,
        1
      );
      const prewarmCtx = h.contexts.filter((c) => c.browser === 0);
      assert.equal(prewarmCtx.length, 3, 'the three held contexts arrived after the release');
      for (const c of prewarmCtx) {
        const lag = (c.closeCalledAt ?? Infinity) - c.createdAt;
        assert.ok(c.closeCalls === 1 && lag <= 1_000, `closed on arrival (${lag}ms)`);
      }
      assert.ok(h.has(/fresh browser for standard path/));
      const firedAt = Date.parse(res.fired_at);
      assert.ok(
        h.contexts.filter((c) => c.createdAt >= firedAt).every((c) => c.browser === 1),
        'Phase 3 ran on the fresh browser'
      );
      assert.deepEqual(res.results.map((r) => r.status), ['PASS', 'PASS', 'PASS']);
      assert.equal(settled.length, 3);
    },
  },  {
    name: 'e-watchdog',
    about: 'E: yesterday\'s state after 12:05 → 1 DM, restart → no repeat; no cron user / before 12:05 / dispatched → none',
    run: async () => {
      const file = process.env.RUN_STATE_PATH!;
      const today = runReport.bangkokDate(new Date());
      const yesterday = daysAgo(1);
      const at = (hhmm: string, date = today): Date => new Date(`${date}T${hhmm}:00+07:00`);
      const sent: string[] = [];
      const send = async (text: string): Promise<void> => {
        sent.push(text);
      };
      const restart = (): void => {
        delete require.cache[require.resolve('./runState')];
        runState = require('./runState');
      };
      const check = (hhmm: string, shouldRun = true, date = today) =>
        runState.checkMissedNoon({ shouldRunToday: () => shouldRun, send, now: at(hhmm, date) });

      // First start of this version, after 12:05, no state file: seed, no alert.
      fs.rmSync(file, { force: true });
      assert.equal(await check('14:00'), false);
      assert.equal(runState.readRunState()?.missed_alert_date, today, 'seeded as handled');
      assert.equal(sent.length, 0);

      // The spec case: last dispatch yesterday.
      fs.writeFileSync(
        file,
        JSON.stringify({ last_cron_fired_date: yesterday, last_dispatch_date: yesterday })
      );
      assert.equal(await check('12:04'), false, 'not before 12:05');
      assert.equal(await check('12:30', false), false, 'no user with cron on → no alert');
      assert.equal(await check('12:31'), true, 'alert after 12:05');
      assert.equal(sent.length, 1);
      assert.equal(
        sent[0],
        '⚠️ พลาดรอบ 12:00 วันนี้ — bot ไม่ได้ยิง (เครื่องหลับ/ปิดอยู่ช่วง 11:55–12:00?) ตื่นมาเวลา 12:31'
      );
      assert.ok(h.has(/\[watchdog\] missed noon run/));
      restart();
      assert.equal(await check('12:32'), false, 'restart → no second alert today');
      assert.equal(await check('23:59'), false);
      assert.equal(sent.length, 1);

      // A Telegram failure is retried on the next check (not marked as sent).
      fs.writeFileSync(file, JSON.stringify({ last_dispatch_date: yesterday }));
      await assert.rejects(
        runState.checkMissedNoon({
          shouldRunToday: () => true,
          send: async () => {
            throw new Error('telegram down');
          },
          now: at('12:10'),
        })
      );
      assert.equal(await check('12:11'), true, 'retried after the failed send');

      // Normal day: cron + dispatch recorded today → silent.
      fs.writeFileSync(file, JSON.stringify({ last_dispatch_date: yesterday }));
      runState.recordCronFired(at('11:55'));
      runState.recordDispatch(at('12:00'));
      const st = runState.readRunState();
      assert.equal(st?.last_cron_fired_date, today);
      assert.equal(st?.last_dispatch_date, today);
      const before = sent.length;
      assert.equal(await check('12:06'), false, 'dispatched today → no alert');
      assert.equal(sent.length, before);
    },
  },  {
    name: 'f-log',
    about: 'F2: bot.log is appended across restarts and rotated to .1 past the size cap (one .1 kept)',
    run: async () => {
      const file = path.join(TMP, 'bot.log');
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.1`, { force: true });
      let write = botLog.openAppendLog(file, 100);
      write('run1-a\n');
      write('run1-b\n');
      write = botLog.openAppendLog(file, 100); // restart
      write('run2-a\n');
      write = botLog.openAppendLog(file, 100); // restart again
      write('run3-a\n');
      assert.equal(fs.readFileSync(file, 'utf-8'), 'run1-a\nrun1-b\nrun2-a\nrun3-a\n', 'earlier runs kept');

      write('x'.repeat(80) + '\n'); // crosses the 100-byte cap
      write('after-rotate\n');
      assert.match(fs.readFileSync(`${file}.1`, 'utf-8'), /^run1-a\n[\s\S]*x{80}\n$/, 'old log moved to .1');
      assert.equal(fs.readFileSync(file, 'utf-8'), 'after-rotate\n');
      write('y'.repeat(100) + '\n');
      write('second-rotate\n');
      assert.match(fs.readFileSync(`${file}.1`, 'utf-8'), /^after-rotate\ny{100}\n$/, 'only one .1 is kept');
      assert.equal(botLog.BOT_LOG_MAX_BYTES, 5 * 1024 * 1024, 'production cap is 5MB');
    },
  },
  {
    name: 'f-startup',
    about: 'F1 (source-level, bot.ts cannot run next to the live bot): cron + watchdog before getMe, getMe retried with 5/10/30/60s backoff, no exit',
    run: async () => {
      const src = fs.readFileSync(path.join(__dirname, 'bot.ts'), 'utf-8');
      const main = src.slice(src.indexOf('async function main()'), src.indexOf('/** getMe retry schedule'));
      assert.ok(main.length > 0, 'main() found');
      assert.ok(!/process\.exit\(1\)/.test(main), 'main() never exits on a Telegram failure');
      assert.ok(!/bot\.telegram\.getMe/.test(main), 'main() does not wait for getMe');
      const cronAt = main.indexOf("cron.schedule('55 11 * * *'");
      const watchdogAt = main.indexOf('startMissedRunWatchdog()');
      const telegramAt = main.indexOf('void connectTelegramThenPoll()');
      assert.ok(cronAt >= 0 && watchdogAt > cronAt && telegramAt > watchdogAt, 'cron → watchdog → Telegram');
      const connect = src.slice(
        src.indexOf('async function connectTelegramThenPoll()'),
        src.indexOf('/** Custom long-polling loop')
      );
      assert.ok(/GETME_RETRY_DELAYS_MS\[/.test(connect) && !/process\.exit/.test(connect), 'getMe retries, never exits');
      assert.ok(/const GETME_RETRY_DELAYS_MS = \[5_000, 10_000, 30_000, 60_000\];/.test(src), 'backoff 5s/10s/30s/60s');
      assert.ok(connect.indexOf('getMe()') < connect.indexOf('startPollingLoop()'), 'polling starts after getMe');
      assert.ok(!/writeFileSync\(LOG_PATH, ''\)/.test(src), 'bot.log no longer truncated at start');
    },
  },
  {
    name: 'w-wipe',
    about: 'W: site wipes every row at FIRE+2s → wiped PASSes re-book (lost court → next), POST queued past the cut kept, success answered after the cut re-booked, first-wave FAIL books after the wipe, dead court skipped; status = the list',
    run: async () => {
      process.env.WIPE_HOLD_SEC = '6';
      process.env.PREWARM_LEAD_SEC = '55';
      const target = new Date(Date.now() + 55_000);
      const T = target.getTime();
      const acct = (n: number, slot: string): Account => ({
        username: `wipe-u${n}`,
        password: 'mock-pw',
        slot,
      });
      const accounts = [
        acct(1, '18:30_19:30'), // first wave PASS → wiped → its court taken by an outsider
        acct(2, '18:30_19:30'), // dead court twice, PASS on the next → wiped → re-book
        acct(3, '19:30_20:30'), // POST queued 2.6s → inserted after the cut → kept
        acct(4, '19:30_20:30'), // dead court twice, PASS on the next → wiped → re-book
        acct(5, '20:30_21:30'), // slot taken everywhere → first wave FAIL → books after the cut
        acct(6, '21:30_22:30'), // inserted before the cut, answered after it → re-book
      ];
      h.mock.plan.courtErrors = new Set(['แบดมินตัน2']);
      h.mock.plan.postDelayMs = (user, n) => (user === 'wipe-u3' && n === 0 ? 2_600 : 0);
      h.mock.plan.respondDelayMs = (user, n) => (user === 'wipe-u6' && n === 0 ? 2_300 : 0);
      h.mock.at(T - 100, () => {
        for (const c of Object.keys(COURT_IDS)) h.mock.outsider(`early-${c}`, c, '20:30_21:30');
      });
      h.mock.at(T + WIPE_AFTER_MS, () => h.mock.wipe());
      h.mock.at(T + WIPE_AFTER_MS + 5, () => h.mock.outsider('outsider-x', 'แบดมินตัน3', '18:30_19:30'));

      const { settled, onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(accounts, target, { onAccountSettled });
      const firedAt = Date.parse(res.fired_at);
      const byUser = new Map(res.results.map((r) => [r.username, r]));
      const wipedAt = h.mock.wipes[0];
      assert.equal(h.mock.wipes.length, 1, 'the site wiped once');

      for (const a of accounts) {
        const r = byUser.get(a.username)!;
        const row = h.mock.rowOf(a.username);
        assert.ok(row, `${a.username} holds a row at the end`);
        assert.equal(r.status, 'PASS', `${a.username} PASS`);
        assert.equal(r.court_booked, row!.court, `${a.username} reports the court the list shows`);
        assert.equal(r.verification?.row?.court, row!.court);
        assert.ok(row!.at > wipedAt, `${a.username}'s row was inserted after the wipe`);
        assert.notEqual(row!.court, 'แบดมินตัน2', `${a.username} not on the dead court`);
        assert.ok(fs.existsSync(r.screenshot), `${a.username} screenshot`);
      }
      assert.equal(h.mock.rowOf('outsider-x')?.court, 'แบดมินตัน3', 'the outsider kept its court');

      const posts = (u: string) => h.mock.postsBy(u).length;
      assert.equal(posts('wipe-u3'), 1, 'u3: queued past the cut — never re-submitted');
      assert.equal(byUser.get('wipe-u3')!.verification?.hold_submits, 0);
      assert.equal(posts('wipe-u6'), 2, 'u6: answered after the cut — one re-book');
      assert.equal(byUser.get('wipe-u5')!.verification?.first_wave_status, 'FAIL');
      for (const u of ['wipe-u1', 'wipe-u2', 'wipe-u4', 'wipe-u6']) {
        const r = byUser.get(u)!;
        assert.equal(r.verification?.first_wave_status, 'PASS', `${u}: first wave PASS`);
        assert.ok(r.attempts.some((t) => t.outcome === 'wiped'), `${u}: wipe recorded`);
      }
      const deadAfterWipe = h.mock.requests.filter(
        (q) => q.path === '/book_court.php' && q.at > wipedAt && /(^|&)court_id=102(&|$)/.test(q.body)
      );
      assert.equal(deadAfterWipe.length, 0, 'no re-book on the dead แบดมินตัน2');

      assert.ok(h.has(/^\[wipe\] WIPE detected at \+\d+ms: \d+ of \d+ row\(s\) gone/), 'wipe detected');
      assert.ok(h.has(/^\[wipe\] watch end \(hold window over\)/), 'watch ended with the window');
      for (const st of settled) {
        const after = st.at - firedAt;
        assert.ok(after >= 5_900 && after < 9_000, `${st.result.username} settled at +${after}ms`);
      }
    },
  },
  {
    name: 'w-nowipe',
    about: 'W: no wipe → every first-wave PASS confirmed from the list at the end of the hold; nobody submits twice',
    run: async () => {
      process.env.WIPE_HOLD_SEC = '4';
      process.env.PREWARM_LEAD_SEC = '55';
      const target = new Date(Date.now() + 55_000);
      const { settled, onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(3), target, { onAccountSettled });
      const firedAt = Date.parse(res.fired_at);

      assert.deepEqual(res.results.map((r) => r.status), ['PASS', 'PASS', 'PASS']);
      for (const r of res.results) {
        assert.equal(h.mock.postsBy(r.username).length, 1, `${r.username}: one POST`);
        assert.equal(r.court_booked, h.mock.rowOf(r.username)?.court);
        assert.equal(r.verification?.hold_submits, 0);
        assert.equal(r.verification?.wipe_detected_at, null);
      }
      assert.equal(h.find(/^\[verify\] mock-u\d PASS row=แบดมินตัน\d\/18:30_19:30#\d+ /).length, 3);
      assert.ok(!h.has(/WIPE detected|rows vanished|row gone/), 'no wipe seen');
      const end = h.find(/^\[wipe\] watch end \(hold window over\) at \+\d+ms: polls=(\d+)/)[0];
      assert.ok(end, 'watch ended with the window');
      const polls = Number(/polls=(\d+)/.exec(end.text)?.[1]);
      assert.ok(polls >= 5 && polls <= 40, `polling stayed bounded (${polls})`);
      for (const st of settled) {
        const after = st.at - firedAt;
        assert.ok(after >= 3_900 && after < 6_500, `${st.result.username} settled at +${after}ms`);
      }
      assertUntouchedNormalRun();
    },
  },
  {
    name: 'w-lost',
    about: 'W: outsiders take the slot on every court right after the wipe → honest FAIL "ถูกเว็บลบ", no PASS, no pointless submit (header row in <td>)',
    run: async () => {
      process.env.WIPE_HOLD_SEC = '5';
      process.env.PREWARM_LEAD_SEC = '55';
      h.mock.plan.tdHeader = true;
      const target = new Date(Date.now() + 55_000);
      const T = target.getTime();
      h.mock.at(T + 50, () => {
        for (const c of ['แบดมินตัน4', 'แบดมินตัน5', 'แบดมินตัน6']) h.mock.outsider(`early-${c}`, c, '19:30_20:30');
      });
      h.mock.at(T + WIPE_AFTER_MS, () => {
        h.mock.wipe();
        for (const c of Object.keys(COURT_IDS)) h.mock.outsider(`late-${c}`, c, '18:30_19:30');
      });
      const { onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(2), target, { onAccountSettled });

      assert.ok(h.has(/^\[wipe\] WIPE detected/), 'wipe detected');
      for (const r of res.results) {
        assert.equal(r.status, 'FAIL', `${r.username} FAIL`);
        assert.equal(r.court_booked, null);
        assert.match(
          String(r.fail_reason),
          /^การจองถูกเว็บลบหลังเที่ยง \(\+\d+\.\ds\) — จองใหม่ไม่สำเร็จ: ไม่มีสนามว่าง$/
        );
        assert.equal(r.verification?.row, null);
        assert.equal(r.verification?.first_wave_status, 'PASS');
        assert.equal(h.mock.postsBy(r.username).length, 1, `${r.username}: nothing free → no re-book submit`);
        assert.equal(h.mock.rowOf(r.username), undefined);
      }
    },
  },
  {
    name: 'w-already',
    about: 'W: the site counts wiped rows for its 1-per-day rule → re-book answered "already booked": stop submitting, FAIL with a check-the-site reason',
    run: async () => {
      process.env.WIPE_HOLD_SEC = '5';
      process.env.PREWARM_LEAD_SEC = '55';
      h.mock.plan.countsWipedRows = true;
      const target = new Date(Date.now() + 55_000);
      const T = target.getTime();
      h.mock.at(T + 50, () => {
        for (const c of ['แบดมินตัน4', 'แบดมินตัน5', 'แบดมินตัน6']) h.mock.outsider(`early-${c}`, c, '19:30_20:30');
      });
      h.mock.at(T + WIPE_AFTER_MS, () => h.mock.wipe());
      const { onAccountSettled } = collectSettled();
      const res = await engine.runPrewarmedBatch(mockAccounts(1), target, { onAccountSettled });
      const r = res.results[0];

      assert.equal(r.status, 'FAIL');
      assert.equal(r.fail_reason, 'เว็บตอบว่าจองวันนี้แล้ว แต่ไม่พบชื่อใน reservations.php — ให้เช็คหน้าเว็บ');
      assert.equal(h.mock.postsBy('mock-u1').length, 2, 'one re-book submit, then stop');
      assert.ok(r.attempts.some((t) => t.reason === 'hold: already-booked'));
      assert.equal(r.verification?.hold_submits, 1);
    },
  },
  {
    name: 'w-killswitch',
    about: 'W: WIPE_GUARD=0 → pre-fix path: PASS straight from the POST answer, no hold — while the site has already wiped both rows (the false PASS of 09-28/09-30/10-01)',
    run: async () => {
      process.env.WIPE_GUARD = '0';
      try {
        process.env.PREWARM_LEAD_SEC = '55';
        const target = new Date(Date.now() + 55_000);
        h.mock.at(target.getTime() + WIPE_AFTER_MS, () => h.mock.wipe());
        const { settled, onAccountSettled } = collectSettled();
        const res = await engine.runPrewarmedBatch(mockAccounts(2), target, { onAccountSettled });
        const firedAt = Date.parse(res.fired_at);
        await sleep(Math.max(0, firedAt + WIPE_AFTER_MS + 300 - Date.now()));

        assert.deepEqual(res.results.map((r) => r.status), ['PASS', 'PASS'], 'reported PASS');
        assert.equal(h.mock.wipes.length, 1, 'the site wiped once');
        assert.equal(h.mock.rows.length, 0, '…and neither PASS still has a row');
        for (const st of settled) {
          assert.ok(st.at - firedAt < WIPE_AFTER_MS, `${st.result.username} settled before the wipe`);
        }
        assert.ok(!h.has(/^\[(wipe|verify)\]/), 'no guard activity');
        for (const n of [1, 2]) assert.equal(h.mock.postsBy(`mock-u${n}`).length, 1, 'one POST each');
      } finally {
        delete process.env.WIPE_GUARD;
      }
    },
  },
];

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const selected = wanted.length ? scenarios.filter((s) => wanted.includes(s.name)) : scenarios;
  if (wanted.length && selected.length !== wanted.length) {
    const known = scenarios.map((s) => s.name).join(', ');
    throw new Error(`unknown scenario in [${wanted.join(', ')}] — known: ${known}`);
  }
  rawWrite(`temp dir: ${TMP}\n`);
  const outcomes: { name: string; ok: boolean; ms: number; error?: string }[] = [];
  for (const s of selected) {
    h = new Harness();
    await h.mock.start();
    delete process.env.PREWARM_LEAD_SEC;
    delete process.env.WIPE_HOLD_SEC;
    delete process.env.WIPE_GUARD;
    rawWrite(`\n=== ${s.name} — ${s.about}\n`);
    const t0 = Date.now();
    try {
      await s.run();
      outcomes.push({ name: s.name, ok: true, ms: Date.now() - t0 });
    } catch (err) {
      outcomes.push({ name: s.name, ok: false, ms: Date.now() - t0, error: String(err) });
    } finally {
      await h.shutdown();
    }
  }
  rawWrite('\n=== summary\n');
  for (const o of outcomes) {
    rawWrite(`${o.ok ? '✅' : '❌'} ${o.name} (${Math.round(o.ms / 1000)}s)${o.error ? `  ${o.error}` : ''}\n`);
  }
  process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
}

main().catch((err) => {
  rawWrite(`harness crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
