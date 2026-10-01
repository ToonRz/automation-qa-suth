# QA Automation — Court Booking System
## `susport.sc.su.ac.th` | Playwright End-to-End

---

## 1. ภาพรวม (Overview)

ระบบ Playwright automation สำหรับจองสนามแบดมินตันบนเว็บ `https://susport.sc.su.ac.th/login.php`  
รัน **ทุก account พร้อมกัน (parallel)** ที่เวลา **12:00:00 น. ตรง**

ใช้งานได้ 2 ทาง:
- **Telegram bot (production)** — `npm run bot` รันค้างไว้ผ่าน launchd ทุกวัน cron 11:55 จะ prewarm แล้วจองให้ทุก account ของ user ที่เลือกจองรอบนั้น (owner + friends ใน `config/users.json`; ณ 2026-10 มี 17 account) ใน batch เดียว ส่งผลกลับทาง Telegram DM — รายละเอียดใน §6.2 และ §10.11
- **CLI** — `npm start` รอจนถึงเที่ยงแล้วจองบัญชีใน `config/accounts.json` (flow เดิมของ spec, ใช้ debug)

---

## 2. Credentials & Time Assignment

แต่ละ account มี `username`, `password` และ `slot` ของตัวเอง (รูปแบบ `HH:MM_HH:MM` เช่น `18:30_19:30`) — หลาย account ใช้ slot เดียวกันได้ (ดูการหมุนลำดับสนามใน §3.4)

| ไฟล์ | เก็บอะไร | ใช้โดย |
|------|----------|--------|
| `config/users.json` | user ของ bot: `role` (`owner` / `friend`), `chat_id`, cron on/off, `pending_booking`, และ `accounts[]` (username / password / slot) ของแต่ละ user — template: `config/users.example.json` | Telegram bot |
| `config/accounts.json` | top-level `COURT_PRIORITY` (ลำดับสนามของทุก account) + `accounts[]` | `COURT_PRIORITY`: ทั้ง bot และ CLI · `accounts[]`: CLI เท่านั้น |

- ณ 2026-10 ทุก account มี slot แล้ว (ไม่มี `TBD`) — owner 9 + friend 8 ใน `users.json`
- bot อ่าน `users.json` ใหม่เมื่อ mtime เปลี่ยน ไม่ต้อง restart แต่ต้องบันทึกก่อน cron 11:55 (§10.11)
- per-account `court` เป็น `@deprecated` — ลำดับสนามมาจาก `COURT_PRIORITY` เท่านั้น (§10.4)

> **Security:** credentials จริงเก็บใน `config/users.json` / `config/accounts.json` เท่านั้น (ทั้งคู่ gitignored — ไฟล์นี้ไม่มี credential)

---

## 3. Functional Requirements

### 3.1 Scheduler — รันเที่ยงตรง

| ID | ข้อกำหนด |
|----|----------|
| SC-01 | เมื่อผู้ใช้กด Run ระบบต้องคำนวณ `target = วันนั้น 12:00:00 (local time)` |
| SC-02 | ถ้ากดก่อนเที่ยง → หน้าจอแสดง countdown และรอจนถึง **12:00:00 น. ตรงพอดี** |
| SC-03 | ถ้ากดหลังเที่ยงแล้ว → แจ้ง "เลยเวลาแล้ว" และถามว่าจะรอพรุ่งนี้หรือรันทันที |
| SC-04 | **ไม่มี tolerance** — trigger ที่ 12:00:00 เท่านั้น |
| SC-05 | เมื่อถึงเวลา ให้ปล่อยทุก account พร้อมกันทันที (parallel launch) |

> SC-02 / SC-03 ใช้กับ CLI (`npm start`): ถ้าเลยเที่ยงแล้วจะเล็ง 12:00 ของพรุ่งนี้อัตโนมัติแทนการถาม และ `npm run now` (`--now`) = รันทันที. โหมด bot ไม่มีปุ่ม Run: cron ยิงเองทุกวัน 11:55 เพื่อ prewarm แล้ว dispatch ที่ 12:00:00.000 ตรง — ถ้าเครื่องตื่นสายเกิน 30s ไม่ยิง (FAIL `missed-deadline`) และไม่จองย้อนหลัง (§6.2, §10.8)

### 3.2 Browser Isolation

| ID | ข้อกำหนด |
|----|----------|
| BR-01 | แต่ละ account ต้องใช้ **Playwright BrowserContext ใหม่** แยกกัน |
| BR-02 | ใช้ `browser.newContext()` ทุกครั้ง — ห้าม reuse context |
| BR-03 | เปิดด้วย `channel: 'chrome'` และตั้ง `storageState: undefined` เพื่อไม่ให้ cookie ปนกัน |
| BR-04 | เมื่อ flow ของ account นั้นจบ (สำเร็จหรือล้มเหลว) ต้อง `context.close()` ทันที |

### 3.3 End-to-End Flow (ต่อ 1 account)

