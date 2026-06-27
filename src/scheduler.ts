// src/scheduler.ts
// Wait until 12:00:00 (local, no tolerance per SC-04), then release all 9 accounts in parallel.
//
// Time source: we sync with the web server before scheduling (src/timeSync.ts). Local system
// clock can drift tens to hundreds of ms from server clock; if we fire on local noon but
// server is 11:59:59.700, the booking may be rejected. getServerNow() compensates for skew.
//
// CLI flags:
//   --now           skip the wait, run immediately
//   --tomorrow      target tomorrow's 12:00:00 (if today is past noon)
//   --dry-run       skip the final submit click on each account (no slots consumed)
//   --account=USER  run only this single account (debug aid; bypasses scheduler)

import { runAllAccounts } from './runner';
import { bookOneAccount, Account } from './bookingFlow';
import { syncServerTime, getServerNow, getOffsetMs } from './timeSync';
import accounts from '../config/accounts.json';

interface CliOptions {
  now: boolean;
  tomorrow: boolean;
  dryRun: boolean;
  account?: string;
}

function parseCli(): CliOptions {
  const argv = process.argv.slice(2);
  // Accept both `--account=USER` and `--account USER` forms.
  let account: string | undefined;
  const eqArg = argv.find((a) => a.startsWith('--account='));
  if (eqArg) {
    account = eqArg.split('=')[1];
  } else {
    const idx = argv.findIndex((a) => a === '--account');
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
      account = argv[idx + 1];
    }
  }
  return {
    now: argv.includes('--now'),
    tomorrow: argv.includes('--tomorrow'),
    dryRun: argv.includes('--dry-run'),
    account,
  };
}

function targetNoon(opts: CliOptions): Date {
  const now = new Date();
  let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (opts.tomorrow || target.getTime() <= now.getTime()) {
    // Past noon (or explicit --tomorrow): aim for tomorrow
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0, 0);
  }
  return target;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countdown(ms: number): Promise<void> {
  const start = getServerNow();
  const end = start + ms;
  // Tick every second for live countdown (server-adjusted clock)
  while (getServerNow() < end) {
    const remaining = Math.max(0, end - getServerNow());
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.floor((remaining % 3_600_000) / 60_000);
    const s = Math.floor((remaining % 60_000) / 1000);
    process.stdout.write(
      `\r⏳ รอ ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} จนถึง 12:00:00 น.   `
    );
    await sleep(1000);
  }
  process.stdout.write('\n');
}

async function runSingleAccount(username: string, dryRun: boolean) {
  const account = (accounts as Account[]).find((a) => a.username === username);
  if (!account) {
    console.error(`❌ Account "${username}" not found in config/accounts.json`);
    process.exit(1);
  }
  console.log(`\n=== Single-account debug run ===`);
  console.log(`Account: ${account.username}  Court: ${account.court}  Slot: ${account.slot}`);
  console.log(`Mode:    ${dryRun ? 'DRY-RUN' : 'LIVE'}\n`);
  const result = await bookOneAccount(account, { dryRun });
  console.log(`\nResult: ${result.status}`);
  console.log(`  court_booked: ${result.court_booked}`);
  console.log(`  slot:         ${result.slot}`);
  console.log(`  fail_reason:  ${result.fail_reason ?? '(none)'}`);
  console.log(`  duration_ms:  ${result.duration_ms}`);
  console.log(`  screenshot:   ${result.screenshot}`);
}

async function main() {
  const opts = parseCli();

  // Single-account debug mode (bypasses scheduler entirely)
  if (opts.account) {
    await runSingleAccount(opts.account, opts.dryRun);
    return;
  }

  if (opts.now) {
    console.log(`\n=== Live run (--now, skipping wait) ===`);
    console.log(`Mode: ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}`);
    await runAllAccounts({ dryRun: opts.dryRun });
    return;
  }

  // Scheduled mode: sync server time FIRST, then compute target, then wait, then fire.
  console.log(`\n=== Scheduled run ===`);
  console.log(`Syncing with server time (5 samples)...`);
  let offsetMs = 0;
  try {
    offsetMs = await syncServerTime(5);
    const sign = offsetMs >= 0 ? '+' : '';
    console.log(`✓ Server offset: ${sign}${offsetMs}ms (local vs server)`);
  } catch (err) {
    console.warn(`⚠️  Time sync failed: ${err}`);
    console.warn(`   Falling back to local clock — clock skew risk`);
  }

  const target = targetNoon(opts);
  const diff = target.getTime() - getServerNow();

  console.log(`Target: ${target.toLocaleString('th-TH')} (${target.toISOString()})`);
  console.log(`Mode:   ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}`);

  if (diff > 0) {
    await countdown(diff);
  }

  // Spin-wait in the final 50ms for the exact tick (per SC-04, no tolerance)
  while (getServerNow() < target.getTime()) {
    await sleep(1);
  }
  const fired_at = new Date();
  console.log(
    `🚀 FIRED at ${fired_at.toISOString()} (target was ${target.toISOString()}, ` +
      `drift ${fired_at.getTime() - target.getTime()}ms)`
  );

  await runAllAccounts({ dryRun: opts.dryRun });
}

main().catch((err) => {
  console.error(`\n❌ Scheduler error: ${err}`);
  process.exit(1);
});