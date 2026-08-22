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
  setCronEnabled,
  isCronEnabled,
  setLastResult,
  addAccountToUser,
  addUser,
  updateAccountInUser,
  AccountResult,
  User,
} from './userStore';
import { runWithPrewarm, runWithDeepPrewarm, EngineResult } from './bookingEngine';
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

// Notify owner when the bot fails to deliver a reply to a user. Fire-and-forget
// so reply paths never block on it. Rate-limited to once per 5 min to avoid
// spam during outages. Best-effort: if Telegram is down, the alert itself
// fails and we log — the file log remains the source of truth.
const ALERT_COOLDOWN_MS = 5 * 60_000;
let lastReplyFailAlertAt = 0;
function alertOwnerAboutReplyFail(tag: string, err: unknown): void {
  const now = Date.now();
  if (now - lastReplyFailAlertAt < ALERT_COOLDOWN_MS) return;
  let owner;
  try {
    owner = getOwner();
  } catch {
    return;
  }
  if (!owner) return;
  const text = `⚠️ bot reply failed (${tag})\n${String(err)}\n${new Date().toISOString()}`;
  bot.telegram
    .sendMessage(owner.chat_id, text)
    .then(() => {
      lastReplyFailAlertAt = Date.now();
    })
    .catch((alertErr) => {
      console.error('[alert] sendMessage to owner FAILED:', alertErr);
    });
}

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

// Courts available in the booking dropdown. Per user spec (2026-07-05):
// only แบดมินตัน1-6 — football/basketball/volleyball were dropped because
// the bot only books badminton. Tennis remains excluded.
const COURTS_AVAILABLE = [
  'แบดมินตัน1',
  'แบดมินตัน2',
  'แบดมินตัน3',
  'แบดมินตัน4',
  'แบดมินตัน5',
  'แบดมินตัน6',
];

