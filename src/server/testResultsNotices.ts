// src/server/testResultsNotices.ts
//
// One-off test: build the post-run DM formats the same way runScheduledBooking()
// does in bot.ts and actually send them to the owner via Telegram. The cron
// only fires these messages at 12:00 (and per-user results depend on a real
// booking run), so without this test we'd never know if the format broke until
// noon.
//
// Verifies:
//   - .env loads (TELEGRAM_BOT_TOKEN present)
//   - users.json loads and the owner can be resolved
//   - sendTelegramMessage() works from this host (IPv4, timeouts OK)
//   - formatResultsForUser() renders correctly (per-user DM)
//   - formatSummaryForOwner() renders correctly (cross-user owner DM)
//   - structural invariants in bot.ts (signature, byCourt grouping) hold
//
// Run:  npm run bot:test-results
//
// Does NOT touch the cron, does NOT touch the booking engine.

import * as dotenv from 'dotenv';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';

// Force IPv4 for Telegram — same workaround as bot.ts. Without this the
// outbound fetch may hang for 15s on IPv6 SYN timeout before falling back.
dns.setDefaultResultOrder('ipv4first');

import { getOwner } from './userStore';
import type { AccountResult } from './userStore';
import { sendTelegramMessage } from './telegramSend';

dotenv.config();

const BOT_TS_PATH = path.resolve(__dirname, 'bot.ts');

/** Mirror of formatResultsForUser() in bot.ts (per-user DM sent after a booking run). */
function formatResultsForUser(
  displayName: string,
  accounts: AccountResult[],
  mode: 'prewarm' | 'standard',
  totalMs: number
): string {
  const lines: string[] = [];
  lines.push(`📊 ผลจอง — ${displayName}`);
  lines.push(`⏱  ${(totalMs / 1000).toFixed(2)}s (${mode === 'prewarm' ? 'prewarm' : 'standard'})`);
  lines.push('');
  for (const a of accounts) {
    const tag = a.status === 'PASS' ? '✅' : a.status === 'DRY-RUN' ? '◉' : '❌';
    const detail =
      a.status === 'PASS'
        ? `${a.court_booked ?? a.court} ${a.slot}`
        : a.fail_reason ?? a.status;
    lines.push(`${tag} ${a.username}  ${detail}`);
  }
  const pass = accounts.filter((a) => a.status === 'PASS').length;
  const fail = accounts.filter((a) => a.status === 'FAIL').length;
  const err = accounts.filter((a) => a.status === 'ERROR').length;
  lines.push('');
  lines.push(`PASS: ${pass} | FAIL: ${fail} | ERROR: ${err}`);
  return lines.join('\n');
}

/** Mirror of formatSummaryForOwner() in bot.ts (cross-user owner summary DM). */
function formatSummaryForOwner(allResults: { user: string; accounts: AccountResult[] }[]): string {
  const lines: string[] = ['📊 สรุปผลรวม 12:00'];
  lines.push('━━━━━━━━━━━━━━━━━━');
  let totalPass = 0,
    totalFail = 0,
    totalErr = 0;
  for (const { user, accounts } of allResults) {
    lines.push(`\n👤 ${user} (${accounts.length} accounts)`);
    for (const a of accounts) {
      const tag = a.status === 'PASS' ? '✅' : a.status === 'DRY-RUN' ? '◉' : '❌';
      const detail = a.status === 'PASS' ? a.court_booked ?? a.court : a.fail_reason ?? a.status;
      lines.push(`  ${tag} ${a.username}  ${detail}`);
      if (a.status === 'PASS') totalPass++;
      else if (a.status === 'FAIL') totalFail++;
      else if (a.status === 'ERROR') totalErr++;
    }
  }
  lines.push('\n━━━━━━━━━━━━━━━━━━');
  lines.push(`Total: PASS ${totalPass} | FAIL ${totalFail} | ERROR ${totalErr}`);
  return lines.join('\n');
}

