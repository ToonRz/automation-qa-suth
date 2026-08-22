// src/server/rehearse.ts
// Full-flow rehearsal against the LIVE site, off-noon, with dryRun:
//
//   - real logins for every registered account (all users),
//   - real prewarm with the real state machine (page-ready / login-ready /
//     needs-standard / failed) against whatever the dropdown shows right now,
//   - a real wait for a fake "noon" tick (now + lead + 30s),
//   - but NO submit is ever fired (dryRun stops before the POST) and NO
//     Telegram DM is sent (suppressAlerts).
//
// Purpose: exercise the exact code path that will run at 11:55→12:00 tomorrow
// — including 17-page contention — without consuming anyone's slot.
//
// Reading the result:
//   ◉ DRY-RUN  = the account would have submitted — the healthy outcome.
//   ✗ FAIL     = expected when the account already booked today, or when its
//                slot is genuinely taken right now (dry-run reflects the live
//                availability at rehearsal time) — read the reason.
//   ✗ ERROR    = a real problem in the flow. The script exits 1 on any ERROR.
//
// Usage:  npm run rehearse            (lead 60s → total ~90s + booking flow)
//         REHEARSE_LEAD_SEC=120 npm run rehearse

import * as dotenv from 'dotenv';
import { getAllUsers } from './userStore';
import { runPrewarmedBatch, prewarmLeadMs } from './bookingEngine';

dotenv.config();
// Shrink the prewarm lead for rehearsal (engine reads this lazily, so setting
// it here — after imports — is safe). Default 60s; override via REHEARSE_LEAD_SEC.
process.env.PREWARM_LEAD_SEC = process.env.REHEARSE_LEAD_SEC ?? '60';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const users = getAllUsers().filter((u) => u.accounts.length > 0);
  const flat = users.flatMap((u) => u.accounts);
  if (flat.length === 0) {
    console.error('rehearse: no accounts registered in config/users.json');
    process.exit(1);
  }

  const lead = prewarmLeadMs();
  const target = new Date(Date.now() + lead + 30_000);
  console.log('=== REHEARSAL (dry-run — no submit, no slot consumed, no DMs) ===');
  console.log(`accounts:  ${flat.length} (${users.map((u) => `${u.display_name}:${u.accounts.length}`).join(', ')})`);
  console.log(`lead:      ${Math.round(lead / 1000)}s | fake tick: ${target.toISOString()}`);
  console.log(`SUBMIT_VIA=${process.env.SUBMIT_VIA ?? '(unset → fetch)'}\n`);

  const engine = await runPrewarmedBatch(flat, target, {
    dryRun: true,
    suppressAlerts: true,
    onAccountSettled: (_i, r) => {
      console.log(
        `  [settled] ${r.username.padEnd(14)} ${r.status.padEnd(8)} ` +
          `${r.fail_reason ?? `${r.court_booked ?? '-'} ${r.slot}`}`
      );
    },
  });

  console.log(`\n=== results (engine total ${engine.total_ms}ms) ===`);
  let errors = 0;
  for (const r of engine.results) {
    const tag = r.status === 'DRY-RUN' ? '◉' : r.status === 'PASS' ? '✓' : '✗';
    if (r.status === 'ERROR') errors++;
    console.log(
      `${tag} ${r.username.padEnd(14)} ${r.status.padEnd(8)} ` +
        `court=${r.court_booked ?? '-'} slot=${r.slot} ` +
        `${r.fail_reason ? `(${r.fail_reason})` : ''} [${r.duration_ms}ms]`
    );
  }
  const dry = engine.results.filter((r) => r.status === 'DRY-RUN').length;
  const fail = engine.results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nDRY-RUN: ${dry}/${engine.results.length} | FAIL: ${fail} (already-booked/slot-taken is OK off-noon) | ERROR: ${errors}`);

  // Give the detached cleanup a moment so its [cleanup] timing lines print.
  await sleep(5_000);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('rehearse failed:', err);
  process.exit(1);
});
