// memory.js — long-term memory with rolling consolidation (fablemars pattern).
// Journal entries beyond a threshold get merged into a 500-word summary by the brain model.
import fs from "node:fs";
import path from "node:path";
import { dataDir, state, pushEvent } from "./state.js";
import { hasDb, dbGetKv, dbSetKv } from "./db.js";

const MEM_FILE = path.join(dataDir, "memory.json");

export const memory = { summary: "", consolidatedThrough: 0 };

export async function loadMemory() {
  if (hasDb) {
    try { const m = await dbGetKv("memory"); if (m) Object.assign(memory, m); return; } catch {}
  }
  try { Object.assign(memory, JSON.parse(fs.readFileSync(MEM_FILE, "utf8"))); } catch {}
}
function saveMemory() {
  if (hasDb) dbSetKv("memory", { summary: memory.summary, consolidatedThrough: memory.consolidatedThrough }).catch(() => {});
  try { fs.writeFileSync(MEM_FILE, JSON.stringify(memory, null, 2)); } catch {}
}

// Wipe the consolidated archive. Used when older memories contradict a fact the
// operator has since settled (e.g. which coin is ours) — a stale 500-word
// summary outweighs any single new note, so it has to go.
export function resetMemorySummary() {
  memory.summary = "";
  memory.consolidatedThrough = state.events.length ? state.events[state.events.length - 1].id : 0;
  saveMemory();
}

let consolidating = false;

// summarize: the provider-agnostic one-shot completion from brain.js (or null → skip).
export async function maybeConsolidate(summarize) {
  if (consolidating || !summarize) return;
  const unconsolidated = state.events.filter(e => e.id > memory.consolidatedThrough);
  if (unconsolidated.length < 120) return;
  consolidating = true;
  try {
    const batch = unconsolidated.slice(0, 200);
    const lines = batch.map(e => `[${e.type}] ${e.text}`).join("\n");
    const text = await summarize({
      system: "You maintain the long-term memory of grokdev, an autonomous memecoin-developer agent that streams 24/7. Merge the OLD ARCHIVE with the NEW EVENTS into at most 500 words. Keep: deployed coins and their CAs, theses and their outcomes (correct/wrong), promises made to the community, follower names and running jokes, market moments, tools it built, mistakes and lessons. Drop routine ticks and noise. Write in first person as grokdev's own memory.",
      user: `OLD ARCHIVE:\n${memory.summary || "(empty)"}\n\nNEW EVENTS:\n${lines}\n\nWrite the merged archive now.`,
      maxTokens: 700,
    });
    if (!text) throw new Error("empty summary");
    memory.summary = text;
    memory.consolidatedThrough = batch[batch.length - 1].id;
    saveMemory();
    pushEvent("info", `memory consolidated through event ${memory.consolidatedThrough}`);
  } catch (e) {
    // billing pause ≠ bug: brain.js already reports the credit outage once
    if (!/credit balance/i.test(e.message)) pushEvent("error", `memory consolidation failed: ${e.message}`);
  } finally {
    consolidating = false;
  }
}
