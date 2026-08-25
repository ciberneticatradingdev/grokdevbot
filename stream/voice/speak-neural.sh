#!/usr/bin/env bash
# speak-neural.sh "text" — edge-tts (free Microsoft neural voices, no API key).
# Writes mp3, converts to 44.1k stereo s16 PCM, atomically swaps into live.wav so
# the mixer never reads a half-written file.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXT="${1:-}"
[ -z "$TEXT" ] && exit 0
VOICE="${EDGE_VOICE:-en-US-AndrewNeural}"
RATE="${EDGE_RATE:--4%}"

# locate edge-tts: venv → PATH → python module
EDGE=""
if [ -x "$HERE/.venv/bin/edge-tts" ]; then EDGE="$HERE/.venv/bin/edge-tts";
elif command -v edge-tts >/dev/null 2>&1; then EDGE="edge-tts"; fi

TMP_MP3="$(mktemp -t fb_tts_XXXX).mp3"
if [ -n "$EDGE" ]; then
  "$EDGE" --voice "$VOICE" --rate "$RATE" --text "$TEXT" --write-media "$TMP_MP3"
elif python3 -c "import edge_tts" >/dev/null 2>&1; then
  python3 -m edge_tts --voice "$VOICE" --rate "$RATE" --text "$TEXT" --write-media "$TMP_MP3"
else
  echo "edge-tts not installed; caption-only" >&2
  exit 0
fi

TMP_WAV="$(mktemp -t fb_wav_XXXX).wav"
ffmpeg -y -loglevel error -i "$TMP_MP3" -ar 44100 -ac 2 -c:a pcm_s16le "$TMP_WAV"
mv -f "$TMP_WAV" "$HERE/live.wav"
rm -f "$TMP_MP3"
