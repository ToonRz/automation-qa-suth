# QA Automation — Court Booking System
## `susport.sc.su.ac.th` | Playwright End-to-End

---

## 1. ภาพรวม (Overview)

ระบบ Playwright automation สำหรับจองสนามแบดมินตันบนเว็บ `https://susport.sc.su.ac.th/login.php`  
รัน **9 accounts พร้อมกัน (parallel)** ทุกครั้งที่ถึงเวลา **12:00:00 น. ตรง** ของวันที่กดรัน

---

## 2. Credentials & Time Assignment

| # | Username | Password | เวลาที่จอง (slot) |
|---|----------|----------|-------------------|
| 1 | 650910088 | Pin@2546 | TBD |
| 2 | 671211370 | 123456789guy | TBD |
| 3 | 670910322 | 320032Za | TBD |
| 4 | 671211270 | 123456789eye | TBD |
| 5 | 670911373 | Pt18102548 | TBD |
| 6 | 670910478 | 1104200499085 | TBD |
| 7 | 670910321 | 0877048019Vv | TBD |
| 8 | 670910300 | Jameth2442! | TBD |
| 9 | 670910323 | Jj071047 | TBD |

> **หมายเหตุ:** คอลัมน์ "เวลาที่จอง" ต้องระบุก่อน implement — แต่ละ account จะได้ slot เวลาที่ต่างกัน

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

### 3.4 Court Selection Logic

```
PRIMARY   → แบดมินตัน1
FALLBACK  → แบดมินตัน4
ABORT     → ถ้าทั้ง 2 ไม่ว่าง: status = FAIL, reason = "ทั้ง 2 สนามเต็ม"
```

- ห้ามเลือกสนามอื่นนอกจาก 2 ตัวนี้
- ลำดับ fallback ต้องเป็น 1 → 4 เสมอ (ไม่สลับ)

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
  { "username": "650910088", "password": "Pin@2546",        "slot": "TBD" },
  { "username": "671211370", "password": "123456789guy",    "slot": "TBD" },
  { "username": "670910322", "password": "320032Za",        "slot": "TBD" },
  { "username": "671211270", "password": "123456789eye",    "slot": "TBD" },
  { "username": "670911373", "password": "Pt18102548",      "slot": "TBD" },
  { "username": "670910478", "password": "1104200499085",   "slot": "TBD" },
  { "username": "670910321", "password": "0877048019Vv",    "slot": "TBD" },
  { "username": "670910300", "password": "Jameth2442!",     "slot": "TBD" },
  { "username": "670910323", "password": "Jj071047",        "slot": "TBD" }
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

