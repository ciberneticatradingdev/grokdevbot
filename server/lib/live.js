// live.js — bridge between the agent and the stream rig (stream/ folder).
// The chat poller (stream/chat/poller.mjs) writes hud/chat.json + hud/inbox.json.
// The agent: reads inbox (pending viewer messages), speaks via voice pipeline
// (say.sh → edge-tts → live.wav → ffmpeg FIFO), and queues chat replies in
// outbox.json (the poller emits them when PUMP_CHAT_TOKEN auth is available).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pushEvent } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STREAM_DIR = process.env.STREAM_DIR || path.join(__dirname, "..", "..", "stream");
const HUD = path.join(STREAM_DIR, "hud");
const INBOX = path.join(HUD, "inbox.json");
const OUTBOX = path.join(HUD, "outbox.json");
const LIVE_JSON = path.join(HUD, "live.json");
const SAY_SH = path.join(STREAM_DIR, "voice", "say.sh");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---- viewer chat inbox ----
export function readInbox() {
  return readJson(INBOX, { pending: [], lastSeenId: null });
}
export function writeInbox(box) {
  writeJsonAtomic(INBOX, box);
}
export function drainInbox() {
  const box = readInbox();
  const pending = box.pending || [];
  if (pending.length) {
    writeJsonAtomic(INBOX, { ...box, pending: [] });
    // journal each viewer/comment so it's persisted (DB) and part of the context,
    // not just fleeting inbox state. Skip web messages (already logged by /api/say).
    for (const m of pending) {
      if (m.src && m.src !== "web") pushEvent("chat", `${m.user}: ${m.body}`, { source: m.src });
    }
  }
  return pending;
}

// ---- speaking (voice + HUD caption) ----
export function speak(text, tag = "GROKDEV") {
  text = String(text || "").slice(0, 500);
  if (!text) return { spoken: false };
  // HUD caption feed (last 40)
  const feed = readJson(LIVE_JSON, { lines: [] });
  feed.lines = [...(feed.lines || []), { t: Date.now(), tag, body: text }].slice(-40);
  writeJsonAtomic(LIVE_JSON, feed);
  pushEvent("speak", text);
  // fire-and-forget TTS if the rig is installed
  if (fs.existsSync(SAY_SH)) {
    try {
      const p = spawn("bash", [SAY_SH, tag, text], { stdio: "ignore", detached: true });
      p.unref();
      return { spoken: true, tts: true };
    } catch (e) { pushEvent("error", `tts spawn failed: ${e.message}`); }
  }
  return { spoken: true, tts: false };
}

// ---- chat send (queued; poller emits when authenticated) ----
export function queueChatMessage(text) {
  text = String(text || "").slice(0, 300);
  if (!text) return { queued: false };
  const box = readJson(OUTBOX, { queue: [] });
  box.queue = [...(box.queue || []), { t: Date.now(), body: text }].slice(-20);
  writeJsonAtomic(OUTBOX, box);
  pushEvent("chat", `→ chat: ${text}`);
  return { queued: true };
}

export function streamStatus() {
  const chat = readJson(path.join(HUD, "chat.json"), { messages: [] });
  const inbox = readInbox();
  return {
    rigInstalled: fs.existsSync(STREAM_DIR),
    ttsAvailable: fs.existsSync(SAY_SH),
    chatMessages: (chat.messages || []).length,
    pendingViewerMessages: (inbox.pending || []).length,
  };
}