```
1. เปิด BrowserContext ใหม่ (incognito-equivalent)
2. ไปที่ https://susport.sc.su.ac.th/login.php
3. กรอก username และ password ของ account นั้น
4. กด Login → รอ redirect / confirm login สำเร็จ
5. ไปที่หน้าจองสนาม
6. เลือกสนามตาม COURT_PRIORITY (priority-court #1 ก่อน แล้ว #2 แล้วตามด้วย safety net)
   └─ ทุก court จะใช้ slot ของ account เท่านั้น — ไม่มี per-court slot fallback
   └─ ถ้า assigned slot ไม่ว่างในทุก court → FAIL
7. เลือก slot เวลาของ account นั้น (ตาม Time Assignment ข้อ 2)
8. ยืนยันการจอง (กด submit / confirm)
9. ตรวจสอบว่าการจองสำเร็จ → บันทึก PASS + screenshot (โหมด bot: ยืนยันจาก reservations.php หลัง hold window — ดู §10.10)
10. context.close()
```

### 3.4 Court Selection Logic — Slot-time-first (Retry-with-Fallback)

Priority is **slot-time-first, court-priority-second** — ทุก account จอง slot ของตัวเองเท่านั้น:

1. ทุก account จะลอง `(priority-court #1, assigned-slot)` ก่อน
2. ถ้าเต็ม → ลอง `(priority-court #2, assigned-slot)`
3. ถ้าทั้งสอง priority courts เต็ม → ลอง safety-net courts (แบดมินตัน3, 5, 6, …) ตาม dropdown order
4. ถ้า assigned slot ไม่ว่างในทุกสนาม (priority + safety net) → FAIL with reason `slot {slot} ไม่ว่างในทุกสนาม`

**ห้าม fallback ไป slot อื่นภายในสนามเดียวกัน** — ทุก account จอง slot ของตัวเองเท่านั้น

```
COURT_PRIORITY:
  lives at top-level of config/accounts.json as a string[]
  e.g. ["แบดมินตัน2", "แบดมินตัน1"]
  safety-net = remaining badminton courts in dropdown order (implicit)

PRIMARY     → COURTS[0]
SECONDARY   → COURTS[1]
SAFETY NET  → other badminton courts (excludes เทนนิส)
ABORT       → slot taken in every court: status = FAIL with reason
              "slot {slot} ไม่ว่างในทุกสนาม"
```

**Same-slot rotation (de-confliction):** account ที่ใช้ slot เดียวกันได้ลำดับสนามแบบ **หมุน** ตามตำแหน่งในกลุ่ม — คนที่ 0 เริ่มที่ `COURTS[0]`, คนที่ 1 เริ่มที่ `COURTS[1]`, … วนกลับ. ทุกคนยังได้ลำดับครบทุกสนาม (coverage ข้างบนไม่เปลี่ยน) ต่างกันแค่จุดเริ่ม — ใช้ลำดับนี้ทั้งตอน prewarm, ตอนยิงเที่ยง, retry loop และ re-book หลังเว็บล้าง (§10.10, §10.11)

**Pre-reset heads-up (T-5min):** ถ้าข้อมูลตอน prewarm บอกว่า slot ของ account ไหนเต็มทุกสนาม → DM แจ้ง owner เป็น **ข้อมูลเท่านั้น** แล้วยิงตามปกติทุก account. ข้อมูลก่อนเที่ยงยังเป็นของเมื่อวานและถูก reset ตอน 12:00 จึงไม่ใช้ตัดสินอะไร (เดิมเป็น ABORT deep prewarm — ยกเลิกแล้ว ดู §10.11)

**Retry budget:** สูงสุด **30 วินาที** ต่อ account (เริ่มนับหลัง login เสร็จ) — ถ้าเกินจะหยุด loop และบันทึก FAIL

**Exit conditions (หยุด loop ทันที):**
- ✅ `success` → PASS
- 🚫 `already-booked-today` (server ตอบว่า "คุณได้จองสนามวันนี้แล้ว") → FAIL
- ⏰ deadline หมด → FAIL

**Special case:** ถ้า submit fail แล้ว server redirect ออกจาก `booking.php` ต้อง `goto(booking.php)` ก่อน retry (handled in `resetToBookingPage()`)

> **หมายเหตุ:** พฤติกรรมนี้ทดแทน spec เดิม (PRIMARY=แบดมินตัน1, FALLBACK=แบดมินตัน4, EXTENDED=other badminton) — เปลี่ยนเป็น slot-first เพื่อแก้ปัญหา collision เมื่อ 4 accounts เล็งสนามเดียวกันเวลาเดียวกัน (เจอ 2026-07-07)

---

## 4. Technical Stack

| Component | ค่าที่กำหนด |
|-----------|-------------|
| Language | TypeScript (Node.js, รันด้วย `ts-node`) |
| Automation | Playwright — `channel: 'chrome'`, headless |
| Parallelism | browser เดียว, `BrowserContext` ใหม่ต่อ account, `Promise.all()` ยิงทุก account ของทุก user ใน tick เดียว |
| Scheduler | bot: `node-cron` `55 11 * * *` (เปิด prewarm) + `waitUntilLocalTimestamp` รอ 12:00:00.000 ตรง · CLI: `setTimeout` คำนวณจาก `Date` |
| Interface | Telegram bot — long-poll ด้วย Bot API ตรง + `sendTelegramMessage` (§10.1) |
| Config | `config/users.json` + `config/accounts.json` (`COURT_PRIORITY`) แยก credential / slot / ลำดับสนามออกจาก code; `config/court-ids.json` = cache id สนาม; `.env` = token, `TZ=Asia/Bangkok`, kill-switch |
| Report | `reports/bot-run-<ISO>.json` (§7 + §10.7) + `screenshots/<YYYY-MM-DD>/<username>.png` ทุก account + DM ราย user + สรุปให้ owner |
| Tests | สคริปต์ `ts-node` กับ mock server ใน `node:http` (`npm run test:log-audit`, `test:wipe`, `test:fast-confirm`, `bot:test-wizards`) — ไม่แตะเว็บจริงและ Telegram; ไม่ใช้ Playwright Test runner |

