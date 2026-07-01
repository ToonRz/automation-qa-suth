// src/server/bot.ts
// Telegram bot entry point. Long-polling — no domain/HTTPS required.
// Commands:
//
//   /start   — show registered accounts + commands
//   /add     — multi-step wizard to add a new account to the user
//   /book    — queue booking for next 12:00 (default: book ALL of user's accounts)
//   /cancel  — clear pending booking
//   /status  — show last run result for this user
//   /help    — show commands
//
// On launch, the bot also starts the noon scheduler (src/server/scheduler.ts).
// When the scheduler fires, it calls back into the bot to DM each user with
// results.

import { Telegraf, Context } from 'telegraf';
import type { Update } from 'telegraf/typings/core/types/typegram';
import * as dotenv from 'dotenv';
import * as cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';

// Force IPv4 for all outgoing Telegram API calls.
//
// Why: api.telegram.org returns both A and AAAA records. From this network
// the IPv6 path hangs (TCP SYN never completes), so telegraf's long-poll
// request sits there forever and no updates are ever received. Verified:
//   curl -4 getMe  → 200 in ~600ms
//   curl -6 getMe  → timeout 5s
//
// Pinning to IPv4 first makes long-polling work reliably. Apply this before
// constructing the Telegraf instance so its internal http agent resolves the
// same way.
dns.setDefaultResultOrder('ipv4first');
import {
  getUserByChatId,
  getOwner,
  getAllUsers,
  markPending,
  setLastResult,
  addAccountToUser,
  AccountResult,
} from './userStore';
import { runWithPrewarm, runStandard, runWithDeepPrewarm, EngineResult } from './bookingEngine';
import { sendTelegramMessage } from './telegramSend';

dotenv.config();

// Also write to a log file — ts-node buffers stdout when not a TTY,
// which hides the "Bot started" line and any handler errors. The file
// flushes synchronously so we can always see what the bot is doing.
const LOG_PATH = process.env.BOT_LOG_PATH ?? path.resolve(__dirname, '..', '..', 'bot.log');
// Truncate previous run's log on start
try {
  fs.writeFileSync(LOG_PATH, '');
} catch {
  /* ignore */
}
function logToFile(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(stamped);
  try {
    fs.appendFileSync(LOG_PATH, stamped);
  } catch {
    /* ignore log write errors */
  }
}
// Redirect all console.* through our logger so we don't miss anything.
console.log = (...args) => logToFile(args.map(String).join(' '));
console.warn = (...args) => logToFile('[WARN] ' + args.map(String).join(' '));
console.error = (...args) => logToFile('[ERROR] ' + args.map(String).join(' '));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill in.');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);

function nextNoon(from = new Date()): Date {
  let target = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12, 0, 0, 0);
  if (target.getTime() <= from.getTime()) {
    target = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + 1,
      12,
      0,
      0,
      0
    );
  }
  return target;
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (h > 0) return `${h} ชม. ${m} นาที`;
  if (m > 0) return `${m} นาที ${s} วิ`;
  return `${s} วิ`;
}

function formatAccountList(user: ReturnType<typeof getUserByChatId>): string {
  if (!user) return '';
  return user.accounts
    .map((a, i) => `  ${i + 1}. ${a.username} → ${a.court} ${a.slot}`)
    .join('\n');
}

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

// ---- /add wizard (multi-step account registration) ----

// Courts available in the booking dropdown. Tennis is excluded per requirement.
const COURTS_AVAILABLE = [
  'แบดมินตัน1',
  'แบดมินตัน2',
  'แบดมินตัน3',
  'แบดมินตัน4',
  'ฟุตซอล',
  'บาสเก็ตบอล',
  'วอลเลย์บอล',
  // เทนนิส — excluded per requirement
];

// Slots available in the booking dropdown. User can select by number (1-7)
// or type the slot string directly.
const SLOTS_AVAILABLE = [
  '16:00_17:00',
  '17:00_18:00',
  '18:00_19:00',
  '19:00_20:00',
  '20:00_21:00',
  '21:00_22:00',
  '22:00_23:00',
];

const PASSWORD_DELETE_MS = 60_000;

interface AddWizardState {
  step: 'username' | 'password' | 'court' | 'slot' | 'confirm';
  username?: string;
  password?: string;
  court?: string;
  slot?: string;
  startedAt: number;
}

