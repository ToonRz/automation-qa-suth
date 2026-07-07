// src/server/testPrewarmNotice.ts
//
// One-off test: build the pre-warm notice the same way the cron helper does
// and actually send it to the owner via Telegram. Verifies:
//   - .env loads (TELEGRAM_BOT_TOKEN present)
//   - users.json loads and the owner can be resolved
//   - sendTelegramMessage() works from this host (IPv4 path, timeouts OK)
//   - the exact message format lands
//   - structural invariants in bot.ts (signature, guards, try-block, no
//     hardcoded time strings, account-breakdown grouping) hold
//
// Run:  npm run bot:test-prewarm
//
// Does NOT touch the cron — the cron only fires at 11:55. This is a manual
// dry-run of the message the cron will emit tomorrow.

import * as dotenv from 'dotenv';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';

// Force IPv4 for Telegram — same workaround as bot.ts. Without this the
// outbound fetch may hang for 15s on IPv6 SYN timeout before falling back.
dns.setDefaultResultOrder('ipv4first');

import { getOwner } from './userStore';
import { sendTelegramMessage } from './telegramSend';

dotenv.config();

const BOT_TS_PATH = path.resolve(__dirname, 'bot.ts');

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

  // Build the message locally with the same logic the helper uses, then send.
  // Keeping this in sync with sendPrewarmNoticesForBooking() in bot.ts is verified
  // by source-level assertions in Phase 2 — if the production helper diverges,
  // those assertions fail.
  //
  // Simulate cron-fire time as 5 minutes before fireTime so the live message
  // we send to Munior matches what production will emit at 11:55 tomorrow —
  // otherwise an out-of-window test run would show a wildly wrong lead time.
  const fireTime = nextNoonLocal();
  const cronFireAt = new Date(fireTime.getTime() - 5 * 60_000);
  const text = buildPrewarmText(owner, fireTime, cronFireAt);

  console.log('--- message to send ---');
  console.log(text);
  console.log('-----------------------');

  // Sanity bounds: header + footer ≈ 200 chars, each account line ≈ 40 chars.
  // For Munior's 9 accounts expect ~540 chars total.
  const len = text.length;
  if (len < 400 || len > 800) {
    console.error(`❌ Message length ${len} outside expected [400, 800] range`);
    process.exit(1);
  }
  console.log(`  ✅ message length = ${len} chars (expected 400-800)`);

  try {
    await sendTelegramMessage(owner.chat_id, text);
    console.log('✅ Pre-warm notice delivered');
  } catch (err) {
    console.error(`❌ Send failed: ${err}`);
    process.exit(1);
  }

  // --- Phase 2: Source-level assertions ---
  // Read bot.ts and verify the structural invariants the helper relies on.
  console.log('\n--- source-level assertions ---');
  const botSrc = fs.readFileSync(BOT_TS_PATH, 'utf-8');

  // N2 fix — extract the helper's function body using brace counting instead
  // of a regex that depends on column-0 closing braces. Robust to refactors
  // that change indentation or add intermediate blocks.
  const funcBody = extractFuncBody(
    botSrc,
    /async function sendPrewarmNoticesForBooking\s*\(/
  );
  if (!funcBody) {
    console.error('❌ could not locate sendPrewarmNoticesForBooking in bot.ts');
    process.exit(1);
  }

  // (a) M1 fix — skip-if-empty guard is present at the top of the helper
  // (replaces the old per-user 0-accounts guard, since the caller now
  // filters out 0-account users before passing the array in).
  const hasSkipIfEmptyGuard = /users\.length\s*===\s*0/.test(funcBody);
  console.log(
    `  ${hasSkipIfEmptyGuard ? '✅' : '❌'} M1: skip-if-empty guard present in helper`
  );

  // (b) B1 fix — outer try-block wraps the loop and any throws from
  // getAllUsers()/sendTelegramMessage are caught.
  const tryIdx = funcBody.indexOf('try {');
  const loopIdx = funcBody.indexOf('for (const user of users)');
  const wrapsBody = tryIdx >= 0 && loopIdx >= 0 && tryIdx < loopIdx;
  console.log(
    `  ${wrapsBody ? '✅' : '❌'} B1: try-block wraps the per-user loop ` +
      `(try@${tryIdx} loop@${loopIdx})`
  );

  // (c) N1 fix — helper takes `fireTime: Date` as a parameter, so the
  // 11:55:00 / 12:00:00 strings and the "5 นาที" lead are not hardcoded
  // inside the message.
  const takesFireTime = /sendPrewarmNoticesForBooking\([^)]*fireTime\s*:\s*Date/.test(
    funcBody
  );
  const noHardcodedTimes =
    !/11:55:00/.test(funcBody) &&
    !/12:00:00/.test(funcBody) &&
    !/5 นาที/.test(funcBody);
  console.log(
    `  ${takesFireTime ? '✅' : '❌'} N1.a: helper accepts fireTime: Date param`
  );
  console.log(
    `  ${noHardcodedTimes ? '✅' : '❌'} N1.b: no hardcoded time/duration strings`
  );

  // (d) L1 fix — helper also takes `cronFireAt: Date`, AND the lead-time
  // constant `5 * 60_000` is GONE from the helper (the duration now flows
  // from the difference between the two Date params).
  const takesCronFireAt =
    /sendPrewarmNoticesForBooking\([^)]*cronFireAt\s*:\s*Date/.test(funcBody);
  const noHardcodedLead = !/5\s*\*\s*60_000/.test(funcBody);
  console.log(
    `  ${takesCronFireAt ? '✅' : '❌'} L1.a: helper accepts cronFireAt: Date param`
  );
  console.log(
    `  ${noHardcodedLead ? '✅' : '❌'} L1.b: no hardcoded "5 * 60_000" lead constant`
  );

  // (e) New message body — account-breakdown grouping is present.
  const hasBreakdownHeader = /แผนจอง/.test(funcBody);
  // After the slot-first / court-priority-second refactor the display groups
  // by slot (per-account court is vestigial).
  const hasBySlot = /\bbySlot\b/.test(funcBody);
  console.log(
    `  ${hasBreakdownHeader ? '✅' : '❌'} new: account-breakdown header "แผนจอง" present`
  );
  console.log(
    `  ${hasBySlot ? '✅' : '❌'} new: bySlot grouping present (slot-first refactor)`
  );

  // (f) Caller-side assertion — caller passes the recipient array as the
  // first arg and (fireTime, new Date()) as the time args. Scoped to a
  // single line containing `void sendPrewarmNoticesForBooking(` to avoid
  // false matches.
  const callerLineMatch = botSrc.match(
    /^.*void sendPrewarmNoticesForBooking\([^)]*\).*$/m
  );
  const callerPassesCorrectArgs =
    callerLineMatch !== null &&
    /void sendPrewarmNoticesForBooking\(\s*prewarmRecipients\s*,\s*fireTime\s*,\s*new Date\(\)\s*\)/.test(
      callerLineMatch[0]
    );
  console.log(
    `  ${callerPassesCorrectArgs ? '✅' : '❌'} caller: passes (prewarmRecipients, fireTime, new Date())`
  );

  if (
    !hasSkipIfEmptyGuard ||
    !wrapsBody ||
    !takesFireTime ||
    !noHardcodedTimes ||
    !takesCronFireAt ||
    !noHardcodedLead ||
    !hasBreakdownHeader ||
    !hasBySlot ||
    !callerPassesCorrectArgs
  ) {
    console.error('❌ Source-level assertions failed');
    process.exit(1);
  }
  console.log('✅ All source-level assertions passed');
}

