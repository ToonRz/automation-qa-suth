# Spec + Tasks: แก้ปัญหาจาก log audit 2026-09-28

> สถานะ: **DRAFT รอ user approve** — ยังไม่ได้ implement อะไร
> กฎ repo (CLAUDE.md): ทุกการแก้ต้องอิง `requirements.md` — ข้อไหน "นอก spec" ติดป้ายไว้ในหัวข้อ
> และต้องได้ approve ก่อนลงมือ. repo เป็น **public** — ห้ามใส่ username / chat id / token ในไฟล์นี้หรือ commit.

---

## 0. บริบท

Audit `bot.stdout.log` ช่วง 2026-09-01 ถึง 2026-09-28 (โค้ด `main` = `e392ebd`):

| ผล | วันที่ |
|---|---|
| ยิงปกติ (drift 0–31ms) | 18 วัน |
| prewarm ล้มหมด 17/17, ผลช้า | 11 ก.ย. (DM 12:12), 15 ก.ย. (DM 12:51) |
| เครื่องหลับกลาง prewarm, dispatch ถูก skip | 5 ก.ย. (drift 619s) |
| ไม่ได้ยิงเลย (Mac หลับ, ไม่มี `[cron] noon trigger`) | 6, 9, 19, 20, 26, 27 ก.ย. |

ปัญหาที่ต้องแก้ (อ้างเลขตามรายงาน audit):

1. ไม่ได้ยิง 6 วันโดยไม่มีใครรู้ → **งาน E**
2. prewarm ล้มหมดแล้ว Phase 3 ไม่มีเพดานเวลา, ผลช้า 12–51 นาที → **งาน A**
3. prewarm รอบที่ถูก CUT ไม่ถูกยกเลิกจริง (15 ก.ย. มี context ค้าง 51 ตัว) → **งาน B**
4. DM เตือน outage ไม่ถูกส่งถ้า `chromium.launch()` ช้า (11 ก.ย.) → **งาน C**
5. โหมด bot ไม่เขียน JSON report / ไม่ log PASS-FAIL → **งาน D**
6. ข้อเล็ก: bot exit ตอน `getMe` ENOTFOUND, `bot.log` ถูกล้างทุก restart → **งาน F**

ลำดับที่แนะนำ: **C → D → A → B → E → F** (เล็กและปลอดภัยก่อน, D ต้องมาก่อน A/B เพื่อให้ตรวจผลของ A/B ได้จาก report)

---

## 1. กฎร่วมทุกงาน

- ห้ามเปลี่ยนพฤติกรรมตอน 12:00:00.000 ของ path ปกติ (17/17 page-ready): ลำดับ dispatch, fetch submit,
  de-confliction, drift guard ต้องเหมือนเดิม. ทุก timeout ใหม่ต้อง "ไม่แตะ" run ที่ปกติ
  (run ปกติ ทุกบัญชีจบใน ≤ 8s — ดู log 23 และ 28 ก.ย.).
- BR-01/02/04: ทุก context ที่สร้างต้องถูก `close()` ทุก exit path (detached ได้ ผ่าน `closeWithTiming`).
- ห้าม restart bot ช่วง **11:50–12:05**.
- ทุกงานต้องผ่าน `npx tsc --noEmit` ก่อน commit, หนึ่งงาน = หนึ่ง commit.

---

## 2. Spec รายงาน

### C. ตั้งตัวเตือน outage ก่อนเปิด browser — *ในกรอบ spec (แก้ bug ของ feature เดิม)*

**ปัญหา:** `runPrewarmedBatch` (`src/server/bookingEngine.ts:472–515`) เรียก `chromium.launch()` ก่อน
แล้วค่อยตั้ง `outageTimer` เฉพาะเมื่อ `alertAt > Date.now()`. 11 ก.ย. launch ใช้ ~2 นาที (11:55→11:57,
คำนวณย้อนจากเวลาที่ round 1 ถูก CUT) → เลย T-4m ไปแล้ว → ไม่ตั้ง timer → ไม่มี 🚨.

