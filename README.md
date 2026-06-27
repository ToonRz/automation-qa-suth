# Court Booking Bot — `susport.sc.su.ac.th`

Playwright E2E automation สำหรับจองสนามแบดมินตันบน `https://susport.sc.su.ac.th/login.php`
รัน **9 accounts พร้อมกัน (parallel)** ทุกครั้งที่ถึงเวลา **12:00:00 น. ตรง** ของวันที่กดรัน

> Source of truth: [`requirements.md`](./requirements.md) — ทุกอย่างในโปรเจกต์นี้อ้างอิงจาก spec นั้น

---

## 1. Prerequisites

- **Node.js 18+** (tested on 22.14.0)
- **Google Chrome** (ใช้ channel `chrome` ของ Playwright — ต้องมี `Google Chrome.app` บน macOS หรือติดตั้ง Chrome บน Linux)
- npm 10+

---

## 2. Setup

```bash
# 1. Install npm dependencies
npm install

# 2. (ถ้ายังไม่มี) ติดตั้ง Google Chrome — script จะใช้ channel: 'chrome'
#    macOS: brew install --cask google-chrome
#    Linux: ดู https://www.google.com/chrome/

# 3. Verify Chrome is installed
ls "/Applications/Google Chrome.app"   # macOS
```

> ไม่ต้องรัน `npx playwright install chromium` — เราใช้ system Chrome ผ่าน `channel: 'chrome'`

---

## 3. Configuration — `config/accounts.json`

แก้ไฟล์ `config/accounts.json` ใส่ credentials + court + slot ของแต่ละ account (9 รายการ):

```json
[
  { "username": "<your-username>", "password": "<your-password>", "court": "แบดมินตัน1", "slot": "17:00_18:00" }
]
```

**Slot format:** `HH:MM_HH:MM` (start_end with underscore)
**Court options:** `แบดมินตัน1`, `แบดมินตัน4` (per spec §3.4)