// Slots available in the booking dropdown. Per user spec (2026-07-07):
// evening slots plus the 16:30 early slot — only the 22:00 outer slot is
// excluded (22:00 is past curfew / outside operating hours on the site).
const SLOTS_AVAILABLE = [
  '16:30_17:30',
  '17:30_18:30',
  '18:30_19:30',
  '19:30_20:30',
  '20:30_21:30',
  '21:30_22:30',
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

// ---- /user add wizard (owner-only: register a new Telegram user) ----

interface UserAddWizardState {
  step: 'chat_id' | 'display_name' | 'role' | 'confirm';
  chat_id?: number;
  display_name?: string;
  role?: 'owner' | 'friend';
  startedAt: number;
}

const userAddWizards = new Map<number, UserAddWizardState>();

// ---- /useredit wizard (owner + friend: edit court or slot of an existing account) ----

interface UserEditWizardState {
  step: 'pick_account' | 'pick_field' | 'edit_court' | 'edit_slot' | 'confirm';
  username?: string;
  field?: 'court' | 'slot';
  oldCourt?: string;
  oldSlot?: string;
  newCourt?: string;
  newSlot?: string;
  startedAt: number;
}

const userEditWizards = new Map<number, UserEditWizardState>();

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
      alertOwnerAboutReplyFail('wizard', err);
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

// ---- /user add wizard (owner-only) ----
//
// Drives the owner through registering a new Telegram user. Mirrors the
// structure of handleAddWizardStep above so any future maintainer can read
// one and know the other. Returns nothing — all output is via ctx.reply.
async function handleUserAddWizardStep(
  ctx: Context,
  chatId: number,
  text: string,
  owner: ReturnType<typeof getUserByChatId>
): Promise<void> {
  if (!owner || owner.role !== 'owner') {
    // Should never happen — wizard entry is gated by the /user command
    // owner check — but bail safely if state gets corrupted.
    userAddWizards.delete(chatId);
    return;
  }
  const wiz = userAddWizards.get(chatId);
  if (!wiz) return;

  async function reply(text: string): Promise<void> {
    try {
      const m = await ctx.reply(text);
      console.log(`[user-wizard] → reply ok msg_id=${m.message_id} (${text.length} chars)`);
    } catch (err) {
      console.error(`[user-wizard] → reply FAILED: ${err}`);
      alertOwnerAboutReplyFail('user-wizard', err);
    }
  }

  const cancelRe = /^\/?(cancel|ยกเลิก)$/i;
  const confirmRe = /^(y|yes|ใช่|ยืนยัน)$/i;

  if (cancelRe.test(text)) {
    userAddWizards.delete(chatId);
    await reply('❌ ยกเลิกการเพิ่ม user แล้ว');
    return;
  }

  switch (wiz.step) {
    case 'chat_id': {
      const trimmed = text.trim();
      // Allow the owner to forward/reference themselves by typing the literal
      // string "me" — fills chat_id with the owner's own chat_id. Convenient
      // when re-onboarding the owner's own account on a new device.
      let n: number;
      if (trimmed.toLowerCase() === 'me') {
        n = owner.chat_id;
      } else {
        n = parseInt(trimmed, 10);
      }
      if (!Number.isFinite(n) || n <= 0) {
        await reply(
          '⚠️ chat_id ต้องเป็นตัวเลขจำนวนเต็มบวก (หรือส่ง "me" สำหรับ chat_id ของคุณเอง)\n' +
            'ส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      wiz.chat_id = n;
      wiz.step = 'display_name';
      await reply(
        `✓ chat_id: ${n}\n\n` +
          'ขั้นที่ 2/4: ส่ง display_name (ชื่อที่จะแสดงในระบบ)\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'display_name': {
      const name = text.trim();
      if (!name) {
        await reply('⚠️ display_name ว่าง กรุณาส่งชื่ออีกครั้ง\nส่ง /cancel เพื่อยกเลิก');
        return;
      }
      if (name.length > 64) {
        await reply('⚠️ display_name ยาวเกิน 64 ตัวอักษร กรุณาส่งชื่อสั้นกว่านี้');
        return;
      }
      wiz.display_name = name;
      wiz.step = 'role';
      await reply(
        `✓ display_name: ${name}\n\n` +
          'ขั้นที่ 3/4: เลือก role:\n' +
          '  1. friend — ผู้ใช้ทั่วไป (เปิด cron แล้วจะถูกจองอัตโนมัติ หรือส่ง /book รายรอบ)\n' +
          '  2. owner  — เจ้าของบอท (มี owner อยู่แล้วได้แค่คนเดียว)\n\n' +
          'ส่งหมายเลข หรือ คำว่า friend/owner\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'role': {
      const input = text.trim().toLowerCase();
      let role: 'owner' | 'friend' | undefined;
      if (input === '1' || input === 'friend' || input === 'เพื่อน') {
        role = 'friend';
      } else if (input === '2' || input === 'owner' || input === 'เจ้าของ') {
        role = 'owner';
      } else {
        await reply(
          '⚠️ ไม่รู้จัก role "' + text.trim() + '"\n\n' +
            'ส่ง 1/friend/เพื่อน หรือ 2/owner/เจ้าของ\n' +
            'ส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      wiz.role = role;
      wiz.step = 'confirm';
      await reply(
        '📋 สรุป user ใหม่:\n\n' +
          `chat_id: ${wiz.chat_id}\n` +
          `display_name: ${wiz.display_name}\n` +
          `role: ${wiz.role}\n` +
          'accounts: (ว่าง — ให้ user คนนั้นใช้ /add เพื่อเพิ่มเอง)\n\n' +
          'ขั้นที่ 4/4: ยืนยันเพิ่ม? (ส่ง y/yes/ใช่ เพื่อยืนยัน, อย่างอื่นถือว่ายกเลิก)\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'confirm': {
      if (confirmRe.test(text)) {
        try {
          addUser({
            telegram_id: wiz.chat_id!,
            chat_id: wiz.chat_id!,
            display_name: wiz.display_name!,
            role: wiz.role!,
          });
          userAddWizards.delete(chatId);
          await reply(
            '✅ เพิ่ม user สำเร็จ!\n\n' +
              `${wiz.display_name} (chat_id=${wiz.chat_id}, role=${wiz.role})\n\n` +
              'พิมพ์ /user list เพื่อดูรายชื่อทั้งหมด'
          );
          console.log(
            `[user-wizard] added user "${wiz.display_name}" chat_id=${wiz.chat_id} role=${wiz.role} by owner chat=${chatId}`
          );
        } catch (err) {
          userAddWizards.delete(chatId);
          await reply(`❌ เกิดข้อผิดพลาด: ${err}`);
        }
      } else {
        userAddWizards.delete(chatId);
        await reply('❌ ยกเลิกการเพิ่ม user แล้ว');
      }
      return;
    }
  }
}

// ---- /useredit wizard (owner + friend: edit court or slot of an existing account) ----
//
// Drives the user through picking an existing account, choosing what to edit
// (court or slot — one at a time per wizard run; rerun /useredit to edit the
// other), entering the new value, and confirming. Username/password are not
// editable through this wizard — if those need to change, delete via a future
// /userremove and re-add. Mirrors the structure of handleAddWizardStep so a
// maintainer who reads one can read the other.
async function handleUserEditWizardStep(
  ctx: Context,
  chatId: number,
  text: string,
  user: ReturnType<typeof getUserByChatId>
): Promise<void> {
  if (!user) {
    userEditWizards.delete(chatId);
    return;
  }
  const wiz = userEditWizards.get(chatId);
  if (!wiz) return;

  async function reply(text: string): Promise<void> {
    try {
      const m = await ctx.reply(text);
      console.log(`[useredit-wizard] → reply ok msg_id=${m.message_id} (${text.length} chars)`);
    } catch (err) {
      console.error(`[useredit-wizard] → reply FAILED: ${err}`);
      alertOwnerAboutReplyFail('useredit-wizard', err);
    }
  }

  const cancelRe = /^\/?(cancel|ยกเลิก)$/i;
  const confirmRe = /^(y|yes|ใช่|ยืนยัน)$/i;

  if (cancelRe.test(text)) {
    userEditWizards.delete(chatId);
    await reply('❌ ยกเลิกการแก้ account แล้ว');
    return;
  }

  switch (wiz.step) {
    case 'pick_account': {
      const input = text.trim();
      const num = parseInt(input, 10);
      if (isNaN(num) || num < 1 || num > user.accounts.length) {
        const list = user.accounts
          .map((a, i) => `  ${i + 1}. ${a.username} → ${a.court} ${a.slot}`)
          .join('\n');
        await reply(
          `⚠️ ไม่รู้จัก account "${input}"\n\n` +
            'accounts ของคุณ:\n' +
            list +
            '\n\nส่งหมายเลข (1-' + user.accounts.length + ') หรือ /cancel เพื่อยกเลิก'
        );
        return;
      }
      const acc = user.accounts[num - 1];
      wiz.username = acc.username;
      wiz.oldCourt = acc.court;
      wiz.oldSlot = acc.slot;
      wiz.step = 'pick_field';
      await reply(
        `✓ account: ${acc.username}\n` +
          `ปัจจุบัน: court=${acc.court ?? '(ไม่ได้ตั้ง — ใช้ COURT_PRIORITY กลาง)'}, slot=${acc.slot}\n\n` +
          'ขั้นที่ 2/4: ต้องการแก้อะไร?\n' +
          '  1. court (สนาม)\n' +
          '  2. slot (เวลา)\n\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'pick_field': {
      const input = text.trim();
      if (input === '1' || input.toLowerCase() === 'court' || input === 'สนาม') {
        wiz.field = 'court';
        wiz.step = 'edit_court';
        const courtList = COURTS_AVAILABLE.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
        await reply(
          `✓ แก้ court\n\n` +
            'ขั้นที่ 3/4: เลือกสนามใหม่:\n' +
            courtList +
            '\n\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      if (input === '2' || input.toLowerCase() === 'slot' || input === 'เวลา') {
        wiz.field = 'slot';
        wiz.step = 'edit_slot';
        const slotList = SLOTS_AVAILABLE.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
        await reply(
          `✓ แก้ slot\n\n` +
            'ขั้นที่ 3/4: เลือก slot ใหม่:\n' +
            slotList +
            '\n\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      await reply(
        '⚠️ ส่ง 1/court/สนาม หรือ 2/slot/เวลา\nส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'edit_court': {
      const input = text.trim();
      let court: string | undefined;
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= COURTS_AVAILABLE.length) {
        court = COURTS_AVAILABLE[num - 1];
      } else if (COURTS_AVAILABLE.includes(input)) {
        court = input;
      } else {
        const courtList = COURTS_AVAILABLE.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
        await reply(
          `⚠️ ไม่รู้จักสนาม "${input}"\n\n` +
            `ส่งหมายเลข (1-${COURTS_AVAILABLE.length}) หรือชื่อสนาม:\n` +
            courtList +
            '\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      if (court === wiz.oldCourt) {
        const courtList = COURTS_AVAILABLE.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
        await reply(
          `⚠️ สนามเดิมคือ ${court} — กรุณาเลือกสนามอื่น:\n` +
            courtList +
            '\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      wiz.newCourt = court;
      wiz.step = 'confirm';
      await reply(
        '📋 สรุปการแก้:\n\n' +
          `account: ${wiz.username}\n` +
          `court: ${wiz.oldCourt} → ${court}\n` +
          `slot: ${wiz.oldSlot} (ไม่เปลี่ยน)\n\n` +
          'ขั้นที่ 4/4: ยืนยัน? (ส่ง y/yes/ใช่ เพื่อยืนยัน, อย่างอื่นถือว่ายกเลิก)\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'edit_slot': {
      const input = text.trim();
      let slot: string | undefined;
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= SLOTS_AVAILABLE.length) {
        slot = SLOTS_AVAILABLE[num - 1];
      } else if (SLOTS_AVAILABLE.includes(input)) {
        slot = input;
      } else {
        const slotList = SLOTS_AVAILABLE.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
        await reply(
          `⚠️ ไม่รู้จัก slot "${input}"\n\n` +
            `ส่งหมายเลข (1-${SLOTS_AVAILABLE.length}) หรือชื่อ slot:\n` +
            slotList +
            '\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      if (slot === wiz.oldSlot) {
        const slotList = SLOTS_AVAILABLE.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
        await reply(
          `⚠️ slot เดิมคือ ${slot} — กรุณาเลือก slot อื่น:\n` +
            slotList +
            '\nส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }
      wiz.newSlot = slot;
      wiz.step = 'confirm';
      await reply(
        '📋 สรุปการแก้:\n\n' +
          `account: ${wiz.username}\n` +
          `court: ${wiz.oldCourt} (ไม่เปลี่ยน)\n` +
          `slot: ${wiz.oldSlot} → ${slot}\n\n` +
          'ขั้นที่ 4/4: ยืนยัน? (ส่ง y/yes/ใช่ เพื่อยืนยัน, อย่างอื่นถือว่ายกเลิก)\n' +
          'ส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    case 'confirm': {
      if (!confirmRe.test(text)) {
        userEditWizards.delete(chatId);
        await reply('❌ ยกเลิกการแก้ account แล้ว');
        return;
      }
      try {
        updateAccountInUser(
          chatId,
          wiz.username!,
          wiz.field === 'court' ? { court: wiz.newCourt! } : { slot: wiz.newSlot! }
        );
        const finalCourt = wiz.field === 'court' ? wiz.newCourt! : wiz.oldCourt!;
        const finalSlot = wiz.field === 'slot' ? wiz.newSlot! : wiz.oldSlot!;
        userEditWizards.delete(chatId);
        await reply(
          '✅ แก้ account สำเร็จ!\n\n' +
            `${wiz.username} → ${finalCourt} ${finalSlot}\n\n` +
            'พิมพ์ /start เพื่อดู accounts ทั้งหมด'
        );
        console.log(
          `[useredit-wizard] edited account "${wiz.username}" field=${wiz.field} chat=${chatId}`
        );
      } catch (err) {
        userEditWizards.delete(chatId);
        await reply(`❌ เกิดข้อผิดพลาด: ${err}`);
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

  // /user add wizard — same pattern as /add above. Only owner can have an
  // active wizard (entry is gated by the /user command owner check).
  if (user && user.role === 'owner' && userAddWizards.has(ctx.chat.id)) {
    await handleUserAddWizardStep(ctx, ctx.chat.id, text, user);
    return;
  }

  // /useredit wizard — both owner and friend can have an active wizard
  // (entry is gated only on registration, not role).
  if (user && userEditWizards.has(ctx.chat.id)) {
    await handleUserEditWizardStep(ctx, ctx.chat.id, text, user);
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
      alertOwnerAboutReplyFail('bot', err);
    }
  }

  switch (cmd) {
    case '/start': {
      if (!user) {
        // Unregistered user — show their chat_id so they can share it with
        // the owner, who will use /user add to register them. This is the
        // only practical way to learn a Telegram chat_id without the user
        // inspecting client-side debug info themselves.
        await reply(
          '❌ คุณยังไม่ได้ลงทะเบียนในระบบ\n\n' +
            '🔑 chat_id ของคุณ: ' + ctx.chat.id + '\n\n' +
            'ส่ง chat_id นี้ให้เจ้าของบอท เพื่อให้ owner ใช้คำสั่ง /user add\n' +
            'ลงทะเบียนคุณเข้าระบบ (ไม่ต้องแก้ source code)'
        );
        return;
      }
      await reply(
        `สวัสดี ${user.display_name}! 👋\n\n` +
          `คุณมี ${user.accounts.length} account ลงทะเบียนไว้:\n` +
          `${formatAccountList(user)}\n\n` +
          `➕ /add      → เพิ่ม account ใหม่\n` +
          `✏️  /useredit → แก้ court/slot ของ account\n` +
          `📅 /book    → จองทั้งหมดรอบ 12:00 ถัดไป\n` +
          `❌ /cancel  → ยกเลิกการจองที่ค้างไว้\n` +
          `📊 /status  → ดูผลล่าสุด\n` +
          `⏰ /cron    → เปิด/ปิดจองอัตโนมัติ 12:00\n` +
          `👥 /user    → จัดการ user (owner เท่านั้น)\n` +
          `ℹ️  /help   → คำสั่งทั้งหมด`
      );
      return;
    }

    case '/help': {
      const ownerBlock =
        user?.role === 'owner'
          ? '\n👥 /user list  — ดูรายชื่อ user ที่ลงทะเบียน (owner)\n' +
            '👥 /user add   — เพิ่ม user ใหม่ผ่าน wizard (owner)\n'
          : '';
      await reply(
        'คำสั่งทั้งหมด:\n\n' +
          '/start     — ดู account ที่ลงทะเบียน\n' +
          '/add       — เพิ่ม account ใหม่ (5 ขั้น)\n' +
          '/useredit  — แก้ court หรือ slot ของ account ที่ลงทะเบียน (4 ขั้น)\n' +
          '/book      — จองรอบ 12:00 ถัดไป (ทั้งหมด)\n' +
          '/cancel    — ยกเลิกการจองที่จองค้างไว้\n' +
          '/status    — ดูผลล่าสุด\n' +
          '/cron      — เปิด/ปิดจองอัตโนมัติ (/cron on | /cron off | /cron status)\n' +
          '/help      — คำสั่งนี้' +
          ownerBlock +
          '\n\nหลัง /book บอทจะรอจนถึง 12:00 น. แล้วจองให้อัตโนมัติ\n' +
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
      // cron=on friend is auto-booked at noon — /book is redundant. Tell them
      // instead of silently setting a flag the scheduler will ignore.
      // Owner is unaffected (always auto-booked).
      if (user.role === 'friend' && isCronEnabled(ctx.chat.id)) {
        await reply(
          '🟢 คุณเปิด cron อยู่แล้ว\n\n' +
            'บอทจะจอง account ของคุณตอน 12:00 น. อัตโนมัติ\n' +
            'ไม่ต้องส่ง /book ทุกรอบ\n\n' +
            'ส่ง /cron off ถ้าไม่ต้องการจองอัตโนมัติ'
        );
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

    case '/cron': {
      if (!user) {
        await reply('❌ คุณไม่ได้ลงทะเบียน กรุณาติดต่อเจ้าของบอท');
        return;
      }
      const parts = text.split(/\s+/);
      const sub = (parts[1] ?? '').toLowerCase();

      // /cron status — show current state. Available to any user (mirror
      // /book's pattern: read-only is safe; the toggle itself is gated below).
      if (sub === 'status' || sub === '') {
        const on = isCronEnabled(ctx.chat.id);
        const tag = on ? '🟢 ON' : '🔴 OFF';
        // ON: same message for both roles — auto-booked at noon.
        // OFF: differs by role — friend opts in per round via /book; owner is
        // always implicitly opted-in (just /book anyway), skip-notice wording.
        const explain = on
          ? 'บอทจะจอง account ของคุณตอน 12:00 ตามปกติ'
          : user.role === 'friend'
            ? 'บอทจะจองเฉพาะเมื่อคุณส่ง /book\nส่ง /cron on เพื่อเปิดจองอัตโนมัติ'
            : 'บอทจะข้ามการจอง account ของคุณตอน 12:00 (จะ DM แจ้งทุกครั้งที่ถูกข้าม)';
        await reply(
          `⏰ สถานะ cron — ${tag}\n\n${explain}\n\n` +
            'ส่ง /cron on  เพื่อเปิด\n' +
            'ส่ง /cron off เพื่อปิด'
        );
        return;
      }

      if (sub === 'on') {
        setCronEnabled(ctx.chat.id, true);
        await reply(
          '🟢 เปิด cron แล้ว\n\n' +
            'บอทจะจอง account ของคุณตอน 12:00 ตามปกติ\n' +
            'ส่ง /cron off เมื่อต้องการหยุดชั่วคราว'
        );
        return;
      }

      if (sub === 'off') {
        setCronEnabled(ctx.chat.id, false);
        await reply(
          '🔴 ปิด cron แล้ว\n\n' +
            'บอทจะข้ามการจอง account ของคุณตอน 12:00 น. (จะ DM แจ้งทุกครั้งที่ถูกข้าม)\n' +
            'ส่ง /cron on เมื่อต้องการเปิดกลับ'
        );
        return;
      }

      await reply(
        '⏰ จัดการ cron (จองอัตโนมัติตอน 12:00)\n\n' +
          '/cron on      — เปิด cron ของคุณ\n' +
          '/cron off     — ปิด cron ของคุณ (บอทจะข้ามรอบ 12:00 + แจ้งเตือน)\n' +
          '/cron status  — ดูสถานะปัจจุบัน'
      );
      return;
    }

    case '/user': {
      if (!user) {
        await reply('❌ คุณไม่ได้ลงทะเบียน กรุณาติดต่อเจ้าของบอท');
        return;
      }
      if (user.role !== 'owner') {
        await reply('❌ คำสั่ง /user สำหรับ owner เท่านั้น');
        return;
      }
      const parts = text.split(/\s+/);
      const sub = (parts[1] ?? '').toLowerCase();

      if (sub === 'list') {
        const all = getAllUsers();
        if (all.length === 0) {
          await reply('ℹ️  ยังไม่มี user ลงทะเบียน');
          return;
        }
        const lines: string[] = [`👥 Users ที่ลงทะเบียน (${all.length} คน)`, '━━━━━━━━━━━━━━━━━━'];
        for (const u of all) {
          const tag = u.role === 'owner' ? '👑' : '👤';
          const pending = u.pending_booking ? ' · ⏳pending' : '';
          const acct = u.accounts.length;
          lines.push(`${tag} ${u.display_name}`);
          lines.push(`   chat_id=${u.chat_id} · role: ${u.role} · accounts: ${acct}${pending}`);
        }
        lines.push('━━━━━━━━━━━━━━━━━━');
        lines.push('พิมพ์ /user add เพื่อเพิ่ม user ใหม่');
        await reply(lines.join('\n'));
        return;
      }

      if (sub === 'add') {
        if (userAddWizards.has(ctx.chat.id)) {
          await reply('⚠️ คุณอยู่ในขั้นตอน /user add อยู่แล้ว — ส่ง /cancel เพื่อเริ่มใหม่');
          return;
        }
        userAddWizards.set(ctx.chat.id, { step: 'chat_id', startedAt: Date.now() });
        await reply(
          '➕ เพิ่ม user ใหม่ (owner เท่านั้น)\n\n' +
            'ขั้นที่ 1/4: ส่ง chat_id ของ Telegram user ที่ต้องการเพิ่ม\n' +
            '(ให้ user คนนั้นส่ง /start มาที่บอทก่อน — บอทจะตอบด้วย chat_id ของเขา)\n' +
            'หรือส่ง "me" เพื่อใช้ chat_id ของคุณเอง\n\n' +
            'ส่ง /cancel เพื่อยกเลิก'
        );
        return;
      }

      // /user with no subcommand — show help
      await reply(
        '👥 จัดการ user (owner เท่านั้น)\n\n' +
          '/user list — แสดงรายชื่อ user ที่ลงทะเบียนทั้งหมด\n' +
          '/user add  — เพิ่ม user ใหม่ (wizard 4 ขั้น)\n\n' +
          'พิมพ์ /user list หรือ /user add'
      );
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

    case '/useredit': {
      if (!user) {
        await reply('❌ คุณไม่ได้ลงทะเบียน กรุณาติดต่อเจ้าของบอท');
        return;
      }
      if (user.accounts.length === 0) {
        await reply('⚠️ คุณไม่มี account ให้แก้ — ใช้ /add เพื่อเพิ่มก่อน');
        return;
      }
      if (userEditWizards.has(ctx.chat.id)) {
        await reply('⚠️ คุณอยู่ในขั้นตอน /useredit อยู่แล้ว — ส่ง /cancel เพื่อเริ่มใหม่');
        return;
      }
      userEditWizards.set(ctx.chat.id, { step: 'pick_account', startedAt: Date.now() });
      const list = user.accounts
        .map((a, i) => `  ${i + 1}. ${a.username} → ${a.court} ${a.slot}`)
        .join('\n');
      await reply(
        `✏️ แก้ account\n\n` +
          'ขั้นที่ 1/4: เลือก account ที่ต้องการแก้:\n' +
          list +
          '\n\nส่ง /cancel เพื่อยกเลิก'
      );
      return;
    }

    default: {
      if (!user) {
        // Unregistered user typed something other than /start. Tell them
        // their chat_id anyway — they may not know to type /start first.
        await reply(
          '🤔 ไม่รู้จักคำสั่ง "' + cmd + '"\n\n' +
            'คุณยังไม่ได้ลงทะเบียน — chat_id ของคุณคือ ' + ctx.chat.id + '\n' +
            'ส่งให้เจ้าของบอทเพื่อลงทะเบียนผ่าน /user add'
        );
        return;
      }
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

/** Send a prewarm DM with 1 retry (maxAttempts=2) on transient network
 *  blips. 5s backoff between attempts — the prewarm window is 5 minutes
 *  wide so this overhead is negligible. We retry only the prewarm path
 *  because (a) it's the path most exposed to api.telegram.org flakiness
 *  (3.5-minute cold loop, no warm pool), and (b) losing this DM silently
 *  leaves the user blind to what's about to run on their behalf. The
 *  results DM after the booking uses plain sendTelegramMessage — that
 *  runs after a booking cycle, not in a tight window, so a retry delay
 *  there would just slow down the user-facing report.
 *  Re-throws the final error so the caller's per-user try/catch still
 *  observes a single, clear failure after both attempts failed. */
async function sendNoticeWithRetry(
  chatId: number,
  text: string,
  maxAttempts = 2,
  backoffMs = 5_000
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendTelegramMessage(chatId, text);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        console.warn(
          `[cron] prewarm DM attempt ${attempt}/${maxAttempts} failed for ` +
            `chat=${chatId}, retrying in ${backoffMs}ms: ${err}`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastErr;
}

/** DM each user that the pre-warm window has opened. Fire-and-forget —
 *  failure is logged but must never block the booking run or crash the bot
 *  process. One user failing to receive the DM must not stop the others.
 *  Per user spec: sent to every user the scheduler is about to book (owner
 *  + cron=on friends with accounts), so they all see what is about to run
 *  on their behalf. Users who opted out (cron=off) get a skip notice after
 *  the run, not a prewarm.
 *
 *  Times and lead duration in the message are derived from `fireTime` (the
 *  planned noon tick) and `cronFireAt` (the actual cron-fire time), so the
 *  message stays accurate if the cron expression in main() changes. */
async function sendPrewarmNoticesForBooking(
  users: User[],
  fireTime: Date,
  cronFireAt: Date
): Promise<void> {
  // Whole body inside try — anything that throws synchronously (malformed
  // users.json → getAllUsers() throws SyntaxError, etc.) must not become an
  // unhandled rejection, since the caller uses `void` (fire-and-forget).
  try {
    if (users.length === 0) {
      console.log('[cron] no users to prewarm — skipping prewarm notice');
      return;
    }

    const fmtTime = (d: Date): string => d.toTimeString().slice(0, 8);
    const fmtSlot = (s: string): string => s.replace('_', '-');
    const leadMin = Math.round(
      (fireTime.getTime() - cronFireAt.getTime()) / 60_000
    );

    for (const user of users) {
      // Per-user try/catch: one Telegram send failing must NOT block the
      // rest. Each user gets their own sendTelegramMessage() call and their
      // own log line.
      try {
        // Group accounts by slot, then sort each group by username for stable
        // display. After the slot-first / court-priority-second refactor the
        // per-account `court` field is vestigial — every account honors the
        // global COURT_PRIORITY list. Display by slot reflects the actual
        // invariant the bot upholds at noon.
        const bySlot = new Map<string, typeof user.accounts>();
        for (const acc of user.accounts) {
          const list = bySlot.get(acc.slot) ?? [];
          list.push(acc);
          bySlot.set(acc.slot, list);
        }
        for (const list of bySlot.values()) {
          list.sort((a, b) => a.username.localeCompare(b.username));
        }

        const lines: string[] = [];
        lines.push(`⏰ ตื่นแล้ว! Pre-warm เริ่ม ${fmtTime(cronFireAt)}`);
        lines.push(`━━━━━━━━━━━━━━━━━━`);
        lines.push('');
        lines.push(`📅 จะจองตอน ${fmtTime(fireTime)} น.`);
        lines.push(`👤 ${user.display_name} · ${user.accounts.length} accounts`);
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
        const text = lines.join('\n');

        await sendNoticeWithRetry(user.chat_id, text);
        console.log(`[cron] prewarm notice sent to ${user.display_name} (${user.accounts.length} accts)`);
      } catch (userErr) {
        console.warn(`[cron] prewarm notice failed for ${user.display_name}: ${userErr}`);
      }
    }
  } catch (err) {
    console.warn(`[cron] prewarm notice run failed: ${err}`);
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

  // Collect candidates:
  //   owner: always considered (if cron ON).
  //   friends split into two pools:
  //     autoFriends   — cron ON  → booked every day automatically
  //     optInFriends  — cron OFF → booked only if they sent /book (pending_booking=true)
  // Skip-with-DM applied to whichever user disabled cron between filter and fire.
  // DEEP_PREWARM env var picks the run-mode for BOTH owner and friend uniformly.
  const owner = getOwner();
  const autoFriends = getAllUsers().filter(
    (u) => u.role === 'friend' && isCronEnabled(u.chat_id) && u.accounts.length > 0
  );
  const optInFriends = getAllUsers().filter(
    (u) =>
      u.role === 'friend' &&
      !isCronEnabled(u.chat_id) &&
      u.pending_booking &&
      u.accounts.length > 0
  );

  // Build the prewarm recipient list: every user we expect to book right now
  // (owner-if-cron-on + cron=on friends with accounts). These are the same
  // users who will get a results DM after 12:00, so they see the lead message
  // first. Users in optInFriends do NOT get a prewarm — they're per-round
  // opted in, not on the routine schedule, and the skip-notice path is a
  // better signal for them.
  // `new Date()` is the actual cron-fire moment, used by the helper to derive
  // the lead duration in the message — keeps the message accurate even if the
  // cron expression in main() changes.
  const prewarmRecipients: User[] = [];
  if (owner && owner.accounts.length > 0 && isCronEnabled(owner.chat_id)) {
    prewarmRecipients.push(owner);
  }
  for (const friend of autoFriends) {
    prewarmRecipients.push(friend);
  }
  void sendPrewarmNoticesForBooking(prewarmRecipients, fireTime, new Date());

  const useDeep = process.env.DEEP_PREWARM === '1';
  const tasks: { user: typeof owner; run: () => Promise<EngineResult> }[] = [];

  if (owner && owner.accounts.length > 0) {
    if (!isCronEnabled(owner.chat_id)) {
      // Owner disabled cron — skip and notify.
      console.log(`[scheduler] skipping owner ${owner.display_name} (cron disabled)`);
      try {
        await sendTelegramMessage(
          owner.chat_id,
          '🔴 ข้ามรอบ 12:00 เนื่องจากคุณปิด cron ไว้\n\n' +
            'ส่ง /cron on เพื่อเปิดกลับมาจองอัตโนมัติ'
        );
      } catch (err) {
        console.warn(`[scheduler] failed to send skip notice to owner: ${err}`);
      }
    } else {
      tasks.push({
        user: owner,
        run: () =>
          useDeep
            ? runWithDeepPrewarm(owner!.accounts, fireTime)
            : runWithPrewarm(owner!.accounts, fireTime),
      });
    }
  }

  // Helper: push a friend task using the same DEEP_PREWARM selection as owner.
  const pushFriendTask = (friend: NonNullable<typeof owner>): void => {
    tasks.push({
      user: friend,
      run: () =>
        useDeep
          ? runWithDeepPrewarm(friend.accounts, fireTime)
          : runWithPrewarm(friend.accounts, fireTime),
    });
  };

  // Auto friends — race check: cron could flip off between filter and loop.
  for (const friend of autoFriends) {
    if (!isCronEnabled(friend.chat_id)) {
      console.log(`[scheduler] skipping friend ${friend.display_name} (cron disabled since filter)`);
      try {
        await sendTelegramMessage(
          friend.chat_id,
          '🔴 ข้ามรอบ 12:00 เนื่องจากคุณปิด cron ไว้\n\n' +
            'ส่ง /cron on เพื่อเปิดกลับมาจองอัตโนมัติ'
        );
      } catch (err) {
        console.warn(`[scheduler] failed to send skip notice to ${friend.display_name}: ${err}`);
      }
      continue;
    }
    pushFriendTask(friend);
  }

  // Opt-in friends — they /book'd while cron was off. If cron has since flipped on,
  // still book them this round (their pending was valid at /book time). setLastResult
  // after the run clears pending_booking, so future rounds rely on cron state alone.
  for (const friend of optInFriends) {
    pushFriendTask(friend);
  }

  if (tasks.length === 0) {
    console.log('[scheduler] no users to book — nothing to do');
    return;
  }

  // Run all user-groups IN PARALLEL. Each group launches its own Chrome browser
  // and spins to the same fireTime, so owner and cron=on friends fire at
  // the same noon tick — fair race for shared (court, slot) pairs.
  //
  // Why parallel (replaces earlier sequential loop): sequential execution
  // made every friend task start AFTER owner dispatch completed (~68s past
  // fire), guaranteeing friend lost every slot-race to the owner. Parallel
  // costs ~+1 browser in memory for ~6 min — acceptable since the susport
  // login/confirm endpoints don't rate-limit on user/pass auth (no bot
  // signature). Each task has its own try/catch, so a single failure (login
  // error, setLastResult disk full, DM API blip) is isolated. Promise.allSettled
  // — not Promise.all — so an unhandled throw outside the inner try/catch
  // doesn't reject the whole batch.
  const runs: ScheduledRun[] = [];
  await Promise.allSettled(
    tasks.map(async (task) => {
      if (!task.user) return;
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
    })
  );

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
      // Shorter long-poll around the noon fire window (11:55-12:01) so the
      // undici in-flight request frees the event loop faster — the cron
      // fires at 11:55 and runScheduledBooking launches browser contexts at
      // 12:00 sharp. A 25s long-poll could hold a connection from the wrong
      // tick and slow outbound sendMessage calls just as results need to DM
      // users. Outside that window we use the normal 25s timeout to reduce
      // idle getUpdates traffic.
      const nowMs = Date.now();
      const noonMs = nextNoon(new Date(nowMs)).getTime();
      const msToNoon = noonMs - nowMs;
      const pollTimeout = msToNoon > 0 && msToNoon <= 6 * 60_000 ? 5 : 25;
      const url = `${apiBase}/getUpdates?timeout=${pollTimeout}&offset=${offset}`;
      // Hard client-side ceiling on the request: the server holds the long-poll
      // for `pollTimeout` seconds, so anything past that + a network margin is a
      // stuck connection. Without this, a half-open socket (seen as
      // UND_ERR_CONNECT_TIMEOUT / silent hangs on this network) can wedge the
      // loop and stop the bot from ever seeing new updates. AbortController
      // guarantees the fetch is torn down and the loop re-issues getUpdates.
      const pollController = new AbortController();
      const pollAbort = setTimeout(() => pollController.abort(), (pollTimeout + 15) * 1000);
      pollAbort.unref?.();
      let res: Response;
      try {
        res = await fetch(url, { method: 'GET', signal: pollController.signal });
      } finally {
        clearTimeout(pollAbort);
      }
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