**Spec:**
- C1. สร้าง `entries = pendingEntries(accounts)` และตั้ง `outageTimer` **ก่อน** `chromium.launch()`.
- C2. ถ้าตอนเรียก `alertAt <= Date.now()` แล้ว (เช่น cron มาช้า / launch ช้า) → ให้เช็คเงื่อนไข
  "ทุก entry = failed" ทันทีหลัง round แรกจบ (ไม่ใช่ข้ามไปเฉยๆ) และส่ง DM ถ้าเข้าเงื่อนไข.
- C3. ส่งได้ **ครั้งเดียว** ต่อ run (flag `outageAlerted`).
- C4. log เวลาเปิด browser: `[perf] browser launch=<ms>ms` (ใช้วินิจฉัยวันที่เครื่องช้า).
- ไม่เปลี่ยนข้อความ DM เดิม.

**Acceptance:**
- จำลอง launch ช้า (inject delay ใน test harness) ให้เลย T-4m → ยังได้ DM outage หลัง round แรก, ได้ครั้งเดียว.
- run ปกติ → ไม่มี DM outage, มีบรรทัด `browser launch=` หนึ่งบรรทัด.

---

### D. JSON report + log ผลรายบัญชีในโหมด bot — *ในกรอบ spec §7 (ตอนนี้ไม่ตรง spec)*

**ปัญหา:** `runner.ts` (โหมด CLI) เขียน `reports/run-*.json`, แต่โหมด bot (`bot.ts` → `bookingEngine`)
ไม่เขียนเลย (ไฟล์ล่าสุด 14 ก.ค.). ผลรายบัญชีมีแค่ใน DM. screenshot ชื่อ `<username>.png` ถูกทับทุกวัน.

**Spec:**
- D1. หลัง `runPrewarmedBatch` / `runStandard` คืนผล, `runScheduledBooking` (`src/server/bot.ts`) เขียน
  `reports/bot-run-<ISO stamp>.json`:
  ```jsonc
  {
    "fire_time": "...", "fired_at": "...", "drift_ms": 0,
    "mode": "prewarm" | "standard",
    "prewarm": { "page_ready": 0, "login_ready": 0, "needs_standard": 0, "failed": 0, "retry_rounds": 0 },
    "total_ms": 0,
    "counts": { "PASS": 0, "FAIL": 0, "ERROR": 0 },
    "accounts": [ /* BookingResult ต่อบัญชี: ครบ 9 field ของ §7 + attempts */ ]
  }
  ```
  field §7 ต่อบัญชี: `username, triggered_at, court_attempted, court_booked, slot, status, fail_reason, screenshot, duration_ms`.
- D2. เขียน report **ทุกกรณี** รวม dispatch SKIPPED (drift guard) และกรณี batch throw (เขียนเท่าที่มี).
  ถ้าเขียนไฟล์ไม่ได้ → `console.warn` แต่ห้าม throw (ห้ามกระทบการส่ง DM).
- D3. log หนึ่งบรรทัดต่อบัญชีตอน settle (ใน `onAccountSettled`):
  `[result] <username> <status> court=<court_booked|-> slot=<slot> <duration>ms reason=<fail_reason|->`.
- D4. screenshot: เก็บเป็น `screenshots/<YYYY-MM-DD>/<username>.png` (วันตามเวลา Bangkok) เพื่อไม่ถูกทับ.
  → **ต้องตัดสินใจ (Q-D1)** เรื่อง retention.
- D5. `engine` ต้องคืนค่า `fired_at`, `drift_ms`, tallies prewarm ให้ bot.ts ใช้ (ขยาย `EngineResult`).
- `reports/` และ `screenshots/` อยู่ใน `.gitignore` แล้ว — ห้ามเอาออก.

**Acceptance:**
- `npm run rehearse` (dry-run) → มีไฟล์ `reports/bot-run-*.json` ที่ parse ได้, มี 9 field ครบทุกบัญชี,
  มี `[result]` ครบทุกบัญชีใน log, screenshot อยู่ในโฟลเดอร์วันที่.
- จำลอง drift > 30s → ยังได้ report ที่ทุกบัญชี `FAIL missed-deadline`.

---

### A. เพดานเวลาใน Phase 3 + timeout ของ in-page fetch — *นอก spec (behavior ใหม่) — ต้อง approve*

