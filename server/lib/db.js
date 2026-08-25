// db.js — Postgres persistence so nothing is lost across deploys/restarts.
// Two tables:
//   events(id, ts, type, text, meta)  — the full append-only journal
//   kv(key, value)                     — state snapshot + long-term memory
// If DATABASE_URL is unset (local dev), everything degrades to the JSON files.
import pg from "pg";

const URL = process.env.DATABASE_URL || "";
export const hasDb = !!URL;

let pool = null;
if (hasDb) {
  pool = new pg.Pool({
    connectionString: URL,
    ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
    max: 4,
  });
  pool.on("error", (e) => console.error("[db] pool error:", e.message));
}

export async function initDb() {
  if (!pool) return false;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id     BIGINT PRIMARY KEY,
        ts     BIGINT NOT NULL,
        type   TEXT   NOT NULL,
        text   TEXT   NOT NULL,
        meta   JSONB
      );
      CREATE INDEX IF NOT EXISTS events_id_idx ON events (id);
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    return true;
  } catch (e) { console.error("[db] init failed:", e.message); return false; }
}

// ---- events (journal) ----
export async function dbInsertEvent(ev) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO events (id, ts, type, text, meta) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [ev.id, ev.ts, ev.type, String(ev.text).slice(0, 4000), ev.meta ? JSON.stringify(ev.meta) : null]
    );
  } catch (e) { /* fire-and-forget */ }
}
export async function dbLoadEvents(limit = 400) {
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT id, ts, type, text, meta FROM events ORDER BY id DESC LIMIT $1`, [limit]);
    return r.rows.reverse().map((e) => ({ ...e, id: Number(e.id), ts: Number(e.ts), ...(e.meta || {}), meta: undefined }));
  } catch (e) { console.error("[db] loadEvents:", e.message); return null; }
}
// Pull the last N events of one type straight from the DB — the in-memory ring
// is dominated by think/act/tool, so chat history falls out of it fast.
export async function dbLoadEventsByType(type, limit = 30) {
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT id, ts, type, text, meta FROM events WHERE type = $1 ORDER BY id DESC LIMIT $2`,
      [type, limit]
    );
    return r.rows.reverse().map((e) => ({ ...e, id: Number(e.id), ts: Number(e.ts), ...(e.meta || {}), meta: undefined }));
  } catch (e) { console.error("[db] loadByType:", e.message); return null; }
}

export async function dbMaxEventId() {
  if (!pool) return 0;
  try { const r = await pool.query(`SELECT COALESCE(MAX(id),0) AS m FROM events`); return Number(r.rows[0].m); }
  catch { return 0; }
}

// ---- kv (state snapshot + memory) ----
export async function dbSetKv(key, value) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  } catch (e) { console.error("[db] setKv:", e.message); }
}
export async function dbGetKv(key) {
  if (!pool) return null;
  try { const r = await pool.query(`SELECT value FROM kv WHERE key=$1`, [key]); return r.rows[0]?.value ?? null; }
  catch { return null; }
}