Kill-switch ใน `.env`: `DEEP_PREWARM=0` (ไม่ prewarm, login เต็มตอนเที่ยง), `WIPE_GUARD=0` / `WIPE_HOLD_SEC` (§10.10), `SUBMIT_VIA=click` (กดปุ่มจริงแทน fetch POST), `PREWARM_LEAD_SEC` (default 300)

---

## 5. โครงสร้างโปรเจกต์ (Project Structure)

```
court-booking-bot/
├── package.json
├── config/
│   ├── users.json             ← user ของ bot + account (credential + slot) — gitignored
│   ├── users.example.json
│   ├── accounts.json          ← COURT_PRIORITY + account ของ CLI — gitignored
│   ├── court-ids.json         ← cache label → id ของสนาม
│   └── run-state.json         ← วันที่ cron ยิง / dispatch (watchdog) — gitignored
├── src/
│   ├── server/
│   │   ├── bot.ts             ← คำสั่ง Telegram, cron 11:55, runScheduledBooking, watchdog
│   │   ├── bookingEngine.ts   ← runPrewarmedBatch (prewarm → tick → dispatch) / runStandard
│   │   ├── runReport.ts       ← §7 JSON report + retention 30 วัน
│   │   ├── runState.ts        ← สถานะสำหรับ missed-noon watchdog
│   │   ├── userStore.ts       ← อ่าน/เขียน users.json
│   │   ├── configLoader.ts    ← อ่าน accounts.json / COURT_PRIORITY
│   │   ├── telegramSend.ts, botLog.ts, rehearse.ts
│   │   └── test*.ts           ← ชุดทดสอบ mock
│   ├── bookingFlow.ts         ← bookOneAccount: login → เลือกสนาม → submit → verify (+ holdForWipe)
│   ├── wipeGuard.ts           ← เฝ้า reservations.php หลังเที่ยง (§10.10)
│   ├── courtIdCache.ts
│   ├── scheduler.ts           ← CLI: รอเที่ยงตรงแล้ว trigger
│   └── runner.ts              ← CLI: Promise.all() ของ accounts.json
├── reports/                   ← bot-run-*.json (auto-generated)
├── screenshots/<YYYY-MM-DD>/  ← 1 รูปต่อ account ทั้ง PASS และ FAIL
└── bot.log
```

### ตัวอย่าง `config/accounts.json`

```json
{
  "COURT_PRIORITY": ["แบดมินตัน2", "แบดมินตัน1"],
  "accounts": [
    { "username": "<username>", "password": "<password>", "slot": "18:30_19:30" },
    { "username": "<username>", "password": "<password>", "slot": "19:30_20:30" }
  ]
}
```

`config/users.json` ใช้โครงตาม `config/users.example.json` (`users[]` → `role`, `chat_id`, `display_name`, `accounts[]`)

---

## 6. Scheduler Logic (ละเอียด)

### 6.1 CLI (`npm start`) — แนวคิดของ `src/scheduler.ts`

```typescript
async function waitUntilNoonThenRun(): Promise<void> {
  const now = new Date();
  const target = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(),
    12, 0, 0, 0   // 12:00:00.000 น. ตรง ไม่มี tolerance
  );

  const diff = target.getTime() - Date.now();

  if (diff <= 0) {
    console.log("⚠️  เลยเที่ยงไปแล้ว — เลือก: (1) รอพรุ่งนี้  (2) รันเดี๋ยวนี้");
    // รับ input แล้วตัดสินใจ
    return;
  }

  console.log(`⏳ รอ ${Math.floor(diff / 1000)} วินาที จนถึง 12:00:00 น.`);
  // แสดง countdown แบบ real-time
  await new Promise(resolve => setTimeout(resolve, diff));

  console.log("🚀 12:00:00 — เริ่ม booking ทุก account พร้อมกัน!");
  await runAllAccounts();
}
```

### 6.2 Telegram bot (production) — `src/server/bot.ts` + `src/server/bookingEngine.ts`

| เวลา (T = 12:00:00.000) | ขั้น | รายละเอียด |
|---|---|---|
| 11:55 | cron ยิง | เลือก user: owner (cron on) + friend ที่ cron on + friend ที่ cron off แต่ส่ง `/book` รอบนี้; DM แจ้งล่วงหน้าให้คนที่ cron on; ใครปิด cron ระหว่างนี้ → ข้าม + DM |
| 11:55 | alarm + เปิด Chrome | ตั้ง timer T-4m ก่อน `chromium.launch()` — ถ้าทุก account ล้ม → DM owner (§10.11) |
| T-5m → T-40s | prewarm | ทุก account login ใน context ใหม่พร้อมกัน → `page-ready` / `login-ready` / `needs-standard` / `failed`; `failed` retry ทุก 30s; ถึง T-40s ยังล้มหมด → เปิด Chrome ใหม่ (§10.6, §10.11) |
| T-40s → T | ล็อกเป้าหมาย | heads-up ข้อมูลก่อน reset (§3.4), กำหนดสนามของแต่ละ account, สร้าง wipe guard — หลัง T ไม่มีงานอื่นนอกจาก dispatch |
| T | dispatch | `bookOneAccount` ของทุก account ใน tick เดียว; ตื่นสายเกิน 30s → ไม่ยิง, FAIL `missed-deadline` |
| T+1s → T+10s | wipe hold | เฝ้า reservations.php, account ที่ถูกลบจองใหม่; PASS ต้องเจอชื่อใน list (§10.10) |
| ≤ T+90s | รายงาน | DM ราย user ทันทีที่ account ของ user นั้นจบ (เกิน 90s → `ERROR`, §10.5), JSON report (§10.7), สรุปให้ owner; ปิด Chrome แบบ detached |
| ตั้งแต่ 12:05 | watchdog | วันนี้ยังไม่ dispatch ทั้งที่มี user เปิด cron → DM owner วันละครั้ง (§10.8) |