**ปัญหา:** Phase 3 (`bookingEngine.ts:649`) `await Promise.all(...)` ไม่มีเพดาน. ถ้า Chrome ค้าง
(11/15 ก.ย. ไม่มี `[perf]` สักบรรทัดขณะที่ Node→Telegram ปกติ) ผลจะรอจน Chrome หลุดเอง.
ส่วนที่ไม่มี timeout:
- `fetch()` ใน `page.evaluate` — submit (`bookingFlow.ts` `setSelectionAndSubmitViaFetch`),
  `fetchAllReservedTimes`, `verifyBookedOnReservations`
- `browser.newContext()` ใน standard path ของ `bookOneAccount`

**Spec:**
- A1. In-page fetch ทุกตัวใช้ `AbortController` + timeout:
  - submit POST: `SUBMIT_RESULT_TIMEOUT_MS` (15s, ค่าเดิมของ click path)
  - `get_reserved_times.php`: 8s ต่อ court (เท่า `getBadmintonCourts`)
  - `reservations.php` check: 8s
  - abort ของ submit → คืน `{ ok:false, error:'submit timeout' }` แล้ว **ยังต้องผ่าน**
    `confirmViaReservationsIfUnclear` (POST อาจสำเร็จที่ server แล้ว — กันจองซ้ำสนามอื่น).
- A2. `browser.newContext()` race กับ timeout 20s → throw → เข้า catch เดิม (status ERROR).
- A3. เพดานรวมต่อบัญชีใน Phase 3 (และ `runStandard`): `ACCOUNT_SETTLE_BUDGET_MS` (ค่าเสนอ **90s**, → **Q-A1**)
  - race `bookOneAccount(...)` กับ timer; ถ้า timer ชนะ → สร้างผล
    `status: 'ERROR'`, `fail_reason: 'timeout: ไม่จบภายใน 90s — ผลจริงไม่ทราบ ให้เช็ค reservations.php'`
    แล้วเรียก `onAccountSettled` ทันที (DM ไม่ต้องรอ).
  - งานจริงวิ่งต่อแบบ detached; เมื่อจบให้ log `[result-late] <username> <status> ...` (ไม่ส่ง DM ซ้ำ,
    แต่ D ต้องบันทึก late result ลง report ถ้า report ยังไม่ถูกเขียน — ถ้าเขียนแล้วให้เขียนไฟล์ `.late.json` แยก).
  - context ยังถูกปิดโดย `finally` ของ `bookOneAccount` เหมือนเดิม (BR-04).
  - ใช้ `ERROR` ไม่ใช่ `FAIL` เพราะไม่รู้ว่าจองได้หรือไม่.
- A4. ห้ามกระทบ path ปกติ: timer ตั้งหลังเริ่ม dispatch (ไม่มี await เพิ่มก่อน submit), ต้อง `clearTimeout` เมื่องานจบ.

**Acceptance:**
- mock server ที่ค้าง POST ไม่ตอบ → submit abort ที่ 15s, มีการเช็ค reservations, ไม่ยิงสนามถัดไปถ้า reservations เจอแถวของเรา.
- mock ที่ค้างทุก request → ทุกบัญชีได้ `ERROR timeout` ภายใน 90s ± 1s, DM ออกทันที, ต่อมามี `[result-late]`.
- run ปกติ (rehearse) → ผลเหมือนเดิม, ไม่มีบรรทัด timeout.

---

### B. ยกเลิก prewarm รอบที่ถูก CUT + browser ใหม่เมื่อ prewarm ล้มหมด — *นอก spec — ต้อง approve*

**ปัญหา:** `prewarmRound` (`bookingEngine.ts:311–345`) พอเลย deadline แค่ `sealed = true` แล้วทิ้งผล —
`prewarmOne` ที่ยังวิ่งอยู่ไม่ถูกหยุด. 15 ก.ย. มี 3 รอบ → prewarm context ค้าง 51 ตัว + standard 17 ตัว
ใน Chrome ตัวเดียว, ปิดเสร็จหลัง 18 นาที. Phase 3 ใช้ browser ตัวเดียวกันที่ค้างอยู่.

