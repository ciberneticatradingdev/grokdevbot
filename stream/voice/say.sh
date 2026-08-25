#!/usr/bin/env bash
# say.sh TAG "text" — grokdev's TTS entry point.
# Synthesizes neural speech into live.wav, which live-mix.py streams once into the
# ffmpeg audio FIFO. The HUD caption is written by the caller (server lib/live.js),
# so this script only handles audio — keeping a single source for captions.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXT="${2:-}"
[ -z "$TEXT" ] && exit 0
"$HERE/speak-neural.sh" "$TEXT" || true
