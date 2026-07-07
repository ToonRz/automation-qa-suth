# Court Booking Bot — `susport.sc.su.ac.th`

Playwright E2E automation สำหรับจองสนามแบดมินตันบน `https://susport.sc.su.ac.th/login.php`
รัน **accounts หลาย user พร้อมกัน (parallel)** ทุกครั้งที่ถึงเวลา **12:00:00 น. ตรง** ของวันที่กดรัน

- **Local CLI** — รัน 9 accounts ของ owner ตรงเวลาเที่ยง (config จาก `config/accounts.json`)
- **Telegram bot** — multi-user (1 owner + N friends); แต่ละคนมี accounts ของตัวเอง, เปิด cron ให้จองอัตโนมัติหรือส่ง `/book` รายรอบ

> Source of truth: [`requirements.md`](./requirements.md) — ทุกอย่างในโปรเจกต์นี้อ้างอิงจาก spec นั้น
> Project rules for Claude: [`CLAUDE.md`](./CLAUDE.md)

---

## 1. Prerequisites

- **Node.js 18+** (tested on 22.14.0)
- **Google Chrome** (ใช้ channel `chrome` ของ Playwright — ต้องมี `Google Chrome.app` บน macOS)
- **macOS** สำหรับ `launchd` auto-respawn (ดู §11) — Linux ต้องใช้ systemd หรือรันด้วย tmux เอง
- npm 10+

---

## 2. Setup

```bash
# 1. Install dependencies
npm install

# 2. ติดตั้ง Google Chrome (ถ้ายังไม่มี)
brew install --cask google-chrome   # macOS
# Linux: ดู https://www.google.com/chrome/

# 3. ตั้ง .env (ดู .env.example)
cp .env.example .env
# แก้ .env ใส่ TELEGRAM_BOT_TOKEN (จาก @BotFather) + TZ=Asia/Bangkok

# 4. สร้าง config/users.json สำหรับ Telegram bot
cp config/users.example.json config/users.json
# แก้ config/users.json ใส่ chat_id/telegram_id ของคุณ + credentials จริง
```

> ไม่ต้องรัน `npx playwright install chromium` — เราใช้ system Chrome ผ่าน `channel: 'chrome'`

---

## 3. Configuration

### 3.1 Local CLI — `config/accounts.json`

ใช้กับ `npm start` / `npm run now` / `npm run dry-run` (ไม่ผ่าน Telegram bot):

```json
{
  "COURT_PRIORITY": ["แบดมินตัน2", "แบดมินตัน1"],
  "accounts": [
    { "username": "650910088", "password": "Pin@2546", "slot": "17:30_18:30" },
    { "username": "671211370", "password": "...",     "slot": "18:30_19:30" }
  ]
}
```

### 3.2 Telegram bot — `config/users.json`

ใช้กับ `npm run bot` (multi-user: owner + friends):

```json
{
  "users": [
    {
      "telegram_id": 123456789,
      "chat_id": 123456789,
      "display_name": "ณราวิชญ์ (Owner)",
      "role": "owner",
      "accounts": [
        { "username": "650910088", "password": "...", "slot": "17:30_18:30" }
      ]
    },
    {
      "telegram_id": 987654321,
      "chat_id": 987654321,
      "display_name": "เพื่อน A",
      "role": "friend",
      "accounts": [
        { "username": "...", "password": "...", "slot": "20:30_21:30" }
      ]
    }
  ]
}
```

- `role: 'owner'` — มีได้แค่ 1 คน; ได้รับ abort alert DM
- `role: 'friend'` — มีได้หลายคน; เปิด cron ผ่าน `/cron on` เพื่อจองอัตโนมัติ

