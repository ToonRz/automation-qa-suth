# Handoff สำหรับ agent บนเครื่องที่ 2 (machine-2) — 2026-09-27 (อัปเดต 2026-09-28)

> อ่านทั้งไฟล์ก่อนลงมือ. กฎของ repo (CLAUDE.md): **ทุกการแก้ต้องอิง `requirements.md` —
> อะไรที่นอกเหนือ spec (tooling ใหม่, dependency ใหม่, behavior ใหม่) ให้ถาม user ก่อน.**
> ห้ามพิมพ์ token/password เต็มลงแชท, log, commit หรือไฟล์ใดๆ ใน repo (repo เป็น PUBLIC).

## อัปเดต 2026-09-28 — ต้อง pull ชุด fix จาก log audit

ชุดนี้ **merge เข้า `main` และ push แล้ว** (`origin/main` = `06c2397`; spec:
`doc/fix-plan-2026-09-28-log-audit.md`, บันทึกใน `requirements.md` §10.5–10.9). เครื่องที่ 1 restart
บอทบนโค้ดนี้แล้วเมื่อ 28/09 14:10. เครื่องนี้ให้ทำตาม "ขั้นที่ 0" ด้านล่าง
(`git pull --ff-only origin main` → `npx tsc --noEmit`; ไม่มี dependency ใหม่) แล้วเช็ค `config/`
ตามหัวข้อถัดไป **ก่อน** restart.

Commit ในชุด:
- `fix(engine): arm outage alert before browser launch` (C)
- `feat(bot): write §7 JSON report and per-account result log` (D)
- `fix(engine): bound phase-3 per-account time and in-page fetches` (A)
- `fix(engine): cancel in-flight prewarm on round cut, fresh browser after total outage` (B)
- `feat(bot): alert owner when the noon run was missed` (E)
- `fix(bot): don't exit on startup Telegram failure` (F)
- `docs: record log-audit fixes in requirements §10 and handoffs` (ปิดงาน)

หลัง pull:
- restart บอท **นอกช่วง 11:50–12:15** (แจ้ง user ก่อน). ถ้า restart หลัง 12:05 ครั้งแรก จะเห็น
  `[watchdog] run-state created …` — ปกติ ไม่ใช่ error.
- ไฟล์ใหม่ที่บอทสร้างเอง (gitignored ทั้งหมด): `config/run-state.json`, `reports/bot-run-*.json`,
  `screenshots/<YYYY-MM-DD>/`, `bot.log.1`. `bot.log` ไม่ถูกล้างตอน start แล้ว.
- ตรวจรอบเที่ยงถัดไปใน log: `[perf] browser launch=` 1 บรรทัด, `[result]` ครบทุกบัญชี (19),
  `[report] wrote … (19 account(s))`, และต้อง**ไม่มี** `did not settle`, `submit timeout`, `result-late`,
  `round CUT`, `fresh browser` ในรอบปกติ.
- ทดสอบได้ด้วย `npm run test:log-audit` (~15 นาที; mock server + Chrome จริง ไม่แตะเว็บจริง/Telegram).

## `config/` ของเครื่องนี้ — ใช้ account เดิม ห้ามเปลี่ยน

**เครื่องนี้เคย pull และตั้ง account ไว้แล้ว** (19 บัญชี ของบอทเครื่องนี้). ให้ใช้ของเดิมทั้งหมด:
- **ห้ามเปลี่ยน / ลบ / แทนที่** user, chat id, username, password, slot ที่มีอยู่ และ**ห้าม copy**
  `users.json` / `accounts.json` / `run-state.json` จากเครื่องที่ 1 มาทับ (ข้อมูลคนละชุด).
- สิ่งที่ต้องทำคือให้ **format ของไฟล์ใน `config/` เหมือนเครื่องที่ 1** — โครงสร้าง/ชื่อ key เท่านั้น,
  ค่าเดิมของเครื่องนี้คงไว้ทุกตัว.

format ของเครื่องที่ 1 (ณ `06c2397`):

