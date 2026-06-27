// src/runner.ts
// Parallel release per SC-05 — all 9 contexts launch in the same tick via Promise.all.
// One slow login must NOT delay the others (each account is fully isolated in its own context).
//
// Performance: we launch ONE Browser instance and create 9 BrowserContexts from it.
// BR-01/02 only forbid reusing a *context*, not a browser — contexts are still fully
// isolated (separate cookies, localStorage, session storage, cache). This saves ~1s × 8
// redundant Chromium cold starts.

import { Browser, chromium } from 'playwright';
import { bookOneAccount, BookingResult, Account, FlowOptions } from './bookingFlow';
import accounts from '../config/accounts.json';
import * as fs from 'fs';
import * as path from 'path';

const REPORTS_DIR = path.resolve(__dirname, '..', 'reports');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export interface RunSummary {
  started_at: string;
  finished_at: string;
  total_ms: number;
  options: { dryRun: boolean };
  accounts: BookingResult[];
  counts: { PASS: number; FAIL: number; ERROR: number; 'DRY-RUN': number };
}

export async function runAllAccounts(options: FlowOptions = {}): Promise<RunSummary> {
  const started_at = new Date().toISOString();
  const start = Date.now();

  console.log(`\n=== Launching ${accounts.length} accounts in parallel ===`);
  console.log(`Mode: ${options.dryRun ? 'DRY-RUN (skip submit)' : 'LIVE'}`);
  console.log(`Started at: ${started_at}\n`);

  // Single Chromium process shared by all 9 contexts.
  const browser: Browser = await chromium.launch({ channel: 'chrome', headless: true });

  try {
    // SC-05: parallel release — Promise.all guarantees all start in the same tick
    const results = await Promise.all(
      (accounts as Account[]).map((account) =>
        bookOneAccount(account, { ...options, browser }).then((result) => {
          const tag = result.status === 'PASS' ? '✓' : result.status === 'DRY-RUN' ? '◉' : '✗';
          console.log(
            `${tag} ${result.username.padEnd(12)} ${result.status.padEnd(8)} ` +
            `court=${result.court_booked ?? '-'} slot=${result.slot} ` +
            `${result.fail_reason ? `(${result.fail_reason})` : ''} ` +
            `[${result.duration_ms}ms]`
          );
          return result;
        })
      )
    );

    const finished_at = new Date().toISOString();
    const summary: RunSummary = {
      started_at,
      finished_at,
      total_ms: Date.now() - start,
      options: { dryRun: !!options.dryRun },
      accounts: results,
      counts: {
        PASS: results.filter((r) => r.status === 'PASS').length,
        FAIL: results.filter((r) => r.status === 'FAIL').length,
        ERROR: results.filter((r) => r.status === 'ERROR').length,
        'DRY-RUN': results.filter((r) => r.status === 'DRY-RUN').length,
      },
    };

    ensureDir(REPORTS_DIR);
    const stamp = started_at.replace(/[:.]/g, '-');
    const reportFile = path.join(REPORTS_DIR, `run-${stamp}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(summary, null, 2));

    console.log(`\n=== Summary ===`);
    console.log(`PASS:      ${summary.counts.PASS}`);
    console.log(`FAIL:      ${summary.counts.FAIL}`);
    console.log(`ERROR:     ${summary.counts.ERROR}`);
    console.log(`DRY-RUN:   ${summary.counts['DRY-RUN']}`);
    console.log(`Total:     ${results.length} accounts in ${summary.total_ms}ms`);
    console.log(`\nReport saved: ${reportFile}`);

    return summary;
  } finally {
    await browser.close();
  }
}