#!/usr/bin/env bash
#
# setup-new-machine.sh — replicate this bot's runtime setup on another Mac.
#
# Usage (on the NEW machine):
#   chmod +x setup-new-machine.sh
#   ./setup-new-machine.sh            # setup only, does not start the bot
#   ./setup-new-machine.sh --start    # setup + bootstrap the launchd agent
#
# What it does NOT do: copy secrets. .env, config/accounts.json and
# config/users.json are gitignored and must be transferred by hand
# (AirDrop / USB / scp). The script stops and tells you if they are missing.

# macOS defaults to zsh, so `zsh setup-new-machine.sh` is an easy mistake — and
# this script uses bash arrays and [[ ]]. Re-exec under bash rather than fail oddly.
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"

set -euo pipefail

REPO_URL="https://github.com/ToonRz/automation-qa-suth.git"
REPO_DIR="${REPO_DIR:-$HOME/Documents/GitHub/automation-qa-suth}"
LABEL="com.toon.court-booking-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Must match the PATH the launchd agent runs with — node has to be resolvable
# from this list, not just from an interactive shell (nvm shims are not).
LAUNCHD_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

STAMP="$(date +%Y%m%d-%H%M%S)"
START_BOT=0
[[ "${1:-}" == "--start" ]] && START_BOT=1

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

step "1/7 ตรวจเครื่อง"

[[ "$(uname -s)" == "Darwin" ]] || die "script นี้ใช้กับ macOS เท่านั้น (launchd)"
ok "macOS $(sw_vers -productVersion) ($(uname -m))"

command -v git >/dev/null || die "ไม่มี git — ติดตั้ง Xcode Command Line Tools: xcode-select --install"

# The exact test that matters: can launchd's PATH find node?
if ! NODE_BIN="$(PATH="$LAUNCHD_PATH" command -v node 2>/dev/null)"; then
  die "หา node ไม่เจอใน PATH ของ launchd ($LAUNCHD_PATH)
     node จาก nvm ใช้ไม่ได้ เพราะ launchd มองไม่เห็น
     แก้: ลง Node LTS จาก https://nodejs.org (pkg installer ลงที่ /usr/local/bin)
          หรือ  brew install node  (Apple Silicon ลงที่ /opt/homebrew/bin)"
fi
NODE_VER="$("$NODE_BIN" -v)"
NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" -ge 18 ]] 2>/dev/null \
  || die "ต้องใช้ Node 18+ (เจอ $NODE_VER ที่ $NODE_BIN)"
ok "node $NODE_VER ที่ $NODE_BIN"

[[ -d "/Applications/Google Chrome.app" ]] \
  || die "ไม่มี Google Chrome — โค้ดใช้ channel:'chrome' ทุกจุด
     แก้: brew install --cask google-chrome"
ok "Google Chrome"

TZ_NOW="$(date '+%Z %z')"
if [[ "$TZ_NOW" == *"+0700"* ]]; then
  ok "timezone $TZ_NOW"
else
  warn "timezone = $TZ_NOW (ไม่ใช่ +0700) — trigger เที่ยงจะเพี้ยน ตั้ง Asia/Bangkok ก่อนใช้จริง"
fi

# --------------------------------------------------------------------- repo

step "2/7 ดึง repo → $REPO_DIR"

if [[ -d "$REPO_DIR/.git" ]]; then
  git -C "$REPO_DIR" pull --ff-only
  ok "pull เรียบร้อย"
else
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone "$REPO_URL" "$REPO_DIR"
  ok "clone เรียบร้อย"
fi

cd "$REPO_DIR"

step "3/7 npm install"
npm install --no-audit --no-fund
ok "dependencies ครบ ($(node -e 'console.log(Object.keys(require("./package.json").dependencies).length)') runtime deps)"

# ------------------------------------------------------------------ secrets

step "4/7 ตรวจไฟล์ลับ (ต้องก๊อปมาเอง)"

MISSING=()
for f in .env config/accounts.json config/users.json; do
  if [[ -f "$f" ]]; then ok "$f"; else MISSING+=("$f"); fi
done