`DEEP_PREWARM=0` → ข้าม prewarm: รอ T แล้ว login + จองทุก account แบบ standard (`runStandard`)

---

## 7. Report Requirements

แต่ละ account ต้องบันทึก:

| Field | คำอธิบาย |
|-------|----------|
| `username` | account ที่รัน |
| `triggered_at` | timestamp จริงที่เริ่ม (ควรเป็น 12:00:00.xxx) |
| `court_attempted` | สนามแรกที่ลอง — หัวลำดับ `COURT_PRIORITY` ที่หมุนแล้วของ account นั้น (§3.4) |
| `court_booked` | สนามที่จองได้จริง — อ่านจากคอลัมน์ สนาม ใน reservations.php ไม่ใช่จาก id ที่ส่งไป (§10.10) |
| `slot` | เวลาที่จอง |
| `status` | `PASS` / `FAIL` / `ERROR` |
| `fail_reason` | เหตุผลถ้า fail เช่น `slot {slot} ไม่ว่างในทุกสนาม`, `login failed (…)`, `server: already booked today`, `missed-deadline: …`, `การจองถูกเว็บลบหลังเที่ยง (+2.1s) — จองใหม่ไม่สำเร็จ: …` |
| `screenshot` | path ของ screenshot `screenshots/<YYYY-MM-DD>/<username>.png` (บันทึกเสมอทั้ง pass และ fail; โหมด bot ถ่าย reservations.php หลังจบ wipe hold) |
| `duration_ms` | เวลาที่ใช้ทั้งหมดต่อ account |

โหมด bot เขียน field เหล่านี้ลง `reports/bot-run-<fire ISO>.json` พร้อม field เสริมระดับรอบ (`fired_at`, `drift_ms`, `mode`, `prewarm` tallies, …) และต่อ account (`attempts`, `verification`) — ดู §10.7 และ §10.10

---

## 8. Acceptance Criteria

- [ ] รันเที่ยงตรง 12:00:00 น. พอดี — ไม่มี tolerance
- [ ] ทุก account ของทุก user เริ่มพร้อมกัน (parallel) ใน tick เดียว — account ที่ช้าไม่ถ่วงคนอื่น
- [ ] แต่ละ account ได้ BrowserContext ใหม่แยกกัน (ไม่ share cookie/session)
- [ ] Court priority อยู่ที่ top-level `COURT_PRIORITY` ใน config/accounts.json (ไม่ hardcode ใน code)
- [ ] account ที่ slot เดียวกันได้ลำดับสนามแบบหมุน (§3.4)
- [ ] Pre-reset heads-up DM ถึง owner เมื่อข้อมูล T-5min บอกว่า slot เต็มทุกสนาม — ไม่เปลี่ยนการยิง (§3.4, §10.11)
- [ ] Per-court slot fallback ปิด — ลองเฉพาะ slot ของ account เท่านั้น
- [ ] แต่ละ account จองเวลา slot ของตัวเองตาม config
- [ ] บันทึก screenshot ทุก account ทั้ง PASS และ FAIL
- [ ] PASS ก็ต่อเมื่อชื่อ account อยู่ใน reservations.php ตอนจบ hold window (§10.10)
- [ ] Report สรุปผลรวมของทุก account (JSON report + DM ราย user + สรุปให้ owner)

---

## 9. สิ่งที่ต้องเติมก่อน implement

> **ไม่มี action item ค้าง** — slot ของทุก account ระบุแล้วใน `config/users.json` / `config/accounts.json` (รูปแบบ `HH:MM_HH:MM`, ดู §2). ข้อเดิม "ระบุ slot ทั้ง 9 คนแทน TBD" ปิดแล้ว

---

## 10. Operational Notes (user-approved divergence from spec)

ข้อต่อไปนี้คือ **deviation** จาก spec เดิม (§3–§8) — อนุมัติโดย user แล้วทุกข้อ เพื่อแก้บั๊กที่เจอจริงตั้งแต่ 2026-06-30. เมื่อขัดกับ section ก่อนหน้า ให้ถือ §10 เป็นหลัก:

### 10.1 Telegram DM delivery — telegraf 4.x outbound hang (fix A)

**ปัญหา**: `bot.telegram.sendMessage()` ใน telegraf 4.x แขวนไม่ resolve บน network นี้ (telegraf ใช้ http.Agent ร่วมกับ long-poll loop ทำให้ outbound call คิว 30+ วินาที และบางครั้งไม่ resolve เลย — ดู [src/server/bot.ts:683-688](src/server/bot.ts)).

**Fix**: สร้าง [src/server/telegramSend.ts](src/server/telegramSend.ts) ใหม่ เรียก Telegram Bot API ตรง ๆ ด้วย native `fetch` + `AbortController` (15s timeout). Mirror pattern ของ `startPollingLoop()` สำหรับ inbound.