**Spec:**
- B1. `prewarmOne` รับ registry (เช่น `onContext(ctx)`) เพื่อลงทะเบียน context ทันทีหลัง `newContext()`.
  ตอน round ถูก seal → context ของบัญชีที่ยังไม่ settle ถูก `closeWithTiming` แบบ detached ทันที
  (await ที่ค้างอยู่ใน `prewarmOne` จะ throw → เข้า catch เดิม → ผลถูก drop เหมือนเดิม).
- B2. retry round ใหม่เริ่มได้เฉพาะเมื่อ context ของรอบก่อนถูกสั่งปิดครบแล้ว (ไม่ต้องรอให้ปิดเสร็จ).
- B3. หลัง retry loop จบ (T-40s): ถ้า **ไม่มีบัญชีไหนมี page ที่ใช้ได้** (ทุก entry = failed)
  → launch browser ใหม่ (race timeout 20s) ให้ Phase 3 ใช้แทน, browser เก่าปิดแบบ detached.
  ถ้า launch ใหม่ไม่สำเร็จ → ใช้ตัวเก่าต่อ + log `[WARN]`. (→ **Q-B1**)
  - ต้องทำ **ก่อน** `waitUntilLocalTimestamp` เพื่อไม่กิน drift.
  - `cleanupBatch` ต้องปิดทั้ง 2 browser.
- B4. log: `[bookingEngine] prewarm round CUT — cancelled N in-flight context(s)` และ
  `[bookingEngine] fresh browser for standard path (launch=<ms>ms)`.

**Acceptance:**
- mock ที่ค้าง `login.php` → หลัง run จำนวน `prewarm ctx ... close` ต่อบัญชี = จำนวนรอบ และทุก close สั่งภายใน 1s หลัง CUT
  (ไม่ใช่ 5–50 นาทีทีหลังแบบ 15 ก.ย.).
- กรณี all-failed → มีบรรทัด fresh browser, Phase 3 ใช้ browser ใหม่ (เช็คจาก log).
- run ปกติ → ไม่มีบรรทัดทั้งสอง.

---

### E. เตือนเมื่อพลาดรอบเที่ยง (เครื่องหลับ) — *นอก spec — ต้อง approve*

**ปัญหา:** 6 วันไม่มีการยิง เพราะ Mac หลับตอน 11:55 (`pmset` ยืนยัน 27 ก.ย.: ปิดฝา + ใช้แบต 11:12–12:23).
`node-cron` ไม่ยิงย้อนหลังเมื่อเครื่องตื่น และไม่มีอะไรแจ้ง.

**Spec:**
- E1. บันทึกสถานะ run ลง `config/run-state.json` (gitignored — ต้องเพิ่มใน `.gitignore`):
  `{ "last_cron_fired_date": "YYYY-MM-DD", "last_dispatch_date": "YYYY-MM-DD" }` (วันตาม Bangkok).
  - เขียน `last_cron_fired_date` ตอน cron 11:55 ยิง, `last_dispatch_date` ตอนถึง FIRE หรือ SKIPPED.
- E2. watchdog `setInterval` ทุก 60s (และเช็คทันทีตอน bot start):
  ถ้าเวลาปัจจุบัน ≥ 12:05 ของวันนี้ และวันนี้**ควร**มี run (มี user ที่ cron=on และมีบัญชี)
  และ `last_dispatch_date != วันนี้` และยังไม่เคยเตือนของวันนี้ → DM owner:
  `⚠️ พลาดรอบ 12:00 วันนี้ — bot ไม่ได้ยิง (เครื่องหลับ/ปิดอยู่ช่วง 11:55–12:00?) ตื่นมาเวลา HH:MM`
  พร้อม log `[watchdog] missed noon run`.
  - เก็บ `missed_alert_date` ใน state เพื่อเตือนวันละครั้ง.
  - ห้ามยิงจองย้อนหลัง (เลย 12:00 แล้วไม่มีประโยชน์ + ผิด SC-04).
- E3. กรณีแบบ 5 ก.ย. (cron ยิงแต่ dispatch ถูก SKIPPED) นับเป็น "dispatch แล้ว" → watchdog ไม่เตือน
  เพราะผู้ใช้ได้ DM ผล `missed-deadline` และมี report จากงาน D อยู่แล้ว.