| ไฟล์ | git | format | หมายเหตุ |
|---|---|---|---|
| `config/users.json` | ignored, `chmod 600` | `{ "users": [ { "telegram_id", "chat_id", "display_name", "role": "owner"\|"friend", "accounts": [ { "username", "password", "court", "slot" } ], "pending_booking"?, "cron_enabled"?, "last_result"? } ] }` | **บอทจองจากไฟล์นี้**. owner ได้คนเดียว. `court` เป็น field เก่า (ไม่ใช้แล้ว) แต่เครื่องที่ 1 ยังมี — คงไว้. 3 field ท้ายบอทเขียนเอง |
| `config/accounts.json` | ignored | `{ "COURT_PRIORITY": [ ... ], "accounts": [ { "username", "password", "slot" } ] }` | ต้องมี `COURT_PRIORITY` ที่ไม่ว่าง ไม่งั้นบอท start ไม่ขึ้น. `accounts` ใช้เฉพาะโหมด CLI (`npm start` / `npm run account`) |
| `config/court-ids.json` | **tracked** | `{ "แบดมินตันN": "<id>" }` | cache ที่บอทเขียนเองตอน prewarm/เที่ยง |
| `config/run-state.json` | ignored | `{ "last_cron_fired_date"?, "last_dispatch_date"?, "missed_alert_date"? }` | **ใหม่** — บอทสร้างเอง ห้ามสร้าง/copy เอง |
| `config/users.example.json` | tracked | ตัวอย่างของ `users.json` | |

`COURT_PRIORITY` ของเครื่องที่ 1 ตอนนี้คือ
`["แบดมินตัน3","แบดมินตัน2","แบดมินตัน1","แบดมินตัน4","แบดมินตัน5","แบดมินตัน6"]` — ถ้าของเครื่องนี้ต่างไป
**อย่าแก้เอง** (เป็นลำดับการจอง ไม่ใช่ format) ให้ถาม user.

เช็คโครงสร้าง (พิมพ์แค่ key/จำนวน — ห้ามพิมพ์ค่า):

```bash
ls -la config/
node -e 'const j=require("./config/users.json");j.users.forEach((u,i)=>console.log(i,u.role,Object.keys(u).join(","),"accounts="+u.accounts.length,[...new Set(u.accounts.flatMap(a=>Object.keys(a)))].join(",")))'
node -e 'const j=require("./config/accounts.json");console.log(Object.keys(j).join(","),"COURT_PRIORITY="+(j.COURT_PRIORITY||[]).length,"accounts="+(j.accounts||[]).length)'
```

- ตรงกับตารางแล้ว → ไม่ต้องแตะไฟล์.
- ต่างจากตาราง → สำรองก่อน (`cp config/users.json config/users.json.bak-$(date +%Y%m%d)` — `*.bak*`
  ถูก ignore), แก้**เฉพาะโครงสร้าง**โดยค่าเดิมครบทุกตัว, สรุปให้ user ดูว่าเปลี่ยน key อะไร
  (ไม่แสดงค่า) และ**ขออนุมัติก่อนบันทึก**. ห้ามแก้ช่วง 11:50–12:15 (บอท snapshot รายชื่อตอน 11:55).
- หลังแก้ `users.json`: `chmod 600 config/users.json` และจำนวนบัญชีต้องเท่าเดิม (19).
- `git status` หลัง pull ถ้าเห็น ` M config/court-ids.json` = cache ที่บอทเครื่องนี้เขียนเอง (ไฟล์นี้ถูก track)
  — แสดง `git diff config/court-ids.json` ให้ user ดูแล้วถามก่อนว่าจะเก็บของเครื่องนี้หรือเอาของ `main`
  (อย่า stash/checkout ทิ้งเอง).

## บริบท

- Repo: `ToonRz/automation-qa-suth` (**public**). เครื่องนี้รันบอท Telegram `David_Bot`
  (bot id `8567202370`) จอง 19 บัญชีตอน 12:00:00.
- เครื่องนี้เพิ่ง merge 5 commits จาก `origin/main` วันนี้ (27/09) รวม `763f8db`
  (bound prewarm rounds) และ `95a5c02` (reload users.json). ก่อนหน้านั้น (รวมรอบเที่ยง 26/09)
  **รันโค้ดเก่าที่ไม่มี fix เหล่านี้**.
- ตอน merge ใช้ `-X ours` แล้วต้องเอาเวอร์ชัน main ทั้งไฟล์สำหรับ `src/server/bookingEngine.ts`
  และ `src/server/bot.ts` — ข้อมูลเฉพาะเครื่องอยู่ใน `config/users.json` (gitignored).