const addWizards = new Map<number, AddWizardState>();

/** Drives a chat through the /add wizard. Caller must guarantee an active
 *  wizard state exists for `chatId`. Returns nothing — all output is via
 *  ctx.reply. We take chatId explicitly because `ctx.chat` is typed as
 *  optional on telegraf's base Context, and the wizard is invoked from the
 *  text handler where chat is guaranteed non-null. */
async function handleAddWizardStep(
  ctx: Context,
  chatId: number,
  text: string,
  user: ReturnType<typeof getUserByChatId>
): Promise<void> {
  if (!user) {
    addWizards.delete(chatId);
    return;
  }
  const wiz = addWizards.get(chatId);
  if (!wiz) return;

  async function reply(text: string): Promise<void> {
    try {
      const m = await ctx.reply(text);
      console.log(`[wizard] → reply ok msg_id=${m.message_id} (${text.length} chars)`);
    } catch (err) {
      console.error(`[wizard] → reply FAILED: ${err}`);
    }
  }

  const cancelRe = /^\/?(cancel|ยกเลิก)$/i;
  const confirmRe = /^(y|yes|ใช่|ยืนยัน)$/i;

  // /cancel works at every step.
  if (cancelRe.test(text)) {
    addWizards.delete(chatId);
    await reply('❌ ยกเลิกการเพิ่ม account แล้ว');
    return;
  }

  switch (wiz.step) {
    case 'username': {
      const username = text.trim();
      if (!username) {
        await reply('⚠️ username ว่าง กรุณาส่ง username อีกครั้ง\nส่ง /cancel เพื่อยกเลิก');
        return;
      }
      if (user.accounts.some((a) => a.username === username)) {
        await reply(`⚠️ คุณมี account "${username}" อยู่แล้ว กรุณาส่ง username อื่น\nส่ง /cancel เพื่อยกเลิก`);
        return;
      }
      wiz.username = username;
      wiz.step = 'password';
      await reply(
        `✓ username: ${username}\n\n` +
          'ขั้นที่ 2/5: ส่ง password\n' +
          `⚠️ ข้อความ password จะถูกลบอัตโนมัติภายใน ${PASSWORD_DELETE_MS / 1000} วินาที\n` +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'password': {
      if (!text) {
        await reply('⚠️ password ว่าง กรุณาส่ง password อีกครั้ง\nส่ง /cancel เพื่อยกเลิก');
        return;
      }
      wiz.password = text;
      // Schedule auto-delete of the user's password message.
      const userMsgId = ctx.message?.message_id;
      if (userMsgId) {
        setTimeout(() => {
          ctx.telegram
            .deleteMessage(chatId, userMsgId)
            .catch((err) =>
              console.warn(`[wizard] failed to delete password msg ${userMsgId}: ${err}`)
            );
        }, PASSWORD_DELETE_MS);
      }
      wiz.step = 'court';
      const courtList = COURTS_AVAILABLE.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
      await reply(
        '✓ password: ********\n\n' +
          'ขั้นที่ 3/5: เลือกสนาม (ส่งหมายเลขหรือชื่อสนาม):\n' +
          courtList +
          '\n\nส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'court': {
      const input = text.trim();
      let court: string | undefined;
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= COURTS_AVAILABLE.length) {
        court = COURTS_AVAILABLE[num - 1];
      } else if (COURTS_AVAILABLE.includes(input)) {
        court = input;
      } else {
        await reply(
          `⚠️ ไม่รู้จักสนาม "${input}"\n\n` +
            `ส่งหมายเลข (1-${COURTS_AVAILABLE.length}) หรือชื่อสนาม:\n` +
            COURTS_AVAILABLE.map((c, i) => `  ${i + 1}. ${c}`).join('\n') +
            '\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      wiz.court = court;
      wiz.step = 'slot';
      const slotList = SLOTS_AVAILABLE.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
      await reply(
        `✓ court: ${court}\n\n` +
          'ขั้นที่ 4/5: เลือก slot (ส่งหมายเลขหรือชื่อ slot):\n' +
          slotList +
          '\n\nส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'slot': {
      const input = text.trim();
      let slot: string | undefined;
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= SLOTS_AVAILABLE.length) {
        slot = SLOTS_AVAILABLE[num - 1];
      } else if (SLOTS_AVAILABLE.includes(input)) {
        slot = input;
      } else {
        await reply(
          `⚠️ ไม่รู้จัก slot "${input}"\n\n` +
            `ส่งหมายเลข (1-${SLOTS_AVAILABLE.length}) หรือชื่อ slot:\n` +
            SLOTS_AVAILABLE.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
            '\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      wiz.slot = slot;
      wiz.step = 'confirm';
      await reply(
        '📋 สรุป account ใหม่:\n\n' +
          `username: ${wiz.username}\n` +
          `password: ********\n` +
          `court: ${wiz.court}\n` +
          `slot: ${wiz.slot}\n\n` +
          'ขั้นที่ 5/5: ยืนยันเพิ่ม? (ส่ง y/yes/ใช่ เพื่อยืนยัน, อย่างอื่นถือว่ายกเลิก)\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'confirm': {
      if (confirmRe.test(text)) {
        try {
          addAccountToUser(chatId, {
            username: wiz.username!,
            password: wiz.password!,
            court: wiz.court!,
            slot: wiz.slot!,
          });
          addWizards.delete(chatId);
          await reply(
            '✅ เพิ่ม account สำเร็จ!\n\n' +
              `${wiz.username} → ${wiz.court} ${wiz.slot}\n\n` +
              'พิมพ์ /start เพื่อดู accounts ทั้งหมด'
          );
          console.log(`[wizard] added account "${wiz.username}" for chat=${chatId}`);
        } catch (err) {
          addWizards.delete(chatId);
          await reply(`❌ เกิดข้อผิดพลาด: ${err}`);
        }
      } else {
        addWizards.delete(chatId);
        await reply('❌ ยกเลิกการเพิ่ม account แล้ว');
      }
      return;
    }
  }
}

// ---- Handlers ----

// Global catch — log any unhandled errors so they're visible in journalctl.
bot.catch((err, ctx) => {
  console.error(`[bot] handler error for ${ctx?.update?.update_id ?? '?'}:`, err);
});

// Single text handler that dispatches by command. We do this in `bot.on('text')`
// rather than using `bot.start` / `bot.command(...)` because, in telegraf 4.x,
// the bot.start / bot.command handlers did not fire for this bot in our setup
// (verified empirically — handlers were registered, but messages routed only
// through bot.on('text')). Routing all commands through one handler eliminates
// the dependency on telegraf's command dispatching and makes the bot work
// reliably.
bot.on('text', async (ctx) => {
  const text = (ctx.message?.text ?? '').trim();
  const cmd = text.split(/\s+/)[0]?.toLowerCase() ?? '';
  console.log(`[bot] cmd="${cmd}" chat=${ctx.chat.id}`);

  const user = getUserByChatId(ctx.chat.id);

  // /add wizard takes precedence over the command switch while active for
  // this chat. Plain-text messages from a chat that is mid-wizard flow into
  // the wizard step instead of hitting the default case.
  if (user && addWizards.has(ctx.chat.id)) {
    await handleAddWizardStep(ctx, ctx.chat.id, text, user);
    return;
  }

  // Reply wrapper — sends and logs the message_id so we can prove the reply
  // actually hit Telegram (not just that the handler ran).
  async function reply(text: string): Promise<void> {
    try {
      const m = await ctx.reply(text);
      console.log(`[bot] → reply ok msg_id=${m.message_id} (${text.length} chars)`);
    } catch (err) {
      console.error(`[bot] → reply FAILED: ${err}`);
    }
  }

  switch (cmd) {
    case '/start': {
      if (!user) {
        await reply(
          '❌ คุณไม่ได้ลงทะเบียนในระบบ\n\n' +
            'กรุณาส่ง telegram_id ของคุณให้เจ้าของบอท ' +
            'เพื่อเพิ่มใน config/users.json'
        );
        return;
      }
      await reply(
        `สวัสดี ${user.display_name}! 👋\n\n` +
          `คุณมี ${user.accounts.length} account ลงทะเบียนไว้:\n` +
          `${formatAccountList(user)}\n\n` +
          `➕ /add    → เพิ่ม account ใหม่\n` +
          `📅 /book  → จองทั้งหมดรอบ 12:00 ถัดไป\n` +
          `❌ /cancel → ยกเลิกการจอง\n` +
          `📊 /status → ดูผลล่าสุด\n` +
          `ℹ️  /help  → คำสั่งทั้งหมด`
      );
      return;
    }

    case '/help': {
      await reply(
        'คำสั่งทั้งหมด:\n\n' +
          '/start  — ดู account ที่ลงทะเบียน\n' +
          '/add    — เพิ่ม account ใหม่ (5 ขั้น)\n' +
          '/book   — จองรอบ 12:00 ถัดไป (ทั้งหมด)\n' +
          '/cancel — ยกเลิกการจองที่จองค้างไว้\n' +
          '/status — ดูผลล่าสุด\n' +
          '/help   — คำสั่งนี้\n\n' +
          'หลัง /book บอทจะรอจนถึง 12:00 น. แล้วจองให้อัตโนมัติ\n' +
          'ผลจะถูกส่งกลับมาที่แชทนี้'
      );
      return;
    }

    case '/book': {
      if (!user) {
        await reply('❌ คุณไม่ได้ลงทะเบียน กรุณาติดต่อเจ้าของบอท');
        return;
      }
      if (user.accounts.length === 0) {
        await reply('⚠️  คุณไม่มี account ลงทะเบียน');
        return;
      }
      markPending(ctx.chat.id, true);
      const target = nextNoon();
      const diff = target.getTime() - Date.now();
      await reply(
        `⏰ รับคำขอแล้ว!\n\n` +
          `จะจอง ${user.accounts.length} account ตอน ${target.toLocaleTimeString('th-TH')} น.\n` +
          `อีก ${formatDuration(diff)}\n\n` +
          `ผลจะส่งกลับอัตโนมัติ`
      );
      return;
    }

    case '/cancel': {
      if (!user) {
        await reply('❌ คุณไม่ได้ลงทะเบียน');
        return;
      }
      if (!user.pending_booking) {
        await reply('ℹ️  ไม่มีการจองค้างอยู่');
        return;
      }
      markPending(ctx.chat.id, false);
      await reply('❌ ยกเลิกการจองแล้ว');
      return;
    }

    case '/status': {
      if (!user) {
        await reply('❌ คุณไม่ได้ลงทะเบียน');
        return;
      }
      if (!user.last_result) {
        await reply('ℹ️  ยังไม่เคยจอง — พิมพ์ /book เพื่อจอง');
        return;
      }
      const r = user.last_result;
      const lines: string[] = [
        `📊 ผลล่าสุด — ${user.display_name}`,
        `เมื่อ: ${new Date(r.triggered_at).toLocaleString('th-TH')}`,
        '',
      ];
      for (const a of r.accounts) {
        const tag = a.status === 'PASS' ? '✅' : a.status === 'DRY-RUN' ? '◉' : '❌';
        const detail = a.status === 'PASS' ? `${a.court_booked ?? a.court} ${a.slot}` : a.fail_reason ?? a.status;
        lines.push(`${tag} ${a.username}  ${detail}`);
      }
      await reply(lines.join('\n'));
      return;
    }

    case '/add': {
      if (!user) {
        await reply('❌ คุณไม่ได้ลงทะเบียน กรุณาติดต่อเจ้าของบอท');
        return;
      }
      if (user.role !== 'owner' && user.role !== 'friend') {
        await reply('❌ คุณไม่มีสิทธิ์เพิ่ม account');
        return;
      }
      if (addWizards.has(ctx.chat.id)) {
        await reply('⚠️ คุณอยู่ในขั้นตอน /add อยู่แล้ว — ส่ง /cancel เพื่อเริ่มใหม่');
        return;
      }
      addWizards.set(ctx.chat.id, { step: 'username', startedAt: Date.now() });
      await reply(
        '➕ เพิ่ม account ใหม่\n\n' +
          'ขั้นที่ 1/5: ส่ง username (เลขประจำตัวผู้ใช้ของสนาม)\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    default: {
      await reply(
        `🤔 ไม่รู้จักคำสั่ง "${cmd}"\n\nพิมพ์ /help ดูคำสั่งทั้งหมด`
      );
      return;
    }
  }
});

// ---- Scheduler wiring ----

/** Map bookingEngine results to the lighter AccountResult shape for storage/Telegram. */
function toAccountResults(engine: EngineResult): AccountResult[] {
  return engine.results.map((r) => ({
    username: r.username,
    court: r.court_attempted,
    slot: r.slot,
    status: r.status,
    fail_reason: r.fail_reason,
    court_booked: r.court_booked,
    duration_ms: r.duration_ms,
  }));
}

interface ScheduledRun {
  user: { chat_id: number; display_name: string };
  accounts: AccountResult[];
  totalMs: number;
  mode: 'prewarm' | 'standard';
}

/** DM the owner that the pre-warm window has opened. Fire-and-forget —
 *  failure is logged but must never block the booking run or crash the bot
 *  process.
 *  Per user spec: sent to the owner only (role='owner'), never to friends.
 *
 *  Times and lead duration in the message are derived from `fireTime` (the
 *  planned noon tick) and `cronFireAt` (the actual cron-fire time), so the
 *  message stays accurate if the cron expression in main() changes. */
async function sendPrewarmNoticeToOwner(
  fireTime: Date,
  cronFireAt: Date
): Promise<void> {
  // Whole body inside try — anything that throws synchronously (malformed
  // users.json → getOwner() throws SyntaxError, etc.) must not become an
  // unhandled rejection, since the caller uses `void` (fire-and-forget).
  try {
    const owner = getOwner();
    if (!owner) {
      console.log('[cron] no owner registered — skipping prewarm notice');
      return;
    }
    if (owner.accounts.length === 0) {
      // Skip — booking loop below won't run for an owner with no accounts,
      // so sending "จะจองตอน ..." would be a misleading promise.
      console.log(`[cron] owner ${owner.display_name} has 0 accounts — skipping prewarm notice`);
      return;
    }

    // Group accounts by court, then sort each group by slot for stable display.
    const byCourt = new Map<string, typeof owner.accounts>();
    for (const acc of owner.accounts) {
      const list = byCourt.get(acc.court) ?? [];
      list.push(acc);
      byCourt.set(acc.court, list);
    }
    for (const list of byCourt.values()) {
      list.sort((a, b) => a.slot.localeCompare(b.slot));
    }

    const fmtTime = (d: Date): string => d.toTimeString().slice(0, 8);
    const fmtSlot = (s: string): string => s.replace('_', '-');
    const leadMin = Math.round(
      (fireTime.getTime() - cronFireAt.getTime()) / 60_000
    );

    const lines: string[] = [];
    lines.push(`⏰ ตื่นแล้ว! Pre-warm เริ่ม ${fmtTime(cronFireAt)}`);
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push('');
    lines.push(`📅 จะจองตอน ${fmtTime(fireTime)} น.`);
    lines.push(`👤 ${owner.display_name} · ${owner.accounts.length} accounts`);
    lines.push(`⏳ เหลืออีก ${leadMin} นาที`);
    lines.push('');
    lines.push(`🎯 แผนจอง:`);
    for (const [court, accounts] of byCourt) {
      lines.push(`   🏸 ${court} (${accounts.length} คิว)`);
      for (const acc of accounts) {
        lines.push(`      • ${acc.username} · ${fmtSlot(acc.slot)}`);
      }
    }
    lines.push('');
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`🛠  [Login → เลือก court → เลือก slot → ยืนยัน]`);
    const text = lines.join('\n');

    await sendTelegramMessage(owner.chat_id, text);
    console.log(`[cron] prewarm notice sent to owner (${owner.display_name})`);
  } catch (err) {
    console.warn(`[cron] prewarm notice failed: ${err}`);
  }
}

async function runScheduledBooking(): Promise<void> {
  // Cron fires at 11:55 (5-min lead) so runWithDeepPrewarm has time to login +
  // pre-select court/slot before the noon tick. fireTime is the PLANNED noon,
  // not "now" — the engine computes prewarmFireAt = fireTime - PREWARM_LEAD_MS.
  // (Was `fireTime = new Date()`, which made prewarmFireAt land in the past at
  // cron callback, defeating the 5-min prewarm window.)
  const fireTime = nextNoon();
  console.log(
    `\n[scheduler] cron fired at ${new Date().toISOString()}, ` +
      `firing at ${fireTime.toISOString()} ` +
      `(prewarm window opens at ${new Date(fireTime.getTime() - 5 * 60_000).toISOString()})`
  );

  // Notify the owner that the pre-warm window has opened. Fire-and-forget:
  // we don't await this in the main path because the booking work should
  // start immediately. The helper internally logs and swallows ALL errors
  // (sync throws from getOwner() AND async throws from sendTelegramMessage)
  // so this can never become an unhandled rejection.
  // `new Date()` is the actual cron-fire moment, used by the helper to derive
  // the lead duration in the message — keeps the message accurate even if the
  // cron expression in main() changes.
  void sendPrewarmNoticeToOwner(fireTime, new Date());

  // Collect: owner always runs at noon. Friends run only if they sent /book.
  const owner = getOwner();
  const pendingFriends = getAllUsers().filter(
    (u) => u.role === 'friend' && u.pending_booking
  );

  const tasks: { user: typeof owner; run: () => Promise<EngineResult> }[] = [];
  if (owner && owner.accounts.length > 0) {
    // DEEP_PREWARM=1 upgrades owner task to deep-prewarm (login + court/slot
    // pre-selected at T-5min, confirm click at noon). Default is shallow
    // prewarm — preserves the proven 6/9 baseline. One env var to roll back.
    const useDeep = process.env.DEEP_PREWARM === '1';
    tasks.push({
      user: owner,
      run: () =>
        useDeep
          ? runWithDeepPrewarm(owner!.accounts, fireTime)
          : runWithPrewarm(owner!.accounts, fireTime),
    });
  }
  for (const friend of pendingFriends) {
    if (friend.accounts.length === 0) continue;
    tasks.push({ user: friend, run: () => runStandard(friend.accounts) });
  }

  if (tasks.length === 0) {
    console.log('[scheduler] no users to book — nothing to do');
    return;
  }

  // Run all user-groups sequentially (each group uses its own browser via the engine).
  // Running groups in parallel would multiply the browser count and risk rate-limiting.
  const runs: ScheduledRun[] = [];
  for (const task of tasks) {
    if (!task.user) continue;
    try {
      const engine = await task.run();
      const accts = toAccountResults(engine);
      setLastResult(task.user.chat_id, { triggered_at: fireTime.toISOString(), accounts: accts });
      runs.push({
        user: { chat_id: task.user.chat_id, display_name: task.user.display_name },
        accounts: accts,
        totalMs: engine.total_ms,
        mode: engine.mode,
      });
      // DM the user their results
      try {
        await sendTelegramMessage(
          task.user.chat_id,
          formatResultsForUser(task.user.display_name, accts, engine.mode, engine.total_ms)
        );
      } catch (err) {
        console.warn(`[scheduler] failed to DM ${task.user.display_name}: ${err}`);
      }
    } catch (err) {
      console.error(`[scheduler] booking failed for ${task.user.display_name}: ${err}`);
      try {
        await sendTelegramMessage(
          task.user.chat_id,
          `❌ เกิดข้อผิดพลาดระหว่างจอง: ${err}`
        );
      } catch {
        /* ignore */
      }
    }
  }

  // DM owner with cross-user summary (in addition to their own results above).
  if (owner) {
    try {
      await sendTelegramMessage(
        owner.chat_id,
        formatSummaryForOwner(
          runs.map((r) => ({ user: r.user.display_name, accounts: r.accounts }))
        )
      );
    } catch (err) {
      console.warn(`[scheduler] failed to DM owner summary: ${err}`);
    }
  }
}

// ---- Launch ----

async function main() {
  console.log('=== Court Booking Bot ===');
  console.log(`Telegram token: ${TOKEN!.slice(0, 10)}...`);
  console.log(`Registered users: ${getAllUsers().length}`);

  // Eager reachability check — fail fast with a useful message if the bot
  // can't talk to Telegram from this host (e.g. IPv6-only paths blocked).
  try {
    const me = await bot.telegram.getMe();
    console.log(`✓ Telegram reachable as @${me.username} (id=${me.id})`);
  } catch (err) {
    console.error('✗ Telegram getMe failed (network? IPv6 vs IPv4?):', err);
    process.exit(1);
  }

  // Schedule noon trigger (local time, every day).
  // node-cron uses local time by default. We want 12:00 local — set
  // TZ=Asia/Bangkok in .env so the cron fires on Thai noon.
  // Cron wakes at 11:55 (5-min lead) so the deep-prewarm engine has time to
  // login + pre-select court/slot before the noon tick. See runScheduledBooking.
  // Limitation: if the bot restarts between 11:55 and 12:00, today's prewarm
  // window is missed (cron already fired). Mitigation: keep restart MTTR low.
  cron.schedule('55 11 * * *', () => {
    console.log('[cron] noon trigger (prewarm window opened)');
    runScheduledBooking().catch((err) => console.error(`[cron] run failed: ${err}`));
  });
  console.log('✓ Noon cron scheduled (11:55 daily, fires at 12:00)');

  // Graceful shutdown — our custom poll loop doesn't need bot.stop() (it just
  // exits on signal), but we still wire the handler so the process can be
  // killed by systemd / Ctrl-C cleanly.
  let shuttingDown = false;
  const onSignal = (sig: string) => () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[main] received ${sig}, exiting`);
    process.exit(0);
  };
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('SIGTERM', onSignal('SIGTERM'));

  // bot.launch() in telegraf 4.x hangs on long-poll (we observed: it opens
  // a polling socket that monopolises the http.Agent, so even outbound
  // sendMessage calls queue behind it for 30+ seconds, and after the first
  // batch the polling loop stops re-issuing getUpdates). Workaround: bypass
  // telegraf's startPolling entirely and feed updates into the public
  // bot.handleUpdate() ourselves via raw fetch.
  console.log('Starting bot (custom long-poll loop)...');
  startPollingLoop().catch((err) => console.error('[poll] fatal:', err));

  // Keep the process alive.
  await new Promise<void>(() => {
    /* never resolves — runs until SIGINT/SIGTERM */
  });
}

/** Custom long-polling loop using fetch.
 *
 * Why not bot.launch(): telegraf 4.x's built-in polling in this environment
 *   - sometimes drains the first batch then never re-polls,
 *   - and even when it does poll, shares its http.Agent with outbound
 *     sendMessage, blocking our own DM replies for ~30s each.
 *
 * Instead: call getUpdates with our own fetch, parse JSON, and feed each
 * update through bot.handleUpdate — which routes through all our `bot.on(...)`
 * handlers exactly as if telegraf had received it.
 */
async function startPollingLoop(): Promise<void> {
  const apiBase = `https://api.telegram.org/bot${TOKEN}`;
  let offset = 0;
  // Backoff state for transient errors
  let errorBackoffMs = 1000;
  // Sanity log: prove the loop is alive once a minute
  let lastHeartbeat = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const url = `${apiBase}/getUpdates?timeout=25&offset=${offset}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`getUpdates HTTP ${res.status}`);
      }
      const text = await res.text();
      const data = JSON.parse(text) as {
        ok: boolean;
        result?: Update[];
        description?: string;
      };
      if (!data.ok) {
        throw new Error(`getUpdates !ok: ${data.description ?? 'unknown'}`);
      }
      errorBackoffMs = 1000; // reset on success
      const updates = data.result ?? [];
      if (updates.length > 0) {
        // Log only non-empty cycles — keeps journalctl quiet during idle periods
        // but tells us exactly when a message arrived.
        console.log(`[poll] received ${updates.length} update(s)`);
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          // bot.handleUpdate is the public API to inject an update.
          await bot.handleUpdate(update);
        } catch (err) {
          console.error(`[poll] handleUpdate failed for ${update.update_id}:`, err);
        }
      }
      // Heartbeat: log every minute even if idle so we can prove the loop is alive.
      const now = Date.now();
      if (now - lastHeartbeat > 60_000) {
        console.log(`[poll] heartbeat (offset=${offset})`);
        lastHeartbeat = now;
      }
    } catch (err) {
      // Surface the underlying cause (undici often hides it behind "fetch failed").
      const e = err as Error & { cause?: { code?: string; message?: string; errors?: unknown[] } };
      const cause = e.cause;
      const detail = cause
        ? ` cause=${cause.code ?? '?'} "${cause.message ?? ''}" errors=${JSON.stringify(cause.errors ?? [])}`
        : '';
      console.error(`[poll] error: ${err}${detail}. Backing off ${errorBackoffMs}ms`);
      await new Promise<void>((r) => setTimeout(r, errorBackoffMs));
      errorBackoffMs = Math.min(errorBackoffMs * 2, 30_000);
    }
  }
}

main().catch((err) => {
  console.error(`❌ Bot failed to start: ${err}`);
  process.exit(1);
});