- 3 call sites ที่ `bot.ts:609, 619, 632` ถูกเปลี่ยนเป็น `sendTelegramMessage(...)`
- ทุก call log structured line ลง `bot.log`: `[telegram-send] ok/FAIL/timeout chat=X ms=N`
- ส่ง DM สำเร็จ → user ได้รับ report ภายใน 15s ของ FIRE; fail → มีบรรทัด log ที่บอก reason

### 10.2 Success detection — false-negative บน susport status page (fix B)

**ปัญหา**: หลังคลิก submit, susport redirect ไปหน้า "การจองสนามวันนี้" (status table แสดง `เต็มแล้ว` ทุก slot ที่จองแล้ว) แต่ไม่มีข้อความ success แบบที่ bot ค้นหา ([src/bookingFlow.ts:102](src/bookingFlow.ts) `SUCCESS_INDICATORS`). Bot ตรวจเจอ `'เต็ม'` ใน `FAILURE_INDICATORS` ([src/bookingFlow.ts:103](src/bookingFlow.ts)) → false-negative → record เป็น ERROR ทั้งที่ server จองสำเร็จ

**Fix**: ตัด `'เต็ม'` ออกจาก `FAILURE_INDICATORS` (ไม่ใช่ explicit-failure บน status page) + เพิ่ม `STATUS_PAGE_HEADER = 'การจองสนาม'` เป็นตัวบอกหน้า status — ถ้า page มี header นี้ + ไม่มี explicit-failure word → treat เป็น success. ดู [src/bookingFlow.ts:103-113](src/bookingFlow.ts) และ [src/bookingFlow.ts:312-326](src/bookingFlow.ts).

### 10.3 Acceptance delta

- **เดิม (§8)**: "ทุก account บันทึก PASS/FAIL/ERROR + screenshot"
- **เพิ่ม**: report ส่งผ่าน Telegram DM ภายใน 15s ของ noon trigger ไม่ค้าง indefinite; บน susport status-page-success → record PASS (ไม่ใช่ ERROR)

### 10.4 Slot-first / court-priority-second refactor (2026-07-07)

**ปัญหา**: 2026-07-07 เจอ 4 accounts พร้อม warm slot เดียวกันใน `แบดมินตัน1` — priority เดิม court-first (assigned-court → fallback → other badminton) ไม่ได้ enforce "ทุก account มี slot ตัวเองใน court ที่จองได้"

**Fix**: 
- เปลี่ยน priority เป็น **slot-first, court-priority-second**: ทุก account ลอง `COURTS[0]` ก่อนด้วย slot ของตัวเอง → fallback `COURTS[1]` → safety-net (other badminton)
- **Per-court slot fallback ปิด** — ถ้า slot ตัวเองไม่ว่างใน court นั้น → ข้ามไป court ถัดไป (ไม่ลอง slot อื่นใน court เดียวกัน)
- Court priority ย้ายจาก hardcode `แบดมินตัน1` → `แบดมินตัน4` เป็น config-driven ที่ top-level `COURT_PRIORITY` ใน `config/accounts.json` (default `["แบดมินตัน2", "แบดมินตัน1"]`)
- **Deep-prewarm invariant check**: ที่ T-5min ถ้า account ไหรไม่มี (priority + safety-net court) ที่ slot ตัวเองว่างเลย → ABORT prewarm + console error + Telegram DM to owner *(ยกเลิก 2026-08-22 — ลดเป็น heads-up ที่ไม่เปลี่ยนการยิง ดู §10.11)*
- Per-account `court` field กลายเป็น `@deprecated` (เก็บไว้เพื่อ backward compat กับ running accounts/users.json ที่อาจยังมี field นี้ — loaders tolerate undefined)

**ไฟล์ที่เปลี่ยน**:
- `config/accounts.json` — schema ใหม่ `{COURT_PRIORITY, accounts}`; per-account `court` ออก
- `src/server/configLoader.ts` (NEW) — single source of truth, validate schema
- `src/bookingFlow.ts` — `prioritizeCourts` → `buildCourtPriority(priorityList, available)`; `slotOrder` collapse เหลือแค่ `account.slot`; FAIL message ใหม่ `slot {slot} ไม่ว่างในทุกสนาม`
- `src/server/bookingEngine.ts` — invariant check + `sendDeepPrewarmAbortAlert` helper; `DeepPrewarmEngineResult.prewarmAborted` + `abortedAccounts`
- `src/server/userStore.ts` — `Account.court` → optional deprecated
- `src/runner.ts`, `src/scheduler.ts` — ใช้ `configLoader`; pass `courtPriority: COURTS`
- `src/server/bot.ts` (prewarm notice) — group display ตาม slot ไม่ใช่ per-account court
- `src/server/{testWizardHelpers,testPrewarmNotice,sendDryRunMessages}.ts` — test mirrors + assertions sync กับ production

### 10.5 Phase-3 time bounds (log audit 2026-09-28, งาน A)

**ปัญหา**: 11 และ 15 ก.ย. prewarm ล้มหมด แล้ว Chrome ค้างระหว่าง Phase 3 — `Promise.all` ไม่มีเพดาน, `fetch()` ใน `page.evaluate` และ `browser.newContext()` ไม่มี timeout → DM ผลออก 12:12 และ 12:51.