> ⚠️ **ไฟล์นี้อยู่ใน git** — ห้าม commit credentials จริง ดู [Security](#security) ด้านล่าง

---

## 4. How to Run

### 4.1 Scheduled (production mode)

```bash
npm start
```

- ถ้ากด**ก่อนเที่ยง** (≤ 12:00:00) → จะนับถอยหลัง real-time แล้วปล่อย 9 contexts พร้อมกันที่ **12:00:00.000 ตรง** (no tolerance per SC-04)
- ถ้ากด**หลังเที่ยง** → รอจนถึง 12:00:00 ของ**วันถัดไป**อัตโนมัติ

### 4.2 Run now (skip the wait)

```bash
npm run now
```

ปล่อย 9 contexts ทันทีโดยไม่รอ — **ใช้สำหรับเทส live หรือ debug**

### 4.3 Dry-run (no slot consumed)

```bash
npm run dry-run
```

เหมือน `npm run now` แต่**ไม่คลิกปุ่ม "จอง"** — ผ่านขั้นตอน login + court select + slot check ครบทุก account เพื่อ verify ว่า bot ทำงานถูก โดย**ไม่กิน slot จริง**

### 4.4 Single-account debug

```bash
npm run account -- <username>
```

รัน account เดียว end-to-end — ใช้ตอน debug selector / flow เฉพาะ account

### 4.5 Re-discover slots (ถ้าเว็บเปลี่ยน UI)

```bash
# ดู dropdown ของ account ที่ระบุ (default account #2)
npm run discover
npm run discover -- --account=1   # ดู dropdown ของ account index #1
```

Output: `screenshots/` + `reports/slots-discovered.json`

---

## 5. CLI Flags

| Flag                   | Effect                                                        |
|------------------------|---------------------------------------------------------------|
| `--now`                | Skip the scheduler wait; fire immediately                     |
| `--tomorrow`           | Force target = tomorrow's 12:00:00 (even if before noon today) |
| `--dry-run`            | Skip the final "จอง" submit click                             |
| `--account=USERNAME`   | Run only this single account (bypasses scheduler)             |

Compose any: `npm start -- --dry-run` (wait until noon, then dry-run all 9)

---

## 6. Output

ทุกครั้งที่รัน จะได้:

- **`screenshots/{username}.png`** — full-page screenshot ปลายทางของทุก account (PASS และ FAIL)
- **`reports/run-{timestamp}.json`** — combined report ครอบคลุม 9 accounts

Per-account report fields (per requirements §7):

```json
{
  "username": "<username>",
  "triggered_at": "2026-06-27T12:00:00.123Z",
  "court_attempted": "แบดมินตัน1",
  "court_booked": "แบดมินตัน1",
  "slot": "17:00_18:00",
  "status": "PASS",                    // PASS | FAIL | ERROR | DRY-RUN
  "fail_reason": null,
  "screenshot": "/path/to/screenshots/<username>.png",
  "duration_ms": 4321
}
```

Combined run summary:

```json
{
  "started_at": "...",
  "finished_at": "...",
  "total_ms": 10767,
  "counts": { "PASS": 5, "FAIL": 4, "ERROR": 0, "DRY-RUN": 0 },
  "accounts": [ /* 9 per-account results */ ]
}
```

---

## 7. Project Structure

```
.
├── config/
│   └── accounts.json          ← credentials + court + slot (9 accounts)
├── src/
│   ├── scheduler.ts           ← waitUntilNoonThenRun + CLI flags
│   ├── runner.ts              ← Promise.all() ปล่อย 9 contexts พร้อมกัน
│   ├── bookingFlow.ts         ← flow login → court → time → submit ต่อ 1 account
│   └── discoverSlots.ts       ← one-off slot discovery (debug aid)
├── screenshots/               ← auto-generated, หนึ่งไฟล์ต่อ account
├── reports/                   ← auto-generated, หนึ่งไฟล์ต่อ run
├── package.json
├── tsconfig.json
├── CLAUDE.md                  ← project-specific instructions for Claude Code
├── requirements.md            ← source of truth
└── README.md                  ← this file
```

---

## 8. Hard Rules (from requirements)

อย่าละเมิดข้อเหล่านี้:

1. **12:00:00 trigger ตรงเป๊ะ ไม่มี tolerance** (SC-04)
2. **BrowserContext แยกกันทุก account** — `browser.newContext({ storageState: undefined })` ทุกครั้ง (BR-01/02/03)
3. **`context.close()` ทุก exit path** — ทั้ง PASS และ FAIL (BR-04)
4. **Parallel release** — 9 contexts ต้องเริ่มพร้อมกันใน tick เดียวผ่าน `Promise.all` (SC-05)
5. **Screenshot ทุก account** ทั้ง PASS และ FAIL (Report Requirements)
6. **อย่า fabricate slot times** — ถ้ายังไม่รู้ ให้รัน `npm run discover` ก่อน

---

## 9. Troubleshooting

| อาการ                                              | สาเหตุ / แก้                                          |
|----------------------------------------------------|------------------------------------------------------|
| Login ล้มเหลวทุก account                          | เช็ค password ใน `config/accounts.json`              |
| `slot "..." not available on ...` (ทุก account)   | Court นั้นเต็มแล้ว (จะเกิดช่วงหลังเที่ยง)             |
| Time dropdown ว่างเปล่า                            | AJAX ยังไม่ทำงาน หรือ slot ถูกจองหมดแล้ว             |
| `submit result unclear`                            | ตรวจ screenshot — หน้าเว็บอาจ redirect ไป URL ที่เราไม่รู้จัก |
| All 9 accounts fail at exactly the same time      | Network issue หรือ site ล่ม — เช็ค `https://susport.sc.su.ac.th/login.php` ใน browser ปกติ |
| Chrome not found                                   | ติดตั้ง Chrome แล้วลองใหม่ หรือเปลี่ยน `chromium.launch({ channel: 'chrome' })` ใน `bookingFlow.ts` เป็นไม่ระบุ channel แล้วรัน `npx playwright install chromium` |

---

## 10. Reset / Cleanup

```bash
# ลบ screenshots เก่า
rm -rf screenshots/*.png

# ลบ reports เก่า
rm -rf reports/run-*.json
```

> ไม่ลบ `reports/slots-discovered.json` — เก็บไว้เป็น reference ของ dropdown structure

---

## 11. Security

`config/accounts.json` **มี credentials จริง** — ก่อน push:

1. **ตรวจสอบว่า `accounts.json` ไม่มี credentials จริง commit** — ใช้ placeholders (`"TBD"`) หรือ gitignore ไฟล์นี้
2. **อย่า commit `reports/` หรือ `screenshots/`** — มี username อยู่ใน JSON report (`.gitignore` กันไว้แล้ว)
3. **หาก credentials รั่วไหล** → เปลี่ยน password ทันทีที่ `susport.sc.su.ac.th`
4. สำหรับ production ใช้ `accounts.local.json` (gitignored) แทน แล้วแก้ `src/runner.ts` ให้โหลดจากไฟล์นั้น

### รายการไฟล์ที่มีข้อมูล credentials

| ไฟล์                       | สถานะ                       |
|----------------------------|------------------------------|
| `config/accounts.json`     | ⚠️ **อยู่ใน git** — ใส่ placeholders เท่านั้น |
| `requirements.md` §2       | ⚠️ **อยู่ใน git** — พิจารณาลบ credentials ออกก่อน push |
| `reports/run-*.json`       | ✅ gitignored                |
| `screenshots/*.png`        | ✅ gitignored                |
| `reports/slots-discovered.json` | ⚠️ **อยู่ใน git** — มี username ใน `account_used` |