---

## ขั้นที่ 0 — อัปเดตเป็น `main` ล่าสุดก่อนแก้อะไรทั้งนั้น

ทุกการ diagnose/แก้ในไฟล์นี้ต้องทำบนโค้ด `origin/main` ล่าสุด (ต้องมี `06c2397`).

```bash
git status --short                 # ต้องว่าง; ถ้ามีไฟล์ค้าง → หยุด แจ้ง user ก่อน (อย่า stash/ทิ้งเอง)
                                   # (` M config/court-ids.json` = cache ของบอท — ดูหัวข้อ config ด้านบน)
git switch main
git fetch origin
git log --oneline HEAD..origin/main    # สิ่งที่จะได้มาใหม่
git log --oneline origin/main..HEAD    # commit ของเครื่องนี้ที่ยังไม่ได้ push
```

จากนั้นเช็กว่า history ถูก rewrite หรือยัง (รายละเอียดดูปัญหา 3):

```bash
git log origin/main --oneline -- .env.bak-predeep.20260701-150459 | head
```

- **มีผลลัพธ์ (ยังไม่ rewrite):**
  ```bash
  git pull --ff-only origin main
  ```
  ถ้า `--ff-only` ไม่ผ่าน (เครื่องนี้มี commit ที่ยังไม่ push) → หยุด แสดง `git log origin/main..HEAD`
  ให้ user ดู แล้วขอความเห็นก่อน merge/rebase. **อย่าใช้ `-X ours`/`-X theirs` เอง.**
- **ว่าง (rewrite แล้ว):** ห้าม `git pull` — ทำตามปัญหา 3 ข้อ 1 (สำรอง branch → ขอ user ยืนยัน →
  `git reset --hard origin/main` → cherry-pick commit ของเครื่องนี้กลับ).

หลังอัปเดตแล้ว:

```bash
git log --oneline -1                                   # ควรเป็น origin/main ล่าสุด
git merge-base --is-ancestor 06c2397 HEAD && echo ok   # มีชุด fix log-audit (รวม 2016eca) แล้ว
npm install
npx tsc --noEmit                                       # ต้องผ่านก่อนไปต่อ
```

ถ้าบอทรันอยู่ ต้องรีสตาร์ทบอทให้ใช้โค้ดใหม่ — **ห้ามรีสตาร์ทช่วง 11:50–12:15** (จะกระทบรอบเที่ยง);
นอกช่วงนั้นให้แจ้ง user ก่อนรีสตาร์ท.

---

## ปัญหา 1 — รอบเที่ยง 26/09 พลาดทั้ง 19 บัญชี (`missed-deadline`)

**อาการ:** DM ผลลัพธ์มาตอน 12:10 ทุกบัญชี
`missed-deadline: dispatch started 602168ms past fire time` → `PASS 0 | FAIL 19 | ERROR 0`.

**ความหมาย:** drift guard (`DRIFT_SKIP_MS = 30_000` ใน `src/server/bookingEngine.ts`)
เห็นว่าถึงจุด dispatch ช้าไป ~10 นาที จึงข้ามการยิงทั้งหมด. guard ทำงานถูก — ปัญหาอยู่ที่ว่า
**อะไรกินเวลา 10 นาทีก่อนเที่ยง**.

**สมมติฐาน (ยังไม่ยืนยัน — ต้องดูหลักฐานในเครื่องนี้):**

1. **เน็ตขาออกของเครื่องนี้ตาย/สะดุดช่วง prewarm (11:55–12:00)** + โค้ดเก่าที่ Phase 1 ไม่มี
   deadline รวม. เคยเกิดบนเครื่องที่ 1 เมื่อ 31/08: goto ทุกบัญชี timeout 20s แล้วการปิด context
   ที่ตายไล่เป็นระลอกบน CDP pipe เดียว ทำให้ Phase 1 ยาว 10m11s. ตัวเลข 602s ตรงกับ pattern นี้มาก.
   `763f8db` แก้แล้ว (แต่ละรอบ race deadline 50% ของเวลาที่เหลือ, outage DM ตั้งตาม wall clock ที่ T-4m,
   close ของ context ที่ error เป็น detached).
2. **MacBook sleep** ช่วง 11:55–12:10 → timer หยุด, เน็ตหลุด, ตื่นมาเลยเวลา. repo **ไม่มี**
   `caffeinate`/`pmset` ใดๆ.
3. (เครื่องที่ 1 เคยเจอ) firewall ที่ user ทดสอบอยู่ใน LAN ทิ้ง HTTPS ขาออกแบบเงียบๆ —
   ถาม user ว่าเครื่องนี้อยู่ LAN เดียวกันหรือไม่.

**ขั้นตอน diagnose (ทำตามลำดับ, รายงานผลให้ user ก่อนแก้):**

```bash
# (a) เครื่อง sleep ช่วงนั้นไหม
pmset -g log | grep -E "2026-09-26 1[12]:" | grep -iE "sleep|wake|DarkWake"
```

```bash
# (b) log ของบอท (default: bot.log ที่ root repo หรือ $BOT_LOG_PATH) ช่วงรอบ 26/09
grep -nE "prewarm|dispatch SKIPPED|total outage|timeout|Timeout|cleanup" bot.log | grep "2026-09-26T0[45]" | head -80
```

การตีความ:
- มี Sleep/Wake ในช่วงนั้น → สาเหตุ 2.
- ไม่ sleep แต่เต็มไปด้วย goto/navigation timeout ของทุกบัญชีพร้อมกัน และ Telegram fetch error
  ในช่วงเดียวกัน → เน็ตขาออก (สาเหตุ 1/3) ไม่ใช่บั๊ก Playwright. **อย่าไปจูน timeout ในโค้ดก่อน.**
- `[bookingEngine] prewarm: …` บรรทัดสรุปมาตอนหลัง ~11:59 → Phase 1 กินหน้าต่างเวลา (โค้ดเก่า).
- log ของโค้ดใหม่ที่ควรเห็นในรอบถัดไป: `prewarm retry for N failed account(s)` (ถ้ามีบัญชีพัง) และ
  `total outage at T-240s` (ถ้าพังทั้งหมด). **ถ้ารอบถัดไปพังแล้วไม่มี `prewarm retry for` เลย = หน้าต่างเวลาถูกกินอีก.**

**การแก้ที่เสนอ (ถาม user ก่อนทุกข้อ — เป็น behavior/tooling ใหม่นอก spec):**
- ถ้าเป็น sleep: รันบอทใต้ `caffeinate -is` หรือให้ user ตั้ง Energy settings ไม่ให้ sleep ตอนเสียบไฟ.
  ห้ามแก้ system/security settings เอง — บอกให้ user ทำ.
- ถ้าเป็นเน็ต: แก้ที่เครือข่าย ไม่ใช่โค้ด. ก่อน 11:55 ทุกวันทดสอบได้ด้วย
  `curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" https://susport.sc.su.ac.th/login.php`
  (หมายเหตุ: probe ครั้งเดียวผ่าน ไม่รับประกันว่าหลาย connection พร้อมกันจะผ่าน).
- ยืนยันว่าเครื่องนี้มี `763f8db` จริง: `git merge-base --is-ancestor 763f8db HEAD && echo ok`.

---

## ปัญหา 2 — วันนี้ 11:36 `/start` แล้วได้ `⚠️ bot reply failed (bot)` reason ว่าง

**อาการ:** `FetchError: request to https://api.telegram.org/bot8567202370:[REDACTED]/sendMessage failed, reason:`
ตามด้วยแค่ timestamp `2026-09-27T04:39:32.376Z` (บรรทัดที่ `alertOwnerAboutReplyFail` ใน
`src/server/bot.ts` ต่อท้าย) — ไม่ใช่เหตุผล. alert มาถึง 11:39 = ~3 นาทีหลัง `/start`.

**ความหมาย:** บอท*รับ* update ได้ แต่ `sendMessage` เชื่อมต่อไม่ติด. reason ว่างมักเป็น
connect timeout แบบ `AggregateError` (IPv4/IPv6 ล้มหมด) ที่ message ว่าง. = หลักฐานอีกชิ้นว่า
**เน็ตขาออกของเครื่องนี้สะดุดเป็นช่วงๆ** (session ก่อนก็เจอ: test message รอบแรก fetch timeout
รอบสองผ่าน). ใช้ร่วมกับปัญหา 1 ในการ diagnose.

**เสนอ (ถาม user ก่อน):** ให้ `alertOwnerAboutReplyFail` แสดง `err.cause?.code` /
`err.errors?.map(e => e.code)` ด้วย จะได้เห็น `ETIMEDOUT`/`ENETUNREACH` แทน reason ว่าง.
เป็นการแก้เล็กในการรายงานเท่านั้น แต่ยังถือว่าเป็น change ที่ต้องขออนุญาตตามกฎ repo.

---

## ปัญหา 3 — token รั่วใน repo public (เกี่ยวกับ git ของเครื่องนี้)

- token ที่รั่วคือของ **เครื่องที่ 1** (bot id `8912911313`, @AutocourtSU_bot) — **ไม่ใช่** token
  ของเครื่องนี้ (`8567202370`). เครื่องนี้ไม่ต้อง revoke อะไร (เท่าที่รู้).
- ไฟล์ที่รั่ว: `.env.bak-predeep.20260701-150459` (token เต็ม) และ
  `bot.log.2026-06-30-pre-restart.bak` (prefix). ถูก untrack แล้วใน `2016eca` บน `origin/main`
  พร้อมกฎ `.gitignore` ใหม่: `.env.*`, `!.env.example`, `*.bak`.
- **ยังไม่ได้ rewrite history** — ไฟล์ยังอยู่ใน commit เก่า (ตั้งแต่ `59eb603`/`067d56f`).
  เครื่องที่ 1 **อาจ** รัน `git filter-branch` + `git push --force` กับ `main`, `Testnewlogic1`,
  `testnewlogic1`, `deploy/machine-2`, `feat/prioritize-21-22`, `feat/verify-21-22-fallback` ภายหลัง.

**สิ่งที่ agent บนเครื่องนี้ต้องทำ:**

1. `git fetch origin` แล้วเช็กว่า history ถูก rewrite แล้วหรือยัง:
   ```bash
   git log origin/main --oneline -- .env.bak-predeep.20260701-150459 | head
   ```
   - มีผลลัพธ์ = ยังไม่ rewrite → `git pull` ปกติได้ (จะได้ `2016eca`).
   - ว่าง = rewrite แล้ว → **ห้าม `git pull`/`git push` ตรงๆ** (จะเอา history เก่ากลับขึ้นไป).
     ให้เช็ก commit ที่ยังไม่ได้ push ก่อน (`git log origin/main..HEAD` เทียบด้วย subject/diff เพราะ SHA
     เปลี่ยน), เก็บไว้ด้วย branch สำรอง, แล้ว `git reset --hard origin/main` และ cherry-pick
     commit ของเครื่องนี้กลับมา. **ขอ user ยืนยันก่อน reset --hard.**
2. **อย่า push ขึ้น origin จนกว่าจะทำข้อ 1** (session ก่อนมีคำสั่ง "push ขึ้น origin" ค้างอยู่).
3. เช็กว่าเครื่องนี้ไม่มีไฟล์ลับถูก track:
   ```bash
   git ls-files | grep -E '\.env|\.bak|\.log$|users\.json|accounts\.json'
   ```
   ควรเห็นแค่ `.env.example`. ถ้ามีอย่างอื่น → `git rm --cached` + แจ้ง user ทันที (อย่า paste เนื้อหา).
4. ห้าม commit ไฟล์ backup ของ `.env` หรือ log อีก.

---

## ลำดับความสำคัญ

1. ขั้นที่ 0 — อัปเดตเป็น `main` ล่าสุด (`06c2397`, รวมการเช็ก rewrite ของปัญหา 3 ข้อ 1–2) ก่อนทำอย่างอื่น.
   แล้วเช็ค `config/` ตามหัวข้อ "ใช้ account เดิม ห้ามเปลี่ยน" ก่อน restart บอท.
2. ปัญหา 1 diagnose (a)/(b) → รายงาน user → ขออนุมัติการแก้.
3. ปัญหา 2 (เสนอเท่านั้น).
4. ก่อนรอบเที่ยงถัดไป: บอทรันอยู่บนโค้ดที่มี `06c2397`, เครื่องไม่ sleep, `curl` ไป susport ผ่าน.
