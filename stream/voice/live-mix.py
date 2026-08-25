#!/usr/bin/env python3
"""live-mix.py — emit silence to stdout; when live.wav's mtime changes, dump its
PCM once. That's what makes a spoken line play exactly once instead of looping.
Pipe into the ffmpeg audio FIFO:  python3 live-mix.py > /tmp/grokdev-voice.pcm
"""
import os, sys, time, wave

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE_WAV = os.environ.get("LIVE_WAV", os.path.join(HERE, "live.wav"))
RATE, CH, WIDTH = 44100, 2, 2
CHUNK = int(RATE * 0.05)                       # 50ms
SILENCE = b"\x00" * (CHUNK * CH * WIDTH)

def dump(path):
    try:
        with wave.open(path, "rb") as w:
            if w.getframerate() != RATE or w.getnchannels() != CH:
                return
            while True:
                frames = w.readframes(CHUNK)
                if not frames:
                    break
                sys.stdout.buffer.write(frames)
                sys.stdout.buffer.flush()
    except Exception:
        pass

last_mtime = 0
while True:
    try:
        m = os.path.getmtime(LIVE_WAV)
    except OSError:
        m = 0
    if m and m != last_mtime:
        last_mtime = m
        dump(LIVE_WAV)
    else:
        sys.stdout.buffer.write(SILENCE)
        sys.stdout.buffer.flush()
        time.sleep(0.05)