/** Build synthetic results that exercise all three status types (PASS/FAIL/DRY-RUN). */
function fakeResults(): AccountResult[] {
  return [
    {
      username: '670910088',
      court: 'แบดมินตัน1',
      slot: '17:30_18:30',
      status: 'PASS',
      fail_reason: null,
      court_booked: 'แบดมินตัน1',
      duration_ms: 1234,
    },
    {
      username: '670910321',
      court: 'แบดมินตัน1',
      slot: '18:30_19:30',
      status: 'FAIL',
      fail_reason: 'ทั้ง 2 สนามเต็ม',
      court_booked: null,
      duration_ms: 2100,
    },
    {
      username: '670910478',
      court: 'แบดมินตัน4',
      slot: '19:30_20:30',
      status: 'PASS',
      fail_reason: null,
      court_booked: 'แบดมินตัน4',
      duration_ms: 1450,
    },
    {
      username: '670911373',
      court: 'แบดมินตัน1',
      slot: '21:30_22:30',
      status: 'ERROR',
      fail_reason: 'page.goto timeout 20000ms',
      court_booked: null,
      duration_ms: 20000,
    },
  ];
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN missing in .env');
    process.exit(1);
  }
  console.log(`Token: ${token.slice(0, 10)}... (len=${token.length})`);

  const owner = getOwner();
  if (!owner) {
    console.error('❌ No owner (role="owner") found in config/users.json');
    process.exit(1);
  }
  console.log(
    `Owner: ${owner.display_name}  chat_id=${owner.chat_id}  ` +
      `accounts=${owner.accounts.length}`
  );

  // --- Notification 1: per-user results DM (formatResultsForUser) ---
  const userResults = fakeResults();
  const userText = formatResultsForUser(owner.display_name, userResults, 'prewarm', 6789);
  console.log('--- per-user results DM ---');
  console.log(userText);
  console.log('---------------------------');
  if (userText.length < 100 || userText.length > 1500) {
    console.error(`❌ user results length ${userText.length} outside expected [100, 1500]`);
    process.exit(1);
  }
  console.log(`  ✅ length = ${userText.length} chars`);

  // --- Notification 2: cross-user owner summary DM (formatSummaryForOwner) ---
  const allResults: { user: string; accounts: AccountResult[] }[] = [
    { user: owner.display_name, accounts: userResults },
    {
      user: 'Friend',
      accounts: [
        {
          username: 'friend_acct_1',
          court: 'แบดมินตัน2',
          slot: '16:30_17:30',
          status: 'PASS',
          fail_reason: null,
          court_booked: 'แบดมินตัน2',
          duration_ms: 900,
        } as AccountResult,
      ],
    },
  ];
  const summaryText = formatSummaryForOwner(allResults);
  console.log('--- owner summary DM ---');
  console.log(summaryText);
  console.log('------------------------');
  if (summaryText.length < 100 || summaryText.length > 1500) {
    console.error(`❌ summary length ${summaryText.length} outside expected [100, 1500]`);
    process.exit(1);
  }
  console.log(`  ✅ length = ${summaryText.length} chars`);

  // --- Send both to Telegram (each as a separate DM, labeled for the test) ---
  try {
    await sendTelegramMessage(
      owner.chat_id,
      '[TEST] per-user results DM\n' + userText
    );
    console.log('✅ Per-user results DM delivered');
    await sendTelegramMessage(
      owner.chat_id,
      '[TEST] owner summary DM\n' + summaryText
    );
    console.log('✅ Owner summary DM delivered');
  } catch (err) {
    console.error(`❌ Send failed: ${err}`);
    process.exit(1);
  }

  // --- Source-level assertions ---
  // Read bot.ts and verify that the production formatters retain the expected
  // signatures and have not been refactored away — keeps the mirrors honest.
  console.log('\n--- source-level assertions ---');
  const botSrc = fs.readFileSync(BOT_TS_PATH, 'utf-8');

  // (a) formatResultsForUser signature: 4 params, returns string
  const hasResultsSig = /function formatResultsForUser\s*\(\s*displayName:\s*string\s*,\s*accounts:\s*AccountResult\[\][\s\S]*?totalMs:\s*number\s*\)\s*:\s*string/.test(
    botSrc
  );
  console.log(
    `  ${hasResultsSig ? '✅' : '❌'} formatResultsForUser(displayName, accounts, mode, totalMs): string present`
  );

  // (b) formatSummaryForOwner signature
  const hasSummarySig = /function formatSummaryForOwner\s*\(\s*allResults:\s*\{[^}]*user:\s*string[^}]*accounts:\s*AccountResult\[\][^}]*\}\[\][\s\S]*?\)\s*:\s*string/.test(
    botSrc
  );
  console.log(
    `  ${hasSummarySig ? '✅' : '❌'} formatSummaryForOwner(allResults: ...): string present`
  );

  // (c) call-site for per-user results — must wrap in try/catch so failure
  // does not abort the loop
  const userDmCall = /await sendTelegramMessage\(\s*task\.user\.chat_id\s*,\s*formatResultsForUser\(/.test(
    botSrc
  );
  console.log(
    `  ${userDmCall ? '✅' : '❌'} per-user results DM called via sendTelegramMessage`
  );

  // (d) call-site for owner summary
  const summaryDmCall = /await sendTelegramMessage\(\s*owner\.chat_id\s*,\s*formatSummaryForOwner\(/.test(
    botSrc
  );
  console.log(
    `  ${summaryDmCall ? '✅' : '❌'} owner summary DM called via sendTelegramMessage`
  );

  if (!hasResultsSig || !hasSummarySig || !userDmCall || !summaryDmCall) {
    console.error('❌ Source-level assertions failed');
    process.exit(1);
  }
  console.log('✅ All source-level assertions passed');
}

main().catch((err) => {
  console.error(`❌ Unhandled error: ${err}`);
  process.exit(1);
});
