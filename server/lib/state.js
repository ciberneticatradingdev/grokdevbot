// state.js — persistence + event bus.
// Primary store: Postgres (survives deploys/restarts). Falls back to JSON files
// when DATABASE_URL is unset (local dev). Journal → events table; the rest of the
// state (coin, goals, notes, counters) → kv row "state".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasDb, initDb, dbInsertEvent, dbLoadEvents, dbMaxEventId, dbSetKv, dbGetKv } from "./db.js";

// anchored to the server dir, not process.cwd() — launching from another
// directory must not silently read/write someone else's data/ folder
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA, { recursive: true });

const STATE_FILE = process.env.STATE_FILE || path.join(DATA, "state.json");
const JOURNAL_FILE = path.join(DATA, "journal.jsonl");

export const dataDir = DATA;

export const state = {
  nextEventId: 1,
  tick: 0,
  events: [],          // ring buffer, last 400 (scan/think/act/tool/error/info/chat/tweet)
  coin: null,          // { mint, name, symbol, sig, ts } once launched
  tweetsToday: [],     // timestamps for rate caps
  spendToday: [],      // { ts, sol, what }
  lastClaimAt: 0,
  lastTweetAt: 0,
  goals: [],           // bot-editable goal list
  notes: {},           // bot-editable key/value scratch memory
  questions: [],       // { id, q, asker, ts, answer, answeredAt } — ask-my-human queue
  whispers: [],        // { id, text, ts, read, source } — PRIVATE operator→bot channel; never becomes an event
  telegramChatId: null, // the one Telegram chat bound as the dev's private line
};

// the state snapshot persisted to kv (everything except the events buffer)
function snapshot() {
  const { events, ...rest } = state;
  return rest;
}

let saveTimer = null;
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snap = snapshot();
    if (hasDb) dbSetKv("state", snap).catch(() => {});
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
  }, 500);
}

// async — call and await at boot before serving.
export async function load() {
  if (hasDb) {
    try {
      await initDb();
      const snap = await dbGetKv("state");
      if (snap) Object.assign(state, snap);
      const evs = await dbLoadEvents(400);
      if (evs) state.events = evs;
      state.nextEventId = Math.max(state.nextEventId, (await dbMaxEventId()) + 1, ...state.events.map(e => e.id + 1), 1);
      console.log(`[db] loaded ${state.events.length} events, tick ${state.tick}, coin ${state.coin?.symbol || "none"}`);
      return;
    } catch (e) { console.error("[db] load failed, falling back to files:", e.message); }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    Object.assign(state, raw);
    state.nextEventId = Math.max(state.nextEventId, ...state.events.map(e => e.id + 1), 1);
  } catch { /* fresh start */ }
}

// ---- SSE ----
export const sseClients = new Set();

export function pushEvent(type, text, meta = {}) {
  const ev = { id: state.nextEventId++, ts: Date.now(), type, text, ...meta };
  state.events.push(ev);
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  save();
  if (hasDb) dbInsertEvent(ev).catch(() => {});
  else { try { fs.appendFileSync(JOURNAL_FILE, JSON.stringify(ev) + "\n"); } catch {} }
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
  console.log(`[${type}] ${String(text).slice(0, 200)}`);
  return ev;
}

// ---- daily windows ----
const DAY = 24 * 60 * 60 * 1000;
export function pruneDaily() {
  const cut = Date.now() - DAY;
  state.tweetsToday = state.tweetsToday.filter(t => t > cut);
  state.spendToday = state.spendToday.filter(s => s.ts > cut);
}
export function spentToday() {
  pruneDaily();
  return state.spendToday.reduce((a, s) => a + s.sol, 0);
}
