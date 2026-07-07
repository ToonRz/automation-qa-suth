// src/server/sendDryRunMessages.ts
//
// One-off: read the latest dry-run report and send all 3 message types
// (prewarm notice + per-user results DM + owner summary DM) to the owner's
// Telegram chat. Lets the owner eyeball the EXACT messages the live cron
// would emit, with REAL output from `npm run dry-run`.
//
// Run:  npx ts-node src/server/sendDryRunMessages.ts
//
// Does NOT touch the cron, does NOT touch the booking engine.

import * as dotenv from 'dotenv';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';

// Force IPv4 for Telegram — same workaround as bot.ts.
dns.setDefaultResultOrder('ipv4first');

import { getOwner } from './userStore';
import type { AccountResult } from './userStore';
import { sendTelegramMessage } from './telegramSend';

dotenv.config();

// ---- mirror of formatResultsForUser() and formatSummaryForOwner() in bot.ts ----
// Kept in sync by source-level assertions in testResultsNotices.ts.

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

// ---- mirror of sendPrewarmNoticesForBooking() message body (owner users only) ----
// After the slot-first / court-priority-second refactor, per-account `court`
// is vestigial — the helper groups by slot to reflect the actual invariant.

function buildPrewarmText(
  ownerDisplayName: string,
  ownerAccounts: Array<{ username: string; slot: string }>,
  fireTime: Date,
  cronFireAt: Date
): string {
  const bySlot = new Map<string, typeof ownerAccounts>();
  for (const acc of ownerAccounts) {
    const list = bySlot.get(acc.slot) ?? [];
    list.push(acc);
    bySlot.set(acc.slot, list);
  }
  for (const list of bySlot.values()) {
    list.sort((a, b) => a.username.localeCompare(b.username));
  }

  const fmtTime = (d: Date): string => d.toTimeString().slice(0, 8);
  const fmtSlot = (s: string): string => s.replace('_', '-');
  const leadMin = Math.round((fireTime.getTime() - cronFireAt.getTime()) / 60_000);

  const lines: string[] = [];
  lines.push(`⏰ ตื่นแล้ว! Pre-warm เริ่ม ${fmtTime(cronFireAt)}`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push('');
  lines.push(`📅 จะจองตอน ${fmtTime(fireTime)} น.`);
  lines.push(`👤 ${ownerDisplayName} · ${ownerAccounts.length} accounts`);
  lines.push(`⏳ เหลืออีก ${leadMin} นาที`);
  lines.push('');
  lines.push(`🎯 แผนจอง:`);
  for (const [slot, accounts] of bySlot) {
    lines.push(`   🕒 ${fmtSlot(slot)} (${accounts.length} คิว)`);
    for (const acc of accounts) {
      lines.push(`      • ${acc.username}`);
    }
  }
  lines.push('');
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`🛠  [Login → เลือก court (priority) → เลือก slot → ยืนยัน]`);
  return lines.join('\n');
}

// Find the most recent run-*.json in reports/ — that's the dry-run output.
function newestReportPath(): string {
  const dir = path.resolve(__dirname, '..', '..', 'reports');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
    .map((f) => path.join(dir, f));
  if (files.length === 0) throw new Error('no run-*.json reports found');
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

function nextNoonLocal(): Date {
  const now = new Date();
  let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      12,
      0,
      0,
      0
    );
  }
  return target;
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

  // 1. Load the most recent report (the dry-run we just ran).
  const reportPath = newestReportPath();
  console.log(`Reading latest report: ${reportPath}`);
  const reportRaw = fs.readFileSync(reportPath, 'utf-8');
  const report = JSON.parse(reportRaw) as {
    total_ms: number;
    options: { dryRun: boolean };
    accounts: Array<{
      username: string;
      court: string;
      slot: string;
      status: 'PASS' | 'FAIL' | 'ERROR' | 'DRY-RUN';
      fail_reason: string | null;
      court_booked: string | null;
      duration_ms: number;
    }>;
  };
  console.log(
    `Report: dryRun=${report.options.dryRun} total_ms=${report.total_ms} ` +
      `accounts=${report.accounts.length}`
  );

  // 2. Build prewarm notice (owner's plan for the noon run).
  const fireTime = nextNoonLocal();
  const cronFireAt = new Date(fireTime.getTime() - 5 * 60_000);
  const prewarmText = buildPrewarmText(
    owner.display_name,
    owner.accounts.map((a) => ({ username: a.username, slot: a.slot })),
    fireTime,
    cronFireAt
  );

  // 3. Build per-user results DM using ACTUAL dry-run account outcomes.
  const accountResults: AccountResult[] = report.accounts.map((a) => ({
    username: a.username,
    court: a.court,
    slot: a.slot,
    status: a.status,
    fail_reason: a.fail_reason,
    court_booked: a.court_booked,
    duration_ms: a.duration_ms,
  }));
  const userText = formatResultsForUser(owner.display_name, accountResults, 'prewarm', report.total_ms);

  // 4. Build owner summary DM (cross-user, but we only have owner in dry-run).
  const summaryText = formatSummaryForOwner([
    { user: owner.display_name, accounts: accountResults },
  ]);

  console.log('\n--- prewarm notice ---');
  console.log(prewarmText);
  console.log(`(${prewarmText.length} chars)\n`);

  console.log('--- per-user results DM ---');
  console.log(userText);
  console.log(`(${userText.length} chars)\n`);

  console.log('--- owner summary DM ---');
  console.log(summaryText);
  console.log(`(${summaryText.length} chars)\n`);

  // 5. Send all 3 to the owner.
  try {
    await sendTelegramMessage(owner.chat_id, '[DRY-RUN sample] prewarm notice\n\n' + prewarmText);
    console.log('✅ Prewarm notice delivered');
  } catch (err) {
    console.error(`❌ prewarm send failed: ${err}`);
    process.exit(1);
  }

  try {
    await sendTelegramMessage(owner.chat_id, '[DRY-RUN sample] per-user results DM\n\n' + userText);
    console.log('✅ Per-user results DM delivered');
  } catch (err) {
    console.error(`❌ results send failed: ${err}`);
    process.exit(1);
  }

  try {
    await sendTelegramMessage(owner.chat_id, '[DRY-RUN sample] owner summary DM\n\n' + summaryText);
    console.log('✅ Owner summary DM delivered');
  } catch (err) {
    console.error(`❌ summary send failed: ${err}`);
    process.exit(1);
  }

  console.log(`\n💡 Report used: ${reportPath}`);
}

main().catch((err) => {
  console.error(`❌ Unhandled error: ${err}`);
  process.exit(1);
});
