// chat-poller.mjs — pump.fun chat + comments for grokdev's coin.
// Two feeds, merged into stream/hud/chat.json + inbox.json for the HUD and the agent:
//   1. LIVE CHAT: reverse-engineered Socket.IO v4 over raw ws (livechat.pump.fun).
//      Anonymous (token:null) = read-only; with PUMP_CHAT_TOKEN it can also SEND
//      messages queued in outbox.json.
//   2. COIN COMMENTS: frontend-api-v3.pump.fun/replies/{mint} polled every 12s —
//      the comment thread on the coin page.
// Spawned by server/index.js when COIN_MINT is set (runs fine on Railway; no desktop needed).
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUD = path.join(__dirname, "..", "stream", "hud");
const ROOM_ID = process.env.ROOM_ID || process.env.COIN_MINT || "";
const TOKEN = process.env.PUMP_CHAT_TOKEN || null;
const USERNAME = process.env.PUMP_CHAT_USERNAME || "grokdev";
const ME = new Set([USERNAME.toLowerCase(), "grokdev"]);

if (!ROOM_ID) { console.error("[poller] no COIN_MINT — idle"); process.exit(0); }

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

const writeAtomic = (file, obj) => {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
};
const readJson = (file, fb) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fb; } };

let messages = [];
let pending = [];
let seenIds = new Set();
let ackId = 0;
let ws, pingTimer, urlIdx = 0, backoff = 1000;

const isHuman = (u) => u && !ME.has(String(u).toLowerCase()) && !String(u).toLowerCase().startsWith("grokdev");
const shortAddr = (u) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(u) ? u.slice(0, 4) + "…" + u.slice(-4) : u;

function mapIncoming(raw) {
  return {
    id: raw.id || raw._id || raw.signature,
    user: raw.username || raw.user_username || raw.user || raw.name,
    body: raw.message || raw.body || raw.text || raw.reply,
    t: raw.timestamp || raw.createdAt || raw.created_at || raw.t || raw.time || Date.now(),
  };
}

// wake the agent server the instant a FRESH human message lands (history
// replayed on connect must not wake it). Debounced here; the server has its
// own cooldown too. Uses ADMIN_TOKEN inherited from the parent env.
const AGENT_PORT = process.env.PORT || 8947;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
let lastWakePing = 0;
function wakeBrain(reason) {
  if (!ADMIN_TOKEN) return;
  const now = Date.now();
  if (now - lastWakePing < 5000) return;
  lastWakePing = now;
  fetch(`http://127.0.0.1:${AGENT_PORT}/api/wake`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: ADMIN_TOKEN, reason }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

function ingest(raw, source, fresh = false) {
  const m = mapIncoming(raw);
  if (!m.body || !m.user) return;
  const id = m.id || `${m.user}|${m.body}`;
  if (seenIds.has(id)) return;
  seenIds.add(id); if (seenIds.size > 5000) seenIds.delete(seenIds.values().next().value);
  const user = shortAddr(String(m.user));
  messages = [...messages, { t: m.t, user, body: m.body, me: !isHuman(m.user), src: source }].slice(-80);
  writeAtomic(path.join(HUD, "chat.json"), { messages });
  if (isHuman(m.user)) {
    pending = [...pending, { user, body: m.body, t: m.t, id, src: source }].slice(-40);
    writeAtomic(path.join(HUD, "inbox.json"), { pending, lastSeenId: id });
    if (fresh) wakeBrain(source === "comment" ? "comment" : "chat");
  }
  console.log(`[${source}] ${user}: ${String(m.body).slice(0, 80)}`);
}

// honor agent's inbox drain (it writes pending: [])
function syncInboxDrain() {
  const box = readJson(path.join(HUD, "inbox.json"), null);
  if (box && Array.isArray(box.pending) && box.pending.length === 0 && pending.length) pending = [];
}
setInterval(syncInboxDrain, 2000);

// ---------- live chat (websocket) ----------
function send(frame) { try { ws.send(frame); } catch {} }
function emit(event, payload) { const id = ackId; ackId = (ackId + 1) % 10; send(`42${id}["${event}",${JSON.stringify(payload)}]`); return id; }

function handleText(data) {
  const s = data.toString();
  if (s === "2") return send("3");
  if (s.startsWith("0")) {
    try { const info = JSON.parse(s.slice(1)); clearInterval(pingTimer); pingTimer = setInterval(() => send("2"), info.pingInterval || 25000); } catch {}
    send(`40${JSON.stringify({ origin: "https://pump.fun", timestamp: Date.now(), token: TOKEN })}`);
    return;
  }
  if (s.startsWith("40")) { emit("joinRoom", { roomId: ROOM_ID, username: TOKEN ? USERNAME : "anonymous" }); return; }
  if (s.startsWith("43")) { emit("getMessageHistory", { roomId: ROOM_ID, before: null, limit: 80 }); return; }
  if (s.startsWith("42")) {
    try {
      const arr = JSON.parse(s.slice(2).replace(/^\d+/, ""));
      const [event, payload] = arr;
      if (event === "newMessage") ingest(payload, "live", true);
      else if (event === "messageHistory" && Array.isArray(payload)) payload.forEach(p => ingest(p, "live"));
      else if (event === "setCookie") emit("getMessageHistory", { roomId: ROOM_ID, before: null, limit: 80 });
    } catch {}
  }
}

function drainOutbox() {
  if (!TOKEN) return;
  const box = readJson(path.join(HUD, "outbox.json"), { queue: [] });
  if (!box.queue?.length) return;
  for (const msg of box.queue) emit("sendMessage", { roomId: ROOM_ID, message: msg.body });
  writeAtomic(path.join(HUD, "outbox.json"), { queue: [] });
}

function connect() {
  const url = WS_URLS[urlIdx % WS_URLS.length]; urlIdx++;
  ws = new WebSocket(url, { headers: wsHeaders });
  ws.on("open", () => { backoff = 1000; console.log("[live] connected", url); });
  ws.on("message", handleText);
  ws.on("close", () => { clearInterval(pingTimer); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); });
  ws.on("error", (e) => { console.error("[live] ws error:", e.message); try { ws.close(); } catch {} });
}
connect();
setInterval(drainOutbox, 2000);

// ---------- coin page comments (REST) ----------
// The first poll is backlog — only comments seen after it count as fresh.
let commentsPrimed = false;
async function pollComments() {
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/replies/${ROOM_ID}?limit=50&offset=0`, {
      headers: { "User-Agent": wsHeaders["User-Agent"], Origin: "https://pump.fun" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const j = await res.json();
    const list = Array.isArray(j) ? j : (j.replies || j.data || []);
    for (const r of list.slice().reverse()) ingest(r, "comment", commentsPrimed);
    commentsPrimed = true;
  } catch {}
}
pollComments();
setInterval(pollComments, 12000);