- E4. **ไม่ทำในโค้ด:** การกันเครื่องหลับ (เสียบไฟ / ไม่ปิดฝา / `pmset`) เป็นงานของ user
  — `caffeinate -disu` กันการหลับเพราะปิดฝาไม่ได้.

**Acceptance:**
- ตั้ง state ให้ `last_dispatch_date` = เมื่อวาน, เวลา ≥ 12:05 → start bot → ได้ DM หนึ่งครั้ง; restart อีกครั้งไม่ได้ DM ซ้ำ.
- วันที่ run ปกติ → ไม่มี DM.
- วันที่ไม่มี user cron=on → ไม่มี DM.

---

### F. ข้อเล็ก — *นอก spec — ต้อง approve*

- F1. `main()` (`bot.ts:1515–1521`): `getMe` fail ไม่ต้อง `process.exit(1)` → retry backoff (5s, 10s, 30s, … สูงสุด 60s)
  แล้วค่อยตั้ง cron + poll. **cron ต้องถูกตั้งแม้ getMe ยังไม่ผ่าน** (การจองไม่ได้พึ่ง Telegram).
  ปัจจุบัน launchd KeepAlive restart วน (1 และ 16 ก.ย.) — ถ้าเน็ต/DNS ล่มตอน 11:55 cron จะไม่ถูกตั้งเลย.
- F2. `bot.log`: เลิก truncate ตอน start → append + rotate เมื่อเกิน 5MB (เก็บ 1 ไฟล์ `.1`).
  (หมายเหตุ: `bot.stdout.log` 4.9MB เป็นของ launchd ไม่ถูก rotate — อยู่นอก scope นี้.)

**Acceptance:**
- ปิด DNS (หรือชี้ `api.telegram.org` ไปที่ใช้ไม่ได้) → bot ไม่ exit, มี `✓ Noon cron scheduled`, getMe retry จนผ่าน.
- restart 2 ครั้ง → `bot.log` ยังมีบรรทัดของรอบก่อน.

---

## 3. คำถามที่ต้องตอบก่อน implement

| ID | คำถาม | ค่าเสนอ |
|---|---|---|
| Q-A1 | เพดานเวลาต่อบัญชีใน Phase 3 | 90s (run ปกติจบ ≤ 8s; เผื่อ standard path ที่ต้อง login เต็มรอบตอน server ช้า) |
| Q-A2 | บัญชีที่เกินเพดานให้ status อะไร | `ERROR` (ไม่รู้ผลจริง) |
| Q-B1 | prewarm ล้มหมดแล้วเปิด browser ใหม่ให้ Phase 3 — เอาไหม | เอา |
| Q-D1 | เก็บ screenshot/report กี่วัน | 30 วัน แล้วลบอัตโนมัติ (หรือไม่ลบเลย) |
| Q-E1 | watchdog เตือนตอนกี่โมง | 12:05 เป็นต้นไป (ตอนเครื่องตื่นครั้งแรก) |
| Q-F  | ทำ F ด้วยไหม | ทำ F1, F2 ทำหรือไม่ก็ได้ |
| Q-R  | อัปเดต `requirements.md` §10 (Operational Notes) ให้บันทึกข้อ A/B/E/F ที่ approve แล้ว | อัปเดต |
| Q-M2 | ใช้กับเครื่องที่ 2 (machine-2, 19 บัญชี) ด้วย — merge แล้วแจ้งผ่าน handoff doc | ใช่ |

---

## 4. Tasks

> ติ๊ก `[x]` เมื่อเสร็จ + verify แล้ว. ทุก task: `npx tsc --noEmit` ผ่าน.

### C — outage alert
- [x] C-1 ย้าย `pendingEntries` + ตั้ง `outageTimer` ไปก่อน `chromium.launch()` (`bookingEngine.ts`)
- [x] C-2 เพิ่ม fallback check หลัง round แรก เมื่อ `alertAt` ผ่านไปแล้ว + flag ส่งครั้งเดียว
- [x] C-3 log `[perf] browser launch=<ms>ms`
- [x] C-4 test: harness จำลอง launch ช้า + all-failed → DM 1 ครั้ง (ใช้ `suppressAlerts`/mock `sendTelegramMessage`)
- [x] C-5 commit `fix(engine): arm outage alert before browser launch`