**Fix** (user-approved Q-A1/Q-A2):
- in-page fetch ใช้ `AbortController`: booking POST 15s, `get_reserved_times.php` 8s/สนาม, `reservations.php` 8s. POST ที่ถูก abort ยังผ่าน `confirmViaReservationsIfUnclear` ก่อนลองสนามถัดไป (กันจองซ้ำ)
- `browser.newContext()` ใน standard path race 20s; context ที่มาช้าถูกปิดทันทีที่มาถึง
- `ACCOUNT_SETTLE_BUDGET_MS = 90s` ต่อบัญชีใน Phase 3 และ `runStandard`: เกินเพดาน → `status: ERROR`, `fail_reason: "timeout: ไม่จบภายใน 90s — ผลจริงไม่ทราบ ให้เช็ค reservations.php"` และ DM ทันที; งานจริงวิ่งต่อ, ผลจริง log เป็น `[result-late]` และบันทึกลง report (หรือ `bot-run-*.late.json`) — ไม่ส่ง DM ซ้ำ
- timer ตั้งหลัง submit ทุกบัญชีออกไปแล้วเท่านั้น (ไม่มีงานเพิ่มระหว่าง 12:00:00.000 กับ submit); teardown แบบ detached รอให้งานที่วิ่งต่อจบก่อนปิด browser

**Acceptance delta**: ไม่มีบัญชีไหนรอผลเกิน 90s หลัง dispatch; run ปกติ (จบ ≤ 8s) ไม่เปลี่ยน.

**ไฟล์**: `src/bookingFlow.ts`, `src/server/bookingEngine.ts`, `src/server/bot.ts`

### 10.6 Cancel cut prewarm rounds + fresh browser after total outage (งาน B)

**ปัญหา**: 15 ก.ย. prewarm round ที่ถูก CUT แค่ทิ้งผล — context ค้าง 51 ตัว (+ standard 17) ใน Chrome ตัวเดียวกับที่ Phase 3 ต้องใช้, ปิดเสร็จหลัง 18 นาที.

**Fix** (user-approved Q-B1):
- ตอน round ถูก seal → context ของบัญชีที่ยังไม่ settle ถูก `closeWithTiming` ทันที (ครั้งเดียว) ก่อนเริ่ม retry รอบใหม่; context ที่ `newContext()` ยังค้างอยู่ถูกปิดทันทีที่มาถึง
- หลัง retry window (T-40s) ถ้าทุกบัญชี `failed` → launch browser ใหม่ให้ Phase 3 (race 20s และไม่เลยเวลายิง); ไม่ทัน/ล้ม → ใช้ตัวเดิม + `[WARN]`
- `cleanupBatch` ปิดทุก browser ของรอบนั้น

**ไฟล์**: `src/server/bookingEngine.ts`

### 10.7 Bot-mode §7 report + retention (งาน D)

**ปัญหา**: โหมด bot ไม่เขียน JSON report (§7) เลย ผลรายบัญชีมีแค่ใน DM และ `<username>.png` ถูกทับทุกวัน.

**Fix** (user-approved Q-D1):
- เขียน `reports/bot-run-<fire ISO>.json` ทุก exit path (ปกติ / drift-guard SKIPPED / batch throw) — field §7 ครบทุกบัญชี + `fire_time`, `fired_at`, `drift_ms`, `mode`, `prewarm` tallies, `total_ms`, `counts`; เขียนไม่ได้ → `console.warn` ไม่ throw
- log `[result] <username> <status> court=… slot=… <ms>ms reason=…` ต่อบัญชี
- screenshot เก็บที่ `screenshots/<YYYY-MM-DD>/<username>.png` (วันตามเวลา Bangkok)
- เก็บ 30 วัน: ตอนเขียน report ใหม่ ลบเฉพาะ `reports/bot-run-*` และโฟลเดอร์วันที่ใน `screenshots/` ที่เก่ากว่า 30 วัน

**ไฟล์**: `src/server/runReport.ts` (NEW), `src/server/bookingEngine.ts`, `src/server/bot.ts`, `src/server/rehearse.ts`

### 10.8 Missed-noon watchdog (งาน E)

**ปัญหา**: ก.ย. 2026 ไม่ได้ยิง 6 วันโดยไม่มีใครรู้ — Mac หลับตอน 11:55 และ `node-cron` ไม่ยิงย้อนหลังเมื่อเครื่องตื่น.

**Fix** (user-approved Q-E1):
- `config/run-state.json` (gitignored): `last_cron_fired_date`, `last_dispatch_date`, `missed_alert_date` (วันตาม Bangkok) — dispatch นับทั้ง FIRE และ SKIPPED
- watchdog ตอน start และทุก 60s: ตั้งแต่ 12:05 ถ้ามี user ที่เปิด cron และมีบัญชี แต่วันนี้ยังไม่ dispatch → DM owner `⚠️ พลาดรอบ 12:00 วันนี้ …` วันละครั้ง. **ไม่จองย้อนหลัง** (SC-04)
- การกันเครื่องหลับ (เสียบไฟ / ไม่ปิดฝา / `pmset`) เป็นหน้าที่ของ user — ไม่ทำในโค้ด

**ไฟล์**: `src/server/runState.ts` (NEW), `src/server/bookingEngine.ts` (`onDispatched`), `src/server/bot.ts`

### 10.9 Startup + log retention (งาน F)