> **ทั้ง 2 ไฟล์มี credentials จริง** — ดู [Security](#11-security) ก่อน push

### 3.3 Court Priority — slot-first, court-priority-second

ทุก account ลองตามลำดับนี้ (ดู requirements §3.4):

| Step | Try |
|------|-----|
| 1 | `(COURTS[0], slot ของฉัน)` — เช่น `(แบดมินตัน2, 17:30_18:30)` |
| 2 | `(COURTS[1], slot ของฉัน)` — เช่น `(แบดมินตัน1, 17:30_18:30)` |
| 3 | Safety net — `(สนามอื่นๆ ที่เหลือ, slot ของฉัน)` ตามลำดับ dropdown |
| 4 | FAIL — `slot {slot} ไม่ว่างในทุกสนาม` |

**สำคัญ:** ภายในสนามเดียว **ลอง slot ของตัวเองเท่านั้น** — ไม่มี per-court slot fallback

COURT_PRIORITY lives ที่ top-level ของ `config/accounts.json` (config-driven, ไม่ hardcode)

---

## 4. How to Run — Local CLI

### 4.1 Scheduled (production mode)

```bash
npm start
```

- กด**ก่อนเที่ยง** → นับถอยหลัง real-time แล้วปล่อย contexts พร้อมกันที่ **12:00:00.000 ตรง** (SC-04)
- กด**หลังเที่ยง** → รอจนถึง 12:00:00 ของ**วันถัดไป**อัตโนมัติ

### 4.2 Run now (skip the wait)

```bash
npm run now
```

### 4.3 Dry-run (no slot consumed)

```bash
npm run dry-run
```

ผ่าน login + court/slot select ครบทุก account **โดยไม่กดปุ่ม "จอง"**

### 4.4 Single-account debug

```bash
npm run account -- <username>
```

### 4.5 Re-discover slots (ถ้าเว็บเปลี่ยน UI)

```bash
npm run discover
npm run discover -- --account=1
```

Output: `screenshots/discover-*.png` + `reports/slots-discovered.json`

---

## 5. How to Run — Telegram Bot

```bash
npm run bot
```

Bot start → register handlers → listen ผ่าน long polling

ใน Telegram คุยกับบอท:

| Command | ใครใช้ได้ | ทำอะไร |
|---------|-----------|--------|
| `/start` | ทุกคน | ลงทะเบียนเริ่มต้น + ดูสถานะ |
| `/help` | ทุกคน | รายการคำสั่งทั้งหมด |
| `/book` | ทุกคน | จองทันที (ข้ามรอบเที่ยง) |
| `/cancel` | ทุกคน | ยกเลิกการจองที่กำลังจะรัน |
| `/status` | ทุกคน | ดูสถานะ cron + ผลล่าสุด |
| `/cron on` | ทุกคน | เปิดจองอัตโนมัติ 12:00 ทุกวัน |
| `/cron off` | ทุกคน | ปิดจองอัตโนมัติ (ข้ามรอบเที่ยง) |
| `/cron status` | ทุกคน | ดูสถานะ cron |
| `/user` | owner | ดูรายการ user ทั้งหมด |
| `/add` | owner | wizard เพิ่ม account ใหม่ให้ user |
| `/useredit` | owner | wizard แก้ court/slot ของ account |

### 5.1 Deep prewarm (T-5min)

ตั้ง `DEEP_PREWARM=1` ใน `.env` → บอทจะ login + select court/slot ไว้ตอน **11:55** (5 นาทีก่อนเที่ยง) แล้ว submit ตอนเที่ยงพร้อมกันทั้งหมด

ถ้า invariant check พบว่า **slot ของบาง account ถูกจองครบทุกสนาม** (priority + safety net) → ABORT:
- console: `⛔ DEEP PREWARM ABORTED (T-5min) — N account(s) ไม่มีสนามว่าง`
- Telegram DM ส่งหา owner (best-effort; ถ้า fail จะ log error ไม่ทิ้งรอบ)
- account ที่ stuck ถูก mark `failed` → dispatch เปลี่ยนเป็น standard mode ตอนเที่ยง

ค่าเริ่มต้น (`DEEP_PREWARM=0`) → ใช้ light prewarm ตอน T-30s แทน (proven baseline)

---

## 6. CLI Flags

| Flag | Effect |
|------|--------|
| `--now` | ข้าม scheduler wait; ยิงทันที |
| `--tomorrow` | บังคับ target = 12:00 ของวันถัดไป |
| `--dry-run` | ข้ามการกด submit (ไม่กิน slot) |
| `--account=USERNAME` | รันแค่ account นี้ (ข้าม scheduler) |

Compose: `npm start -- --dry-run` (รอเที่ยง → dry-run)

---

## 7. Output

ทุกครั้งที่รัน:

- **`screenshots/{username}.png`** — full-page screenshot ปลายทางของทุก account (PASS และ FAIL)
- **`reports/run-{timestamp}.json`** — combined report
- **Telegram DM** — สรุปผลส่งหา user ที่เกี่ยวข้อง (owner เห็นทุกคน, friend เห็นแค่ตัวเอง)

### Per-account result

```json
{
  "username": "650910088",
  "triggered_at": "2026-07-07T12:00:00.123Z",
  "court_attempted": "แบดมินตัน2",
  "court_booked": "แบดมินตัน2",
  "slot": "17:30_18:30",
  "status": "PASS",
  "fail_reason": null,
  "screenshot": "/path/to/screenshots/650910088.png",
  "duration_ms": 4321
}
```

### Combined run summary

```json
{
  "started_at": "2026-07-07T12:00:00.000Z",
  "finished_at": "2026-07-07T12:00:11.500Z",
  "total_ms": 11500,
  "counts": { "PASS": 7, "FAIL": 1, "ERROR": 0, "DRY-RUN": 0 },
  "accounts": [ /* 9 per-account results */ ]
}
```

---

## 8. Project Structure

```
.
├── config/
│   ├── accounts.json              ← สำหรับ local CLI: COURT_PRIORITY + accounts (no court field)
│   └── users.json                 ← สำหรับ Telegram bot: users[] (owner + friends) + accounts
├── src/
│   ├── scheduler.ts               ← waitUntilNoonThenRun + CLI flags
│   ├── runner.ts                  ← Promise.all() parallel release
│   ├── bookingFlow.ts             ← per-account: login → court → slot → submit
│   ├── discoverSlots.ts           ← one-off slot discovery (debug aid)
│   ├── timeSync.ts                ← server-time sync (compensates local clock drift)
│   └── server/
│       ├── bot.ts                 ← Telegraf bot: handlers + wizards + cron
│       ├── bookingEngine.ts       ← runWithDeepPrewarm / runWithPrewarm / runStandard
│       ├── userStore.ts           ← load/save/reload config/users.json + helpers
│       ├── configLoader.ts        ← load config/accounts.json + COURT_PRIORITY export
│       ├── telegramSend.ts        ← fetch wrapper for Telegram API (15s timeout)
│       ├── sendDryRunMessages.ts  ← dry-run DM builder
│       ├── testPrewarmNotice.ts   ← one-off test: prewarm DM message format
│       ├── testResultsNotices.ts  ← one-off test: results DM message format
│       └── testWizardHelpers.ts   ← one-off test: /add + /useredit wizard wiring
├── reports/                       ← auto-generated, gitignored
├── screenshots/                   ← auto-generated, gitignored
├── bot.stdout.log / bot.stderr.log ← launchd-managed logs
├── package.json
├── tsconfig.json
├── requirements.md                ← source of truth
├── CLAUDE.md                      ← project rules for Claude Code
└── README.md                      ← this file
```

---

## 9. Hard Rules (from requirements)

อย่าละเมิด:

1. **12:00:00 trigger ตรงเป๊ะ ไม่มี tolerance** (SC-04)
2. **BrowserContext แยกกันทุก account** — `browser.newContext({ storageState: undefined })` (BR-01/02/03)
3. **`context.close()` ทุก exit path** — ทั้ง PASS และ FAIL (BR-04)
4. **Parallel release** — ทุก context เริ่มใน tick เดียวผ่าน `Promise.all` (SC-05)
5. **Screenshot ทุก account** ทั้ง PASS และ FAIL
6. **Court priority = slot-first** — ทุก account ใช้ slot ของตัวเองเท่านั้น, ไม่มี per-court slot fallback (§3.4)
7. **COURT_PRIORITY lives in config** — top-level ของ `config/accounts.json`, ไม่ hardcode ใน code
8. **Deep prewarm abort → DM owner** — ถ้า invariant fail ที่ T-5min ต้องส่ง alert
9. **อย่า fabricate slot times** — ถ้ายังไม่รู้ ให้รัน `npm run discover` ก่อน

---

## 10. Auto-Respawn (launchd)

Production: บอทรันผ่าน launchd ที่ `~/Library/LaunchAgents/com.toon.court-booking-bot.plist`:

```bash
# โหลด plist (ครั้งแรก)
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.toon.court-booking-bot.plist

# เช็คสถานะ
launchctl print gui/$UID/com.toon.court-booking-bot

# Restart ทันที (เช่น หลังแก้ code แล้วต้องการให้บอทรันบน code ชุดใหม่)
launchctl kickstart -k gui/$UID/com.toon.court-booking-bot

# ดู logs
tail -f /Users/narawich/Documents/GitHub/automation-qa-suth/bot.stdout.log
```

**Alias ที่แนะนำ** (ใส่ใน `~/.zshrc`):

```bash
alias rb='launchctl kickstart -k gui/$UID/com.toon.court-booking-bot'
alias bot-logs='tail -f /Users/narawich/Documents/GitHub/automation-qa-suth/bot.stdout.log'
```

หลังแก้ code → `rb` (kickstart -k ฆ่า process เก่า + spawn ใหม่ทันที)

---

## 11. Troubleshooting

| อาการ | สาเหตุ / แก้ |
|-------|--------------|
| Login ล้มเหลวทุก account | เช็ค password ใน `config/accounts.json` / `config/users.json` |
| `slot "..." ไม่ว่างในทุกสนาม` | ทุก court (priority + safety net) slot นั้นถูกจองหมดแล้ว — เลือก slot ใหม่ |
| Time dropdown ว่างเปล่า | AJAX ยังไม่ทำงาน หรือ slot ถูกจองหมดแล้ว |
| `submit result unclear` | ตรวจ screenshot — เว็บอาจ redirect ไป URL ที่เราไม่รู้จัก |
| All accounts fail พร้อมกัน | Network issue หรือ site ล่ม — เช็ค `https://susport.sc.su.ac.th/login.php` ใน browser |
| Chrome not found | ติดตั้ง Chrome หรือเปลี่ยน `bookingFlow.ts` เป็น chromium ล้วน + รัน `npx playwright install chromium` |
| Bot ไม่ตอบใน Telegram | เช็ค `TELEGRAM_BOT_TOKEN` ใน `.env` + `tail -f bot.stderr.log` |
| Bot จองแล้วไม่มี DM ส่งกลับ | `TELEGRAM_BOT_TOKEN` ผิด, network ตอนส่ง fail, หรือ user ยังไม่ได้ `/start` |
| launchd plist ไม่ respawn หลัง crash | เช็ค `KeepAlive` + `ThrottleInterval` ใน plist (≥10s) |
| Bot process ค้าง (manual `nohup`) | ฆ่า manual PID ก่อน แล้ว `launchctl bootstrap` ใหม่ |

---

## 12. Reset / Cleanup

```bash
# ลบ screenshots เก่า
rm -rf screenshots/*.png

# ลบ reports เก่า
rm -rf reports/run-*.json
```

> ไม่ลบ `reports/slots-discovered.json` — เก็บไว้เป็น reference ของ dropdown structure

---

## 13. Security

**ไฟล์ที่มี credentials จริง:**

| ไฟล์ | สถานะ |
|------|-------|
| `config/accounts.json` | ⚠️ อยู่ใน git — commit เฉพาะ placeholders |
| `config/users.json` | ⚠️ อยู่ใน git — commit เฉพาะ placeholders |
| `requirements.md` §2 | ⚠️ อยู่ใน git — พิจารณาลบ credentials ออกก่อน push |
| `.env` | ✅ gitignored (มี `TELEGRAM_BOT_TOKEN`) |
| `reports/run-*.json` | ✅ gitignored |
| `screenshots/*.png` | ✅ gitignored |
| `bot.stdout.log` | ✅ gitignored (อาจมี username ใน error context) |

**ก่อน push:**

1. เช็คว่า `accounts.json` / `users.json` ไม่มี credentials จริง — ใช้ placeholders หรือ gitignore
2. อย่า commit `reports/` หรือ `screenshots/` — มี username
3. ถ้า credentials รั่วไหล → เปลี่ยน password ทันทีที่ `susport.sc.su.ac.th`
4. ถ้า `TELEGRAM_BOT_TOKEN` รั่วไหล → revoke ผ่าน @BotFather → `/revoke`