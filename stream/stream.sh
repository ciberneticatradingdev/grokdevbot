#!/usr/bin/env bash
# stream.sh — push grokdev's HUD desktop + live voice to pump.fun RTMP.
# Cross-platform capture: Linux x11grab, macOS avfoundation.
# Required: RTMP_URL + STREAM_KEY (or a full rtmps dest in STREAM_KEY).
# The HUD is a fullscreen Chrome at stream/hud/scene.html on the capture display.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RTMP_URL="${RTMP_URL:-}"
STREAM_KEY="${STREAM_KEY:-}"
FPS="${FPS:-30}"
VIDEO_SIZE="${VIDEO_SIZE:-1280x800}"
VBITRATE="${VIDEO_BITRATE:-2500k}"; MAXRATE="${MAXRATE:-3000k}"; BUFSIZE="${BUFSIZE:-5000k}"
PRESET="${PRESET:-veryfast}"
LIVE_FIFO="${LIVE_FIFO:-/tmp/grokdev-voice.pcm}"
DRY_RUN="${DRY_RUN:-0}"

# resolve destination (key may be full URL, or url+key)
if [[ "$STREAM_KEY" == rtmp* ]]; then DEST="$STREAM_KEY";
elif [[ "$RTMP_URL" == *"$STREAM_KEY"* && -n "$STREAM_KEY" ]]; then DEST="$RTMP_URL";
else DEST="${RTMP_URL%/}/$STREAM_KEY"; fi
[ -z "$DEST" ] && { echo "set RTMP_URL + STREAM_KEY"; exit 1; }

# audio input: live FIFO if present, else silence (RTMP sinks want an audio track)
if [ -p "$LIVE_FIFO" ]; then
  AUDIO_IN=(-f s16le -ar 44100 -ac 2 -i "$LIVE_FIFO")
else
  AUDIO_IN=(-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100")
fi

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  # macOS: capture a screen index (set AV_SCREEN, default 1). List devices:
  #   ffmpeg -f avfoundation -list_devices true -i ""
  VIDEO_IN=(-f avfoundation -capture_cursor 0 -framerate "$FPS" -i "${AV_SCREEN:-1}:none")
else
  VIDEO_IN=(-f x11grab -framerate "$FPS" -video_size "$VIDEO_SIZE" -i "${DISPLAY_NAME:-:0}.0")
fi

CMD=(ffmpeg -y
  "${VIDEO_IN[@]}" "${AUDIO_IN[@]}"
  -c:v libx264 -preset "$PRESET" -tune zerolatency -pix_fmt yuv420p
  -b:v "$VBITRATE" -maxrate "$MAXRATE" -bufsize "$BUFSIZE" -g "$((FPS*2))"
  -c:a aac -b:a 128k -ar 44100
  -f flv "$DEST")

if [ "$DRY_RUN" = "1" ]; then
  printf '%q ' "${CMD[@]/$DEST/rtmp://***redacted***}"; echo; exit 0
fi
echo "streaming to rtmp://***redacted*** ($OS)"
exec "${CMD[@]}"
