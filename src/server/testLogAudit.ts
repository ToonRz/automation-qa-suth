// src/server/testLogAudit.ts
//
// Mock-server harness for the 2026-09-28 log-audit fixes
// (doc/fix-plan-2026-09-28-log-audit.md — tasks C, D, A, B, E, F).
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
}

interface MockRequest {
  at: number;
  method: string;
  path: string;
  user: string;
  body: string;
}

class MockSusport {
  plan: MockPlan = {
    login: 'ok',
    reservedTimes: 'ok',
    reservations: 'ok',
    bookPost: () => 'ok',
  };
  requests: MockRequest[] = [];
  bookings = new Map<string, { court: string; slot: string }>();
  frozen = false;
  private held: Array<() => void> = [];
  private posts = new Map<string, number>();
  private server = http.createServer((req, res) => this.onRequest(req, res));
  port = 0;

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
      case '/get_reserved_times.php':
        if (this.plan.reservedTimes === 'hang') return;
        return send(200, 'application/json', '[]');
      case '/book_court.php': {
        const n = this.posts.get(user) ?? 0;
        this.posts.set(user, n + 1);
        const mode = this.plan.bookPost(user, n);
        if (mode === 'hang') return;
        const params = new URLSearchParams(body);
        const courtId = params.get('court_id') ?? '';
        const court = Object.keys(COURT_IDS).find((k) => COURT_IDS[k] === courtId) ?? `id-${courtId}`;
        this.bookings.set(user, { court, slot: params.get('time_slot') ?? '' });
        if (mode === 'hang-books') return;
        return html(this.reservationsHtml(user));
      }
      case '/reservations.php':
        if (this.plan.reservations === 'hang' && method === 'GET') return;
        return html(this.reservationsHtml(user));
      default:
        return send(404, 'text/plain', 'not found');
    }
  }

  private reservationsHtml(user: string): string {
    const b = this.bookings.get(user);
    const row = b ? `<tr><td>${user}</td><td>${b.court}</td><td>${b.slot}</td></tr>` : '';
    return (
      '<html><body><h2>การจองสนามในวันที่ 2026-09-28</h2>' +
      '<table><tr><th>ชื่อผู้ใช้</th><th>สนาม</th><th>เวลา</th></tr>' +
      row +
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
  pagesFrozen = false;
  private heldPages: Array<() => void> = [];

  freezeAll(): void {
    this.mock.freeze();
    this.pagesFrozen = true;
  }

  releaseAll(): void {
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
  const browser = await realLaunch(options);
  rec.doneAt = Date.now();
  h.browsers.push(browser);
  wrapBrowser(browser, idx);
  return browser;
};

function wrapBrowser(browser: Browser, idx: number): void {
  const realNewContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const ctx = await realNewContext(options);
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
    await ctx.route(`${SITE}/**`, (route) => forward(route, rec));
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
