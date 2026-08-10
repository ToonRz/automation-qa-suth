// src/scheduler.ts
// Wait until 12:00:00 (local, no tolerance per SC-04), then release all 9 accounts in parallel.
//
// Time source: the local OS clock, exactly as required by SC-01/SC-04. HTTP Date
// headers have only whole-second precision and must not shift this millisecond tick.
//
// CLI flags:
//   --now           skip the wait, run immediately
//   --tomorrow      target tomorrow's 12:00:00 (if today is past noon)
//   --dry-run       skip the final submit click on each account (no slots consumed)
//   --account=USER  run only this single account (debug aid; bypasses scheduler)

import { runAllAccounts } from './runner';
import { bookOneAccount, Account } from './bookingFlow';
import { getConfig, COURTS } from './server/configLoader';
import { waitUntilLocalTimestamp } from './localClock';

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

async function countdown(targetMs: number): Promise<void> {
  // Tick every second, but hand control to the precise waiter before the last
  // 50ms. A fixed 1s final sleep could otherwise overshoot noon by almost 1s.
  while (true) {
    const remaining = Math.max(0, targetMs - Date.now());
    if (remaining <= 50) break;
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.floor((remaining % 3_600_000) / 60_000);
    const s = Math.floor((remaining % 60_000) / 1000);
    process.stdout.write(
      `\r⏳ รอ ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} จนถึง 12:00:00 น.   `
    );
    await sleep(Math.min(1000, Math.max(1, remaining - 50)));
  }
  process.stdout.write('\n');
}

async function runSingleAccount(username: string, dryRun: boolean) {
  const account = getConfig().accounts.find((a) => a.username === username);
  if (!account) {
    console.error(`❌ Account "${username}" not found in config/accounts.json`);
    process.exit(1);
  }
  console.log(`\n=== Single-account debug run ===`);
  console.log(`Account: ${account.username}  Court: ${account.court ?? COURTS[0]}  Slot: ${account.slot}`);
  console.log(`Mode:    ${dryRun ? 'DRY-RUN' : 'LIVE'}\n`);
  const result = await bookOneAccount(account, { dryRun, courtPriority: COURTS });
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
    await runAllAccounts({ dryRun: opts.dryRun, courtPriority: COURTS });
    return;
  }

  // Scheduled mode: compute local noon, wait, then fire.
  console.log(`\n=== Scheduled run ===`);
  const target = targetNoon(opts);
  const diff = target.getTime() - Date.now();

  console.log(`Target: ${target.toLocaleString('th-TH')} (${target.toISOString()})`);
  console.log(`Mode:   ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}`);

  if (diff > 0) {
    await countdown(target.getTime());
  }

  // Final 1ms wait for the exact local tick (per SC-04, no tolerance).
  await waitUntilLocalTimestamp(target.getTime());
  const fired_at = new Date();
  console.log(
    `🚀 FIRED at ${fired_at.toISOString()} (target was ${target.toISOString()}, ` +
      `drift ${fired_at.getTime() - target.getTime()}ms)`
  );

  await runAllAccounts({ dryRun: opts.dryRun, courtPriority: COURTS });
}

main().catch((err) => {
  console.error(`\n❌ Scheduler error: ${err}`);
  process.exit(1);
});