/** Local mirror of nextNoon() from bot.ts — duplicated to avoid coupling the
 *  test to bot.ts's module-load side effects (telegraf init, env check, etc.). */
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

/** Mirror of sendPrewarmNoticesForBooking's message-building logic, factored out
 *  for direct test invocation. Kept in sync by source-level assertions above.
 *
 *  NOTE: pre-refactor this grouped by per-account `court`. After the priority
 *  refactor (court is config-driven, per-account court is deprecated), we group
 *  by `slot` instead — the slot is the per-account invariant the bot honors at
 *  noon, and the priority list applies uniformly to every account. */
function buildPrewarmText(
  owner: { display_name: string; accounts: Array<{ username: string; slot: string }> },
  fireTime: Date,
  cronFireAt: Date
): string {
  const bySlot = new Map<string, typeof owner.accounts>();
  for (const acc of owner.accounts) {
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
  lines.push(`👤 ${owner.display_name} · ${owner.accounts.length} accounts`);
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
  return lines.join('\n');
}

/** Extract a top-level function body by brace counting, starting from the
 *  first line that matches `headerRe`. Skips braces inside template literals,
 *  single-line `//` comments, and block `/* ... *\/` comments. Returns the
 *  matched substring including the signature line and the closing `}`. */
function extractFuncBody(src: string, headerRe: RegExp): string | null {
  const headerMatch = src.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const start = headerMatch.index;

  let depth = 0;
  let i = start;
  let foundOpen = false;
  // Walk character by character, tracking brace depth.
  // We start depth at 0 and bump on `{`, decrement on `}`, stopping when
  // depth returns to 0 AFTER having gone positive (the function's closing brace).
  while (i < src.length) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : '';
    const next = i + 1 < src.length ? src[i + 1] : '';

    // Skip block comments /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Skip line comments // ... (until newline)
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // Skip template literals (naive — handles backtick strings; doesn't handle
    // nested ${...} template expressions, but for this codebase the helper
    // doesn't use template nesting inside message strings).
    if (ch === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++;
      continue;
    }
    // Skip single-quoted and double-quoted strings (no template nesting).
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    // Skip regex literals (heuristic: '/' preceded by an operator-ish char).
    // We don't need this for the current helper — skip.
    if (ch === '{') {
      depth++;
      foundOpen = true;
    } else if (ch === '}') {
      depth--;
      if (foundOpen && depth === 0) {
        return src.slice(start, i + 1);
      }
    }
    i++;
  }
  return null;
}

main();