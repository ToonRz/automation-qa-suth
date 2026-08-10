# Setup — เครื่องใหม่ (machine 2)

Branch นี้ (`deploy/machine-2`) มี **logic เหมือน `main` ทุกบรรทัด** — ไม่มีการแก้ `src/` เลย
ที่ต่างคือเครื่องนี้ใช้ **Telegram bot ตัวใหม่** และ **accounts ชุดใหม่**

ของพวกนั้นเป็นไฟล์ที่ `.gitignore` ไว้อยู่แล้ว (`.env`, `config/users.json`,
`config/accounts.json`) — **ไม่มีวัน commit ขึ้น git** เอกสารนี้คือ checklist
สร้างไฟล์พวกนั้นบนเครื่องใหม่

---

## ⚠️ อ่านก่อน — 3 ข้อที่พังบ่อยที่สุด

| # | เรื่อง | ทำไมสำคัญ |
|---|--------|-----------|
| 1 | **ต้องใช้ bot token คนละตัวกับเครื่องเดิม** | telegraf ใช้ long-polling ถ้า 2 process poll token เดียวกัน จะ **แย่ง update กัน** — คำสั่งจะเข้าเครื่องไหนก็ไม่รู้ ต้องขอ token ใหม่จาก @BotFather |
| 2 | **`SCREENSHOTS_DIR` ต้องตั้ง — ไม่ใช่ optional** | `src/server/bookingEngine.ts` fallback เป็น `/app/screenshots` (path ของ Docker) ถ้าไม่ตั้ง บน macOS จะเขียนไม่ลง **screenshot หายเงียบ ๆ** |
| 3 | **owner คนแรกต้องใส่มือใน `users.json`** | `/user add` เป็นคำสั่ง owner-only (`bot.ts:448`) — ยังไม่มี owner ก็เรียกไม่ได้ ต้อง seed คนแรกลงไฟล์เอง |

---

## 0. Prerequisites

```bash
node -v    # ต้อง >= 22 (เครื่องเดิมรัน v22.14.0)
npm -v     # 10.x
```

ติดตั้ง Google Chrome — โปรเจกต์ใช้ system Chrome ผ่าน `channel: 'chrome'`
**ไม่ต้อง** รัน `npx playwright install chromium`

```bash
brew install --cask google-chrome
```

---

## 1. Clone + checkout branch

```bash
git clone https://github.com/ToonRz/automation-qa-suth.git
cd automation-qa-suth
git checkout deploy/machine-2
npm install
```

---

## 2. ขอ Telegram bot token ตัวใหม่

1. เปิด Telegram → คุยกับ **@BotFather**
2. `/newbot` → ตั้งชื่อ + username (ต้องลงท้ายด้วย `bot`)
3. copy token ที่ได้ (รูปแบบ `1234567890:AA...`)

> อย่าเอา token ของเครื่องเดิมมาใช้ซ้ำ — ดูตาราง ⚠️ ข้อ 1

---

## 3. สร้าง `.env`

```bash
cp .env.example .env
```

แก้ 2 ค่านี้ให้ตรงเครื่อง:

```bash
TELEGRAM_BOT_TOKEN=<token ที่ได้จากขั้นที่ 2>
SCREENSHOTS_DIR=<absolute path ของ repo>/screenshots
```

หา absolute path ของ repo:

```bash
echo "$PWD/screenshots"
```

ค่าที่เหลือ (`TZ=Asia/Bangkok`, `DEEP_PREWARM=1`, `PREWARM_LEAD_SEC=300`) ปล่อยตาม
default ใน `.env.example` — เหมือนเครื่องเดิม

---

## 4. หา `chat_id` ของตัวเอง

ต้องรู้ `chat_id` ก่อนถึงจะ seed owner ได้ วิธีหา:

```bash
cp config/users.example.json config/users.json
npm run bot          # ปล่อยรันไว้ใน terminal นี้
```

ใน Telegram → ทักบอทตัวใหม่ → ส่ง `/start`
บอทจะตอบว่า **"คุณยังไม่ได้ลงทะเบียน — chat_id ของคุณคือ `<ตัวเลข>`"**
(เพราะ chat_id จริงไม่ตรงกับ placeholder ใน `users.example.json`)

จด `chat_id` ไว้ แล้ว `Ctrl-C` ปิดบอท

---

## 5. สร้าง `config/users.json` — Telegram bot path

แก้ `config/users.json` ที่ copy มาในขั้นที่ 4 ใส่ค่าจริง:

```json
{
  "users": [
    {
      "telegram_id": <chat_id จากขั้นที่ 4>,
      "chat_id": <chat_id จากขั้นที่ 4>,
      "display_name": "ชื่อคุณ (Owner)",
      "role": "owner",
      "accounts": [
        { "username": "<รหัสนักศึกษา>", "password": "<password>", "slot": "18:30_19:30" }
      ]
    }
  ]
}
```

กฎที่ code บังคับไว้:

- **owner ได้แค่คนเดียว** — `addUser()` จะ throw ถ้ามี owner อยู่แล้ว (`userStore.ts:204`)
- `telegram_id` กับ `chat_id` สำหรับแชทส่วนตัวเป็นเลขเดียวกัน
- `slot` รูปแบบ `HH:MM_HH:MM` เท่านั้น (เช่น `18:30_19:30`)
- `role` เป็น `"owner"` หรือ `"friend"`

ล็อค permission (ไฟล์นี้มี password):

```bash
chmod 600 config/users.json
```

เพื่อนคนอื่นเพิ่มทีหลังผ่านบอทได้เลย — owner พิมพ์ `/user add` แล้วเดิน wizard
ไม่ต้องแก้ไฟล์มือ

---

## 6. สร้าง `config/accounts.json` — CLI path

ไฟล์นี้ใช้กับ `npm start` / `npm run now` / `npm run dry-run` (ไม่ผ่าน Telegram)
แยกจาก `users.json` คนละไฟล์

```bash
cp config/accounts.example.json config/accounts.json
chmod 600 config/accounts.json
```

แก้ใส่ credentials จริง `COURT_PRIORITY` ใน example ตั้งไว้เหมือน `main` แล้ว
(`แบดมินตัน3` → `แบดมินตัน2` → `แบดมินตัน1`) ไม่ต้องแก้ถ้าอยากได้ลำดับเดิม

---

## 7. ทดสอบก่อนต่อ launchd

```bash
# dry-run — ไม่กินสิทธิ์จองจริง
npm run dry-run
```

ดูว่า login ผ่าน + เห็น slot ถ้าผ่านแล้วค่อยลอง bot:

```bash
npm run bot
```

ใน Telegram ส่ง `/help` → ต้องเห็นเมนูคำสั่ง (ไม่ใช่ "คุณยังไม่ได้ลงทะเบียน")
ถ้ายังขึ้นว่าไม่ลงทะเบียน แปลว่า `chat_id` ใน `users.json` ยังไม่ตรง

---

## 8. ติดตั้ง launchd supervisor

ให้บอทรันตลอด + respawn เองเวลา crash:

```bash
sed "s|__PROJECT_DIR__|$PWD|g" deploy/com.toon.court-booking-bot.plist.template \
  > ~/Library/LaunchAgents/com.toon.court-booking-bot.plist

plutil -lint ~/Library/LaunchAgents/com.toon.court-booking-bot.plist

launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.toon.court-booking-bot.plist
```

เช็คว่ารันอยู่:

```bash
launchctl print gui/$UID/com.toon.court-booking-bot | head -20
```

**restart หลังแก้ code** (อย่าใช้ `pkill` — KeepAlive จะ respawn แล้วกลบ error จริง):

```bash
launchctl kickstart -k gui/$UID/com.toon.court-booking-bot
```

ดู log:

```bash
tail -f bot.stdout.log
```

---

## 9. Checklist ปิดงาน

- [ ] `node -v` >= 22, Chrome ติดตั้งแล้ว
- [ ] `git branch --show-current` = `deploy/machine-2`
- [ ] `.env` มี `TELEGRAM_BOT_TOKEN` (ตัวใหม่) + `SCREENSHOTS_DIR` (absolute path จริง)
- [ ] `config/users.json` มี owner 1 คน chat_id ถูก, `chmod 600`
- [ ] `config/accounts.json` ใส่ credentials จริงแล้ว, `chmod 600`
- [ ] `npm run dry-run` ผ่าน
- [ ] `/help` ใน Telegram ตอบเมนู
- [ ] launchd bootstrap แล้ว, `kickstart -k` restart ได้
- [ ] `git status` **clean** — ไม่มี `.env` / `users.json` / `accounts.json` โผล่มา

ข้อสุดท้ายสำคัญที่สุด ถ้าไฟล์พวกนี้โผล่ใน `git status` แปลว่า `.gitignore` เพี้ยน
**หยุดทันที** อย่า commit

---

## ภาคผนวก — ไฟล์ไหนอยู่ที่ไหน

| ไฟล์ | อยู่ใน git? | machine-specific? |
|------|------------|-------------------|
| `src/**` | ✅ tracked | ❌ portable ล้วน (ไม่มี hardcode path/token/chat_id) |
| `.env` | ❌ gitignored | ✅ token + path ของเครื่อง |
| `config/users.json` | ❌ gitignored | ✅ chat_id + credentials |
| `config/accounts.json` | ❌ gitignored | ✅ credentials |
| `~/Library/LaunchAgents/*.plist` | ❌ อยู่นอก repo | ✅ absolute path ของเครื่อง |
| `reports/`, `screenshots/`, `*.log` | ❌ gitignored | ✅ generated |
