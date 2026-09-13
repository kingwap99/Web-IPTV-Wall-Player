#!/usr/bin/env bash
# Web IPTV Wall player 區域網路模式啟動腳本
# 用法： bash scripts/serve-lan.sh   （可先用 PORT=9000 指定其他埠）
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 0.0.0.0)"

echo "Web IPTV Wall player — 區域網路模式（含 server 共用資料 API）"
echo "網內裝置： http://${LAN_IP}:${PORT}/"
echo "本機使用： http://127.0.0.1:${PORT}/"
echo "按 Ctrl-C 停止。"
echo
exec python3 server.py --port "$PORT" --host 0.0.0.0
