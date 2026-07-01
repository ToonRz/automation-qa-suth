// src/server/bookingEngine.ts
// The bot's booking entry point. Two modes:
//
//   - runWithPrewarm(accounts, targetTime): during the countdown, open N contexts
//     and fill each login form WITHOUT submitting. At the exact tick, click submit
//     on all N in the same Promise.all. This saves ~500-1000ms vs navigating at
//     12:00:00.000.
//
//   - runStandard(accounts): launch browser, run all N in parallel, no warmup.
//     Fallback if prewarm fails (e.g. susport rate-limits pre-loaded forms).
//
// Selection: prewarm is attempted first; if it throws, fall through to standard.
// Each account's prewarmed context has its OWN browser context (BR-01/02).

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { bookOneAccount, Account, BookingResult } from '../bookingFlow';
import { getServerNow } from '../timeSync';

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';
const SCREENSHOTS_DIR = '/app/screenshots'; // overridden via env in deploy

interface PrewarmedContext {
  account: Account;
  context: BrowserContext;
  page: Page;
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