**ปัญหา**: `getMe` ล้ม → `process.exit(1)` → launchd restart วน (1, 16 ก.ย.); ถ้าเน็ต/DNS ล่มตอน 11:55 cron จะไม่ถูกตั้ง. `bot.log` ถูกล้างทุก restart.

**Fix** (user-approved Q-F):
- ตั้ง cron + watchdog ก่อน โดยไม่ขึ้นกับ Telegram; `getMe` retry backoff 5s, 10s, 30s แล้วทุก 60s ไม่ exit; long-poll เริ่มหลัง `getMe` ผ่าน
- `bot.log` append ข้าม restart, rotate เป็น `bot.log.1` เมื่อเกิน 5MB (เก็บ 1 ไฟล์)

**ไฟล์**: `src/server/botLog.ts` (NEW), `src/server/bot.ts`

**ทดสอบ (10.5–10.9)**: `npm run test:log-audit` — mock server (`node:http`) + Chrome จริง, ไม่แตะเว็บจริงและ Telegram

### 10.10 Post-noon wipe guard (2026-10-01)

**ปัญหา**: เว็บลบการจอง**ทุกแถว**ที่เข้ามาก่อนประมาณ 12:00:02 — ของทุกคน ไม่ใช่แค่บอท — แล้วเก็บเฉพาะแถวที่เข้ามาหลังจากนั้น. เห็นใน screenshot ของ 28/09, 30/09, 01/10 (จุดตัด +1.97s ถึง +2.35s; นาฬิกาเครื่องต่างจาก NTP ~70ms และ server ต่างจากเครื่อง ≤0.2s จึงไม่ใช่ clock skew). บอทให้ PASS จากคำตอบของ POST + การอ่าน reservations.php ทันที (ก่อนถูกลบ) จึงรายงาน PASS 14–15 บัญชีต่อวัน แต่เหลือจองจริง 1–7. บัญชีที่รอดคือบัญชีที่ POST ค้างคิว server จนเลยจุดตัด.

**Fix** (user เลือกทาง A):
- รอบแรกยิงที่ 12:00:00.000 เหมือนเดิม — SC-04 ไม่เปลี่ยน และไม่มีงานใหม่ระหว่าง tick กับ submit
- `src/wipeGuard.ts`: ตั้งแต่ FIRE+1s อ่าน reservations.php (รายการรวมของทุกคน) ผ่าน session ของบัญชีที่จบรอบแรกแล้ว ทุก 150ms (พร้อมกันไม่เกิน 2 request; ช้าลงเป็นทุก 1s หลังเห็นการลบ 2s หรือหลัง FIRE+5s ถ้ายังไม่เห็น). ประกาศ `WIPE detected` เมื่อแถวของ list ก่อนหน้าหายพร้อมกัน ≥3 แถวและ ≥50%
- แต่ละบัญชี (`holdForWipe` ใน `src/bookingFlow.ts`) ถือผลไว้จนจบ hold window (FIRE+10s). ถ้า list ที่ขอหลัง submit ล่าสุดของตัวเองไม่มีชื่อตัวเอง → จองใหม่ทันทีที่สนามแรกที่ slot ยังว่าง: ลำดับ `COURT_PRIORITY` เฉพาะสนามที่ยังใช้ได้ หมุนตามตำแหน่งของบัญชีใน slot เดียวกัน (ข้ามสนามที่ตอบ "เกิดข้อผิดพลาดในการบันทึกข้อมูล" ≥2 ครั้ง ไม่มีใครจองได้ และมีสนามอื่นใช้ได้). ไม่ submit เลยเมื่อชื่อยังอยู่ใน list (กันจองซ้อน); แพ้ race / DB error → ลองสนามถัดไปทันที; ผลกำกวม → อ่าน list ใหม่ก่อน; เว็บตอบ "จองแล้ว" → หยุด submit; สูงสุด 6 submit ต่อบัญชี
- ใช้กับทุกบัญชีที่รอบแรกจบเป็น PASS หรือ FAIL — รวม FAIL เพราะ slot เต็มก่อนการลบ (หลังลบ slot ว่างอีกครั้ง). ERROR / login ไม่ผ่าน / dry run ไม่เข้า hold
- สถานะสุดท้ายมาจาก list ตอนจบ window: PASS เฉพาะเมื่อมีแถวของบัญชีนั้น (`court_booked` = สนามในแถว); ไม่มี → FAIL พร้อมเหตุผล เช่น `การจองถูกเว็บลบหลังเที่ยง (+2.1s) — จองใหม่ไม่สำเร็จ: …`. อ่าน list ไม่ได้เลย → คงผลรอบแรกและ log `[verify] … left unverified`
- screenshot §7 ถ่าย reservations.php หลังจบ hold (สภาพสุดท้าย); report มี `verification` ต่อบัญชี (`checked_at`, `row`, `wipe_detected_at`, `first_wave_status`, `hold_submits`) และ attempt ชนิด `wiped`
- `recordActualCourt` ไม่เอา "แถวเดียวในตาราง" มาแทนแถวของเราอีก (list เป็นของทุกคน — แถวนั้นอาจเป็นของคนอื่นและสอน court-id cache ผิด)
- `npm run rehearse` อ่าน reservations.php 1 ครั้งหลัง dry run → `[wipe] rehearsal probe: … N row(s)` (ยืนยันว่า parse layout จริงได้)
- kill-switch `WIPE_GUARD=0` = พฤติกรรมก่อน 2026-10-01; `WIPE_HOLD_SEC` ปรับ window (default 10)

