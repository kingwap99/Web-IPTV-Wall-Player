#!/usr/bin/env bash
# Web IPTV Wall player — 還原本機（這台 Mac）的常駐站台
#
# 站台搬到別的機器後，本機的兩個 LaunchAgent 會被停用（plist 改名為 *.disabled）。
# 執行這個腳本會把它們重新裝回來：
#
#   com.neo.web-iptv-wall              服務本體（0.0.0.0:8080，KeepAlive）
#   com.neo.web-iptv-wall.healthcheck  每 5 分鐘探測，異常自動重啟
#
# 用法：
#   bash scripts/restore-local-server.sh
#
# 注意：每台機器各有自己的 data/wall.json。本機與其他站台同時開著，播放清單與
#       我的最愛會各寫各的、不會同步。

set -uo pipefail

if [ "$(uname -s)" != 'Darwin' ]; then
  echo '這個腳本使用 launchd，只能在 macOS 上執行。' >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
SERVER_LABEL='com.neo.web-iptv-wall'
HEALTH_LABEL='com.neo.web-iptv-wall.healthcheck'
PORT='8080'

if [ ! -f "$REPO_ROOT/server.py" ]; then
  echo "找不到 $REPO_ROOT/server.py，請在 repo 內執行這個腳本。" >&2
  exit 1
fi

# 優先使用 Homebrew 的 python3（版本較新），沒有才退回系統內建；兩者都能跑 server.py。
PYTHON='/opt/homebrew/bin/python3'
[ -x "$PYTHON" ] || PYTHON='/usr/bin/python3'

mkdir -p "$AGENTS_DIR"

cat > "$AGENTS_DIR/$SERVER_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVER_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$REPO_ROOT/server.py</string>
        <string>--port</string>
        <string>$PORT</string>
        <string>--host</string>
        <string>0.0.0.0</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/web-iptv-wall.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/web-iptv-wall.err.log</string>
</dict>
</plist>
PLIST

cat > "$AGENTS_DIR/$HEALTH_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$HEALTH_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$REPO_ROOT/scripts/healthcheck.py</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/web-iptv-wall-healthcheck.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/web-iptv-wall-healthcheck.err.log</string>
</dict>
</plist>
PLIST

UID_NUM="$(id -u)"

# 先把可能還在載入的舊 job 移除，再重新載入。
for label in "$HEALTH_LABEL" "$SERVER_LABEL"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null
done

for label in "$SERVER_LABEL" "$HEALTH_LABEL"; do
  if ! launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/$label.plist"; then
    echo "載入 $label 失敗。" >&2
    exit 1
  fi
done

echo '等待服務啟動…'
sleep 3

ok=1
for path in '/' '/js/app.js' '/api/state'; do
  code="$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' "http://127.0.0.1:$PORT$path" 2>/dev/null)"
  [ -n "$code" ] || code='000'
  printf '  %-14s %s\n' "$path" "$code"
  [ "$code" = '200' ] || ok=0
done

if [ "$ok" = '1' ]; then
  echo "本機站台已還原：http://localhost:$PORT/"
  echo '（提醒：本機與其他站台的 data/wall.json 各自獨立，不會同步。）'
else
  echo '服務已載入，但檢查未全數通過，請看 /tmp/web-iptv-wall.err.log。' >&2
  exit 1
fi