if (( ${#MISSING[@]} > 0 )); then
  printf '\n'
  for f in "${MISSING[@]}"; do printf '  \033[31m✗ ขาด %s\033[0m\n' "$f"; done
  die "ก๊อป ${#MISSING[@]} ไฟล์นี้จากเครื่องเดิมมาไว้ที่ $REPO_DIR แล้วรัน script ใหม่
     (AirDrop / USB / scp — ห้ามผ่าน git หรือแชท ไฟล์พวกนี้มีรหัสผ่าน)
     เสร็จแล้ว:  chmod 600 .env config/users.json"
fi

chmod 600 .env config/users.json
ok "chmod 600 .env, config/users.json"

# ---------------------------------------------------------------- .env fixes

step "5/7 ตรวจ .env"

grep -qE '^TELEGRAM_BOT_TOKEN=.+' .env \
  || die ".env ไม่มีค่า TELEGRAM_BOT_TOKEN"
ok "TELEGRAM_BOT_TOKEN มีค่า"

grep -qE '^DEEP_PREWARM=' .env \
  && ok "DEEP_PREWARM ตั้งไว้แล้ว" \
  || warn "ไม่มี DEEP_PREWARM ใน .env (.env.example ก็ไม่มี) — bot.ts:1357 อ่านตัวนี้ ถ้าเครื่องเดิมตั้ง =1 ให้เติมด้วย"

# bookingEngine.ts reads process.env.SCREENSHOTS_DIR and it wins over the
# __dirname-relative default — a path copied from the old machine breaks here.
WANT_SHOTS="$REPO_DIR/screenshots"
CUR_SHOTS="$(grep -E '^SCREENSHOTS_DIR=' .env | head -1 | cut -d= -f2- || true)"
if [[ -n "$CUR_SHOTS" && "$CUR_SHOTS" != "$WANT_SHOTS" ]]; then
  cp .env ".env.bak-setup-$STAMP"
  sed -i '' "s|^SCREENSHOTS_DIR=.*|SCREENSHOTS_DIR=$WANT_SHOTS|" .env
  ok "แก้ SCREENSHOTS_DIR ให้ชี้เครื่องนี้ (ของเดิมสำรองไว้ที่ .env.bak-setup-$STAMP)"
  warn "  เดิม: $CUR_SHOTS"
else
  ok "SCREENSHOTS_DIR ถูกต้อง"
fi

mkdir -p screenshots reports

# -------------------------------------------------------------------- plist

step "6/7 สร้าง launchd plist"

if [[ -f "$PLIST" ]]; then
  cp "$PLIST" "$PLIST.bak-$STAMP"
  warn "มี plist เดิมอยู่ — สำรองไว้ที่ $PLIST.bak-$STAMP"
fi

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-c</string>
        <string>cd $REPO_DIR &amp;&amp; caffeinate -disu npm run bot</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>$REPO_DIR/bot.stdout.log</string>

    <key>StandardErrorPath</key>
    <string>$REPO_DIR/bot.stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$LAUNCHD_PATH</string>
        <key>TZ</key>
        <string>Asia/Bangkok</string>
    </dict>
</dict>
</plist>
PLIST_EOF

chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "plist ที่สร้างมา format ผิด"
ok "$PLIST (KeepAlive + caffeinate -disu, path ชี้ $REPO_DIR)"

# --------------------------------------------------------------------- start

step "7/7 สตาร์ทบอท"

if (( START_BOT == 0 )); then
  cat <<EOF

  ยังไม่ได้สตาร์ท (ตั้งใจ)

  \033[33m⚠ Telegram token ใช้ได้ทีละเครื่องเท่านั้น\033[0m
  ถ้าเครื่องเดิมยังรันอยู่ด้วย token เดียวกัน จะชนกัน (409 Conflict)
  แล้ว update จะสลับเข้าเครื่องใดเครื่องหนึ่งแบบสุ่ม — จองพลาดได้จริง

  เลือกทางใดทางหนึ่งก่อนสตาร์ท:
    • เครื่องนี้เป็นเครื่องสำรอง → ปล่อยไว้แบบนี้ ค่อย bootstrap ตอนเครื่องเดิมตาย
    • ให้เครื่องนี้เป็นเครื่องหลัก → หยุดบอทเครื่องเดิมก่อน
    • อยากรันคู่กัน → ขอ token ใหม่จาก @BotFather ใส่ .env เครื่องนี้

  พร้อมแล้วสตาร์ทด้วย:
    launchctl bootstrap gui/\$UID $PLIST

EOF
  exit 0
fi

printf '\n  \033[33m⚠ token ใช้ได้ทีละเครื่อง — เครื่องเดิมหยุดแล้วหรือใช้ token คนละตัวแล้วใช่ไหม?\033[0m\n'
read -r -p "  พิมพ์ yes เพื่อสตาร์ท: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || die "ยกเลิก — สตาร์ททีหลังด้วย: launchctl bootstrap gui/\$UID $PLIST"

launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null \
  || launchctl kickstart -k "gui/$UID/$LABEL"
sleep 8

if pgrep -f "ts-node src/server/bot.ts" >/dev/null; then
  ok "บอทรันอยู่ (pid $(pgrep -f 'ts-node src/server/bot.ts' | head -1))"
else
  die "บอทไม่ขึ้น — ดู log: tail -50 $REPO_DIR/bot.stderr.log"
fi

if pmset -g assertions | grep -q "caffeinate"; then
  ok "caffeinate ถือ assertion อยู่ (เครื่องจะไม่หลับ)"
else
  warn "ไม่เจอ caffeinate assertion — เครื่องอาจหลับแล้วพลาดเที่ยง เช็ค bot.stderr.log"
fi

cat <<EOF

  เสร็จแล้ว ยืนยันด้วยตาอีกที — heartbeat ต้องขึ้นทุก ~80 วินาที:

    tail -f $REPO_DIR/bot.stdout.log

EOF
