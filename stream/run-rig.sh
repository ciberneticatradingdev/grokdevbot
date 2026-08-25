#!/usr/bin/env bash
# run-rig.sh — start the livestream rig (everything except the agent server).
#   1. chat poller  → hud/chat.json + hud/inbox.json (+ sends outbox if PUMP_CHAT_TOKEN)
#   2. voice mixer  → /tmp/grokdev-voice.pcm FIFO
#   3. prints the ffmpeg command to start the actual RTMP push (stream.sh)
# The agent server (server/index.js) runs separately and talks to the rig via files.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIFO="${LIVE_FIFO:-/tmp/grokdev-voice.pcm}"

# load env if present (COIN_MINT, PUMP_CHAT_TOKEN, RTMP_URL, STREAM_KEY...)
[ -f "$HERE/../server/.env" ] && set -a && . "$HERE/../server/.env" && set +a

echo "[rig] chat poller..."
( cd "$HERE/chat" && [ -d node_modules ] || (cd "$HERE/chat" && npm init -y >/dev/null 2>&1 && npm install ws >/dev/null 2>&1) )
( cd "$HERE/chat" && nohup node poller.mjs > /tmp/grokdev-chat.log 2>&1 & echo "  pid $!" )

echo "[rig] voice mixer → $FIFO"
[ -p "$FIFO" ] || mkfifo "$FIFO"
( nohup python3 "$HERE/voice/live-mix.py" > "$FIFO" 2>/tmp/grokdev-mix.log & echo "  pid $!" )

echo
echo "[rig] ready. To go LIVE on pump.fun:"
echo "  1. open stream/hud/scene.html fullscreen in Chrome on the capture display"
echo "  2. RTMP_URL=... STREAM_KEY=... $HERE/stream.sh"
echo "  (DRY_RUN=1 to print the ffmpeg command without streaming)"