**Acceptance delta**: DM ผลออกประมาณ FIRE+10–11s (เดิม +3–5s). PASS = มีชื่อใน reservations.php ณ จบ window. **ยังไม่รู้** ว่าเว็บให้บัญชีที่ถูกลบจองใหม่ได้หรือไม่ (กฎ 1 ครั้ง/วัน — ไม่เคยเห็นเว็บตอบ "จองแล้ว" จาก POST เลย); รอบเที่ยงแรกจะบอกผ่าน `[verify]` และ `hold: already-booked`.

**ไฟล์**: `src/wipeGuard.ts` (NEW), `src/bookingFlow.ts`, `src/server/bookingEngine.ts`, `src/server/testLogAudit.ts` (mock: list รวม, 1 แถวต่อ (สนาม, slot) และต่อ user, wipe, outsiders, คิว/ส่งช้า, DB error ต่อสนาม), `package.json`

**ทดสอบ**: `npm run test:wipe` (w-wipe, w-nowipe, w-lost, w-already, w-killswitch) + `npm run test:log-audit` ทั้งชุด

### 10.11 Bot engine as built (2026-08-22 → 08-31)

บันทึกย้อนหลังของการเปลี่ยนแปลงที่ตกลงกันจาก audit 2026-08-22 และรอบเที่ยงแรก ๆ — ก่อนหน้านี้มีแค่ใน commit message

**Single-batch engine + prewarm states** (`ed7357b`, 2026-08-22):
- batch เดียวสำหรับทุก user: browser เดียว, context ใหม่ต่อ account, `Promise.all` ครั้งเดียวที่ tick (engine แยกต่อ user เดิมทำให้ user ที่สองช้ากว่า 45–280ms); DM ราย user ทันทีที่ account ของ user นั้นจบ แล้วสรุปให้ owner
- สถานะ prewarm ต่อ account: `page-ready` (login + เลือกสนาม/slot แล้ว → POST ทันทีตอน T) / `login-ready` (dropdown 11:55 ยังเป็นข้อมูลเมื่อวานจนเลือกไม่ได้ → ตอน T ใส่ id สนามจาก `config/court-ids.json` แล้ว POST, ไม่มี id → reload 1 ครั้ง) / `needs-standard` (login แล้วไป reservations.php = จองไว้แล้ว) / `failed` (retry ทุก 30s ถึง T-40s, ที่เหลือ login ใหม่ตอน T)
- Deep-prewarm invariant (§10.4) **ลดเป็น heads-up DM** — อ่านจากข้อมูลก่อน reset จึงไม่เปลี่ยนการยิง
- `SUBMIT_VIA=fetch` (default): serialize ฟอร์มจริงแล้ว POST ด้วย `fetch()` ในหน้า (~50ms, ไม่ navigate); `SUBMIT_VIA=click` = rollback
- `DEEP_PREWARM=0` เป็น kill-switch จริง (standard อย่างเดียว); โหมด shallow prewarm ถูกตัด
- ปิด context/browser แบบ detached พร้อม log เวลา (teardown เคยกิน ~11 นาทีก่อนส่ง DM)

**Strict PASS + non-blocking submit** (`efea93f`, 2026-08-22): PASS ต้องเจอ row ของ username ตัวเองใน reservations.php (marker เดิมตรงกับหน้าฟอร์มว่าง → false PASS 5 บัญชี); ข้อความ alert ถูกเก็บเข้า `fail_reason`

**Same-slot de-confliction** (`d76adca`, 2026-08-23): รอบเที่ยงแรกทุก account ที่ slot เดียวกันยิงสนามเดียวกัน — 10/17 POST แรกแข่งกันเอง และ server เก็บแถวซ้ำแบบสุ่ม. แก้: หมุนลำดับ `COURT_PRIORITY` ตามตำแหน่งในกลุ่ม slot (§3.4) ใช้ทั้ง prewarm, ตอน T (page-ready ที่ถูกบังคับไปสนามอื่นจะ retarget กลับสนามของตัวเองด้วย cached id), retry loop และ `runStandard`

**Bounded prewarm rounds + outage DM ตามนาฬิกา** (`763f8db`, 2026-08-31): เน็ตล่มทั้งรอบทำ Phase 1 ยาว 10 นาที. แก้: รอบ prewarm มีเพดาน 50% ของเวลาที่เหลือ (ขั้นต่ำ 30s), ปิด context ที่ล้มแบบ detached, DM total outage ตั้ง timer ที่ T-4m (ย้ายไปตั้งก่อน `chromium.launch()` ใน `b373072`, 2026-09-28)

**`users.json` reload** (`95a5c02`, 2026-08-31): bot อ่าน `config/users.json` ใหม่เมื่อ mtime เปลี่ยน — แก้ไฟล์ได้โดยไม่ restart แต่ต้องบันทึกก่อน 11:55; JSON เสียระหว่างรัน → ใช้ cache เดิม

**Court-id cache eviction** (`e392ebd`, 2026-09-28): id ที่เห็นใหม่ไล่ label อื่นที่ถือ id เดียวกันออก; ไม่ inject id ที่ dropdown แสดงอยู่ใต้ label อื่น; `court_booked` อ่านจาก reservations.php

**ไฟล์**: `src/server/bookingEngine.ts`, `src/bookingFlow.ts`, `src/courtIdCache.ts`, `src/server/userStore.ts`, `src/server/bot.ts`
