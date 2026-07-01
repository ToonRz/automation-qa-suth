# QA Automation — Court Booking System
## `susport.sc.su.ac.th` | Playwright End-to-End

---

## 1. ภาพรวม (Overview)

ระบบ Playwright automation สำหรับจองสนามแบดมินตันบนเว็บ `https://susport.sc.su.ac.th/login.php`  
รัน **9 accounts พร้อมกัน (parallel)** ทุกครั้งที่ถึงเวลา **12:00:00 น. ตรง** ของวันที่กดรัน

---

## 2. Credentials & Time Assignment

| # | Username    | Password    | เวลาที่จอง (slot) |
|---|-------------|-------------|-------------------|
| 1 | `<username>`| `<password>`| TBD               |
| 2 | `<username>`| `<password>`| TBD               |
| 3 | `<username>`| `<password>`| TBD               |
| 4 | `<username>`| `<password>`| TBD               |
| 5 | `<username>`| `<password>`| TBD               |
| 6 | `<username>`| `<password>`| TBD               |
| 7 | `<username>`| `<password>`| TBD               |
| 8 | `<username>`| `<password>`| TBD               |
| 9 | `<username>`| `<password>`| TBD               |

> **หมายเหตุ:** คอลัมน์ "เวลาที่จอง" ต้องระบุก่อน implement — แต่ละ account จะได้ slot เวลาที่ต่างกัน
>
> **Security:** credentials จริงเก็บใน `config/accounts.json` เท่านั้น (ไฟล์นี้ใช้ placeholders สำหรับ public spec)

---

## 3. Functional Requirements

### 3.1 Scheduler — รันเที่ยงตรง

| ID | ข้อกำหนด |
|----|----------|
| SC-01 | เมื่อผู้ใช้กด Run ระบบต้องคำนวณ `target = วันนั้น 12:00:00 (local time)` |
| SC-02 | ถ้ากดก่อนเที่ยง → หน้าจอแสดง countdown และรอจนถึง **12:00:00 น. ตรงพอดี** |
| SC-03 | ถ้ากดหลังเที่ยงแล้ว → แจ้ง "เลยเวลาแล้ว" และถามว่าจะรอพรุ่งนี้หรือรันทันที |
| SC-04 | **ไม่มี tolerance** — trigger ที่ 12:00:00 เท่านั้น |
| SC-05 | เมื่อถึงเวลา ให้ปล่อย 9 browser context พร้อมกันทันที (parallel launch) |

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
6. เลือกสนาม "แบดมินตัน1"
   └─ ถ้าสนามเต็ม → fallback เลือก "แบดมินตัน4"
   └─ ถ้าทั้ง 2 เต็ม → บันทึก FAIL + screenshot แล้วจบ