### D — report
- [x] D-1 ขยาย `EngineResult` (`fired_at`, `drift_ms`, prewarm tallies, retry rounds)
- [x] D-2 เขียน `reports/bot-run-*.json` ใน `runScheduledBooking` ทุก exit path (try/catch, ไม่ throw)
- [x] D-3 log `[result]` ต่อบัญชีใน `onAccountSettled`
- [x] D-4 screenshot ลงโฟลเดอร์วันที่ (`baseFlowOptions` → `screenshotsDir/<date>`) + retention ตาม Q-D1
- [ ] D-5 verify ด้วย `npm run rehearse` (นอกช่วง 11:50–12:05) + กรณี drift skip
- [x] D-6 commit `feat(bot): write §7 JSON report and per-account result log`

### A — Phase 3 bounds
- [x] A-1 `AbortController` ใน `setSelectionAndSubmitViaFetch`, `fetchAllReservedTimes`, `verifyBookedOnReservations`
- [x] A-2 submit abort → ผ่าน `confirmViaReservationsIfUnclear` ก่อนตัดสิน
- [x] A-3 `newContext` race 20s ใน `bookOneAccount` standard path
- [x] A-4 `withSettleBudget()` ครอบ `bookOneAccount` ใน Phase 3 + `runStandard`; late result → `[result-late]` + `.late.json`
- [x] A-5 test: mock server ค้าง POST / ค้างทุก request (ตาม acceptance ของ A)
- [ ] A-6 test: `npm run test:fast-confirm` + rehearse ผลเหมือนเดิม
- [x] A-7 commit `fix(engine): bound phase-3 per-account time and in-page fetches`

### B — cancel cut rounds / fresh browser
- [x] B-1 registry context ใน `prewarmOne` + ปิด in-flight ตอน seal ใน `prewarmRound`
- [x] B-2 fresh browser ก่อน tick เมื่อ all-failed (race launch 20s, fallback ตัวเก่า)
- [x] B-3 `cleanupBatch` ปิดทั้ง 2 browser
- [x] B-4 test: mock ค้าง login.php → นับบรรทัด close ต่อรอบ, เวลา close หลัง CUT
- [x] B-5 commit `fix(engine): cancel in-flight prewarm on round cut, fresh browser after total outage`

### E — missed-run watchdog
- [x] E-1 `config/run-state.json` read/write (atomic tmp+rename เหมือน `courtIdCache`) + เพิ่มใน `.gitignore`
- [x] E-2 บันทึก state ตอน cron fire / FIRE / SKIPPED
- [x] E-3 watchdog 60s + check ตอน start, เตือนวันละครั้ง
- [x] E-4 test ตาม acceptance ของ E
- [x] E-5 commit `feat(bot): alert owner when the noon run was missed`

### F — startup + log
- [ ] F-1 getMe retry backoff, ตั้ง cron ก่อน/ไม่ขึ้นกับ getMe
- [ ] F-2 (ถ้า approve) `bot.log` append + rotate 5MB
- [ ] F-3 commit `fix(bot): don't exit on startup Telegram failure`

### ปิดงาน
- [ ] อัปเดต `requirements.md` §10 ตาม Q-R
- [ ] restart bot นอกช่วง 11:50–12:05, ตรวจ noon run วันถัดไป:
      `browser launch=`, `[result]` ครบ, `reports/bot-run-*.json`, ไม่มี timeout บน run ปกติ
- [ ] แจ้ง machine-2 ให้ pull (อัปเดต `doc/machine-2-handoff.md`)

---

## 5. ติดตามจากงานเมื่อวาน (ไม่ใช่งานใหม่)

- fix court-id collision (`e392ebd`) ยังไม่เคยวิ่งตอนเที่ยงจริง — noon run ถัดไปให้ grep
  `[courtIdCache] ... evicting` และ `but reservations.php shows`.
- `config/court-ids.json` ไม่มี แบดมินตัน5 แล้ว → บัญชีที่ rotation ไปเจอ court5 จะ inject id ไม่ได้
  จนกว่า dropdown จะแสดง court5. ห้ามเดา id.
