// poller.mjs — pump.fun live chat client for grokdev.
// Reverse-engineered Socket.IO v4 (Engine.IO 4) over raw ws. Ported from
// grokius-maximus, with the gap fixed: it now SENDS messages too (drains outbox.json),
// when PUMP_CHAT_TOKEN is set (anonymous token:null is read-only).
//
//   ROOM_ID = your coin mint.  Run:  node stream/chat/poller.mjs
//   Writes: hud/chat.json (rendered), hud/inbox.json (agent work queue).
//   Reads:  hud/outbox.json (messages the agent queued to send).
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUD = path.join(__dirname, "..", "hud");
const ROOM_ID = process.env.ROOM_ID || process.env.COIN_MINT || "";
const TOKEN = process.env.PUMP_CHAT_TOKEN || null;   // null = anonymous, read-only
const USERNAME = process.env.PUMP_CHAT_USERNAME || "grokdev";
const ME = new Set([USERNAME.toLowerCase(), "grokdev"]);

const WS_URLS = [
  "wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket",
  "wss://ny.pump.fun/socket.io/?EIO=3&transport=websocket",
];
const wsHeaders = {
  Host: "livechat.pump.fun",
  Origin: "https://pump.fun",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  Pragma: "no-cache", "Cache-Control": "no-cache", "Accept-Language": "en-US,en;q=0.9",
};

if (!ROOM_ID) { console.error("no ROOM_ID / COIN_MINT set — chat poller idle"); process.exit(0); }

const writeAtomic = (file, obj) => {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
};
const readJson = (file, fb) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fb; } };

let messages = [];        // rendered log, cap 80
let pending = [];         // viewer messages awaiting the agent
let seenIds = new Set();
let ackId = 0;
let ws, pingTimer, urlIdx = 0, backoff = 1000;

const isHuman = (u) => u && !ME.has(String(u).toLowerCase()) && !String(u).toLowerCase().startsWith("grokdev");

function mapIncoming(raw) {
  return {
    id: raw.id || raw._id,
    user: raw.username || raw.user || raw.name,
    body: raw.message || raw.body || raw.text || raw.reply,
    t: raw.timestamp || raw.createdAt || raw.created_at || raw.t || raw.time || Date.now(),
  };
}

function ingest(raw) {
  const m = mapIncoming(raw);
  if (!m.body || !m.user) return;
  if (m.id && seenIds.has(m.id)) return;
  if (m.id) { seenIds.add(m.id); if (seenIds.size > 5000) seenIds.delete(seenIds.values().next().value); }
  messages = [...messages, { t: m.t, user: m.user, body: m.body, me: !isHuman(m.user) }].slice(-80);
  writeAtomic(path.join(HUD, "chat.json"), { messages });
  if (isHuman(m.user)) {
    pending = [...pending, { user: m.user, body: m.body, t: m.t, id: m.id }].slice(-40);
    writeAtomic(path.join(HUD, "inbox.json"), { pending, lastSeenId: m.id });
  }
}

function send(frame) { try { ws.send(frame); } catch {} }
function emit(event, payload) { const id = ackId; ackId = (ackId + 1) % 10; send(`42${id}["${event}",${JSON.stringify(payload)}]`); return id; }

function handleText(data) {
  const s = data.toString();
  if (s === "2") return send("3");                 // server ping → pong
  if (s.startsWith("0")) {                          // engine.io open
    try { const info = JSON.parse(s.slice(1)); clearInterval(pingTimer); pingTimer = setInterval(() => send("2"), info.pingInterval || 25000); } catch {}
    send(`40${JSON.stringify({ origin: "https://pump.fun", timestamp: Date.now(), token: TOKEN })}`);
    return;
  }
  if (s.startsWith("40")) {                          // connected → join room
    emit("joinRoom", { roomId: ROOM_ID, username: TOKEN ? USERNAME : "anonymous" });
    return;
  }
  if (s.startsWith("43")) {                          // ack → pull history once
    emit("getMessageHistory", { roomId: ROOM_ID, before: null, limit: 80 });
    return;
  }
  if (s.startsWith("42")) {
    try {
      const arr = JSON.parse(s.slice(2).replace(/^\d+/, ""));
      const [event, payload] = arr;
      if (event === "newMessage") ingest(payload);
      else if (event === "messageHistory" && Array.isArray(payload)) payload.forEach(ingest);
      else if (event === "setCookie") emit("getMessageHistory", { roomId: ROOM_ID, before: null, limit: 80 });
    } catch {}
  }
}

function drainOutbox() {
  if (!TOKEN) return;                                // can't send anonymously
  const box = readJson(path.join(HUD, "outbox.json"), { queue: [] });
  if (!box.queue?.length) return;
  for (const msg of box.queue) emit("sendMessage", { roomId: ROOM_ID, message: msg.body });
  writeAtomic(path.join(HUD, "outbox.json"), { queue: [] });
}

function connect() {
  const url = WS_URLS[urlIdx % WS_URLS.length]; urlIdx++;
  ws = new WebSocket(url, { headers: wsHeaders });
  ws.on("open", () => { backoff = 1000; console.log("chat connected", url); });
  ws.on("message", handleText);
  ws.on("close", () => { clearInterval(pingTimer); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); });
  ws.on("error", (e) => { console.error("chat ws error:", e.message); try { ws.close(); } catch {} });
}

connect();
setInterval(drainOutbox, 2000);