7. เลือก slot เวลาของ account นั้น (ตาม Time Assignment ข้อ 2)
8. ยืนยันการจอง (กด submit / confirm)
9. ตรวจสอบว่าการจองสำเร็จ → บันทึก PASS + screenshot
10. context.close()
```

### 3.4 Court Selection Logic — Retry-with-Fallback

```
PRIMARY     → แบดมินตัน1
FALLBACK    → แบดมินตัน4
EXTENDED    → แบดมินตันอื่นๆ ที่ dropdown มี (แบดมินตัน2, 3, 5, 6, …) — ยกเว้นเทนนิส
ABORT       → ไม่เจอ (court, slot) ใดว่างภายใน 30s: status = FAIL
```

**Slot priority (ต่อ 1 court):** assigned slot ก่อน → slot อื่นที่ dropdown มีให้

**Retry budget:** สูงสุด **30 วินาที** ต่อ account (เริ่มนับหลัง login เสร็จ) — ถ้าเกินจะหยุด loop และบันทึก FAIL

**Exit conditions (หยุด loop ทันที):**
- ✅ `success` → PASS
- 🚫 `already-booked-today` (server ตอบว่า "คุณได้จองสนามวันนี้แล้ว") → FAIL
- ⏰ deadline หมด → FAIL

**Special case:** ถ้า submit fail แล้ว server redirect ออกจาก `booking.php` ต้อง `goto(booking.php)` ก่อน retry (handled in `resetToBookingPage()`)

> **หมายเหตุ:** พฤติกรรมนี้ขยายจาก spec เดิม (ที่ระบุ ABORT = ทั้ง 2 เต็ม) — เพิ่ม EXTENDED layer เพื่อเพิ่มโอกาสสำเร็จ และรองรับกรณีที่สนามอื่นยังมี slot ว่าง

---

## 4. Technical Stack

| Component | ค่าที่กำหนด |
|-----------|-------------|
| Language | TypeScript (Node.js) |
| Automation | Playwright |
| Parallelism | `Promise.all()` — 9 context พร้อมกัน |
| Browser | Chromium (Playwright built-in) หรือ `channel: 'chrome'` |
| Scheduler | Node.js native — `setTimeout` คำนวณจาก `Date` |
| Config | `accounts.json` แยก credential + slot ออกจาก code |
| Report | JSON + HTML (Playwright HTML reporter) + screenshot on fail |

---

## 5. โครงสร้างโปรเจกต์ (Project Structure)

```
court-booking-bot/
├── package.json
├── playwright.config.ts
├── config/
│   └── accounts.json          ← credentials + เวลาจองของแต่ละ account
├── src/
│   ├── scheduler.ts           ← รอเที่ยงตรงแล้ว trigger
│   ├── runner.ts              ← Promise.all() ปล่อย 9 context พร้อมกัน
│   └── bookingFlow.ts         ← flow login → เลือกสนาม → จอง ของ 1 account
├── reports/
│   └── (auto-generated)
└── screenshots/
    └── (auto-generated on fail)
```

### ตัวอย่าง `config/accounts.json`

```json
[
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" },
  { "username": "<username>", "password": "<password>", "slot": "TBD" }
]
```

---

## 6. Scheduler Logic (ละเอียด)

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

---

## 7. Report Requirements

แต่ละ account ต้องบันทึก:

| Field | คำอธิบาย |
|-------|----------|
| `username` | account ที่รัน |
| `triggered_at` | timestamp จริงที่เริ่ม (ควรเป็น 12:00:00.xxx) |
| `court_attempted` | แบดมินตัน1 หรือ แบดมินตัน4 |
| `court_booked` | สนามที่จองได้จริง |
| `slot` | เวลาที่จอง |
| `status` | `PASS` / `FAIL` / `ERROR` |
| `fail_reason` | เหตุผลถ้า fail (เช่น "ทั้ง 2 สนามเต็ม", "login failed") |
| `screenshot` | path ของ screenshot (บันทึกเสมอทั้ง pass และ fail) |
| `duration_ms` | เวลาที่ใช้ทั้งหมดต่อ account |

---

## 8. Acceptance Criteria

- [ ] รันเที่ยงตรง 12:00:00 น. พอดี — ไม่มี tolerance
- [ ] 9 accounts เริ่มพร้อมกัน (parallel) ภายใน millisecond เดียวกัน
- [ ] แต่ละ account ได้ BrowserContext ใหม่แยกกัน (ไม่ share cookie/session)
- [ ] เลือก แบดมินตัน1 ก่อน → fallback แบดมินตัน4 → FAIL ถ้าทั้งคู่เต็ม
- [ ] แต่ละ account จองเวลา slot ของตัวเองตาม config
- [ ] บันทึก screenshot ทุก account ทั้ง PASS และ FAIL
- [ ] Report สรุปผลรวมของทั้ง 9 accounts

---

## 9. สิ่งที่ต้องเติมก่อน implement

> **Action item เดียวที่เหลือ:**
> ระบุ **slot เวลาของแต่ละ account** ทั้ง 9 คน (แทนที่ "TBD" ใน accounts.json)
> เช่น "08:00", "09:00", "10:00" ฯลฯ ตามที่ต้องการจอง

---

## 10. Operational Notes (user-approved divergence from spec)

ข้อต่อไปนี้คือ **deviation** จาก §3.4 / §7 — อนุมัติโดย user แล้ว เพื่อแก้บั๊กที่เจอจริงในวัน 2026-06-30:

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


