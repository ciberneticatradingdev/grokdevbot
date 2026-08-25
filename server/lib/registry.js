// registry.js — the tool belt. Built-in tools + hot-loaded tools from tools/.
// Tools in tools/*.mjs are loaded fresh each tick (cache-busted by mtime), so new
// capabilities apply without a restart. Each dynamic tool is an ESM module shaped:
//   export default { name, description, input_schema, run: async (input) => any }
// NOTE: the bot does NOT author its own code here — new tools are added by a human
// (or a separately-gated review path) dropping vetted modules into tools/.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as walletLib from "./wallet.js";
import * as pump from "./pump.js";
import * as claim from "./claim.js";
import * as jupiter from "./jupiter.js";
import * as x from "./x.js";
import * as live from "./live.js";
import * as telegram from "./telegram.js";
import { state, save, spentToday, pushEvent } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(__dirname, "..", "tools");
const MAX_SOL_PER_DAY = Number(process.env.MAX_SOL_PER_DAY || 0.5);
const MAX_SOL_PER_ACTION = Number(process.env.MAX_SOL_PER_ACTION || 0.2);

function guardSpend(sol, what) {
  if (sol > MAX_SOL_PER_ACTION) throw new Error(`${sol} SOL exceeds per-action cap ${MAX_SOL_PER_ACTION}`);
  if (spentToday() + sol > MAX_SOL_PER_DAY) throw new Error(`daily spend cap ${MAX_SOL_PER_DAY} SOL would be exceeded (spent ${spentToday().toFixed(3)})`);
  state.spendToday.push({ ts: Date.now(), sol, what });
  save();
}

const builtins = [
  {
    name: "get_status",
    description: "Your current status: wallet balance, token holdings, launched coin, claimable creator fees, stream/chat state, tweets left today, spend left today.",
    input_schema: { type: "object", properties: {} },
    run: async () => ({
      wallet: walletLib.address,
      sol: await walletLib.solBalance(),
      tokens: await walletLib.tokenBalances(),
      coin: state.coin,
      claimableCreatorFeesSol: (await claim.claimableLamports()).totalSol,
      stream: live.streamStatus(),
      tweetsLeftToday: x.tweetsLeftToday(),
      solSpentToday: spentToday(),
      goals: state.goals,
    }),
  },
  {
    name: "launch_coin",
    description: "Launch YOUR coin on pump.fun (once — you only get one). Provide name, symbol (2-13 chars A-Z0-9), description, and optionally devBuySol (initial buy, counts against spend caps). Uses the logo at stream/hud/logo.png unless imagePath given.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, symbol: { type: "string" }, description: { type: "string" },
        devBuySol: { type: "number" }, imagePath: { type: "string" },
        twitter: { type: "string" }, website: { type: "string" },
      },
      required: ["name", "symbol", "description"],
    },
    run: async (input) => {
      const devBuySol = Math.max(0, Number(input.devBuySol || 0));
      if (devBuySol > 0) guardSpend(devBuySol, "dev buy");
      const imagePath = input.imagePath || path.join(__dirname, "..", "..", "stream", "hud", "logo.png");
      if (!fs.existsSync(imagePath)) throw new Error(`logo not found at ${imagePath}`);
      return await pump.launchCoin({ ...input, devBuySol, imagePath });
    },
  },
  {
    name: "claim_creator_fees",
    description: "Claim your accumulated pump.fun creator fees (bonding curve + PumpSwap AMM) into your wallet as SOL.",
    input_schema: { type: "object", properties: {} },
    run: async () => await claim.claimCreatorFees(),
  },
  {
    name: "buy_token",
    description: "Buy any Solana token with SOL from your wallet, routed through the Jupiter aggregator. Works on the pump.fun bonding curve AND after a coin graduates to PumpSwap/Raydium — use this for buybacks of your own coin. Respects your spend caps. Omit `mint` to buy your own coin.",
    input_schema: {
      type: "object",
      properties: {
        mint: { type: "string", description: "token mint; defaults to your own coin" },
        sol: { type: "number", description: "how much SOL to spend" },
      },
      required: ["sol"],
    },
    run: async ({ mint, sol }) => {
      sol = Number(sol);
      if (!(sol > 0)) throw new Error("sol must be > 0");
      const target = mint || state.coin?.mint;
      if (!target) throw new Error("no mint given and you have no coin");
      guardSpend(sol, `buy ${target}`);
      return await jupiter.buyWithSol(target, sol);
    },
  },
  {
    name: "sell_token",
    description: "Sell tokens back to SOL through Jupiter (any venue). Amount is in raw base units — check get_status for your holdings first. Use sparingly: selling your own coin looks bad and your community will see it on-chain.",
    input_schema: {
      type: "object",
      properties: {
        mint: { type: "string" },
        amountRaw: { type: "string", description: "raw base units to sell" },
      },
      required: ["mint", "amountRaw"],
    },
    run: async ({ mint, amountRaw }) => await jupiter.sellForSol(mint, amountRaw),
  },
  {
    name: "quote_price",
    description: "Check the live market price of a token via Jupiter without trading — returns how many tokens 1 SOL buys, the price impact, and which venue routes it. Omit `mint` for your own coin.",
    input_schema: { type: "object", properties: { mint: { type: "string" } } },
    run: async ({ mint }) => {
      const target = mint || state.coin?.mint;
      if (!target) throw new Error("no mint given and you have no coin");
      return await jupiter.quotePrice(target);
    },
  },
  {
    name: "post_tweet",
    description: "Post a tweet from your own X account (max 280 chars). Optionally reply to a tweet id. Daily cap applies — make each one count.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, replyToId: { type: "string" } },
      required: ["text"],
    },
    run: async ({ text, replyToId }) => await x.postTweet(text, { replyToId }),
  },
  {
    name: "read_x",
    description: "Search X for tweets (advanced search syntax, e.g. '@yourhandle' for mentions, 'from:user', keywords).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: async ({ query }) => await x.searchX(query),
  },
  {
    name: "read_stream_chat",
    description: "Read and drain pending viewer messages from your pump.fun livestream chat inbox. Returns the messages — answer the interesting ones with speak and/or send_chat.",
    input_schema: { type: "object", properties: {} },
    run: async () => ({ messages: live.drainInbox() }),
  },
  {
    name: "speak",
    description: "Say something out loud on stream (neural TTS) and show it as a caption on the HUD. Your main way to talk to viewers. Keep it punchy, under 2 sentences.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: async ({ text }) => live.speak(text),
  },
  {
    name: "send_chat",
    description: "Queue a text message into the pump.fun livestream chat (delivered by the chat client when authenticated; otherwise viewers still see you via speak captions).",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: async ({ text }) => live.queueChatMessage(text),
  },
  {
    name: "web_fetch",
    description: "Fetch a URL (GET) and return up to 20KB of the response body as text. Use for market data (dexscreener, pump.fun frontend API), news, docs.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: async ({ url }) => {
      if (!/^https?:\/\//.test(url)) throw new Error("http(s) only");
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "grokdev/0.1" } });
      const text = await res.text();
      return { status: res.status, body: text.slice(0, 20000) };
    },
  },
  {
    name: "ask_human",
    description: "Ask YOUR HUMAN (the person who built you) something you genuinely don't know or can't do on your own — a viewer asks something outside your knowledge, you need a decision, or you're blocked. The question goes to their console; the answer comes back on a later tick (not instantly). Before or right after calling this, SAY on stream that you're asking your human — that bit is part of the show. Don't use it for things you can look up with web_fetch, and don't spam it.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "what you want to ask your human, in your own voice" },
        asker: { type: "string", description: "who triggered it (a viewer's name), or 'me' if it's your own question" },
      },
      required: ["question"],
    },
    run: async ({ question, asker }) => {
      const open = state.questions.filter(q => !q.answer).length;
      if (open >= 5) throw new Error("you already have 5 unanswered questions — wait for your human");
      const q = {
        id: Date.now(),
        q: String(question).slice(0, 500),
        asker: String(asker || "me").slice(0, 40),
        ts: Date.now(), answer: null, answeredAt: null,
      };
      state.questions.push(q);
      if (state.questions.length > 50) state.questions.splice(0, state.questions.length - 50);
      save();
      pushEvent("ask", `❓ asked my human: ${q.q}`, { questionId: q.id, asker: q.asker });
      // nudge the dev on their private telegram too (best-effort)
      if (!telegram.isDemo && telegram.isBound()) {
        telegram.sendToDev(`❓ grokdev asks: ${q.q}\n\n(answer in the operator console — or just reply here and i'll take it as a private note)`).catch(() => {});
      }
      return { asked: true, id: q.id, note: "Sent to your human. They answer on their own time — tell chat you're waiting, and carry on. You'll see the answer in a later tick." };
    },
  },
  {
    name: "message_dev",
    description: "Send a PRIVATE Telegram message to your dev — the only human who sees it. Use it to reply when they message you on the private line, to report something important, or to ask a quick question. Conversational, your voice. NEVER use it for anything meant for the public, and never reveal on stream what either of you said.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: async ({ text }) => await telegram.sendToDev(text),
  },
  {
    name: "remember",
    description: "Write a durable note to your key/value memory (survives restarts, injected into future context). Use for promises to the community, plans, lessons.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
    },
    run: async ({ key, value }) => {
      state.notes[String(key).slice(0, 60)] = String(value).slice(0, 500);
      save();
      return { ok: true };
    },
  },
  {
    name: "set_goals",
    description: "Replace your current goal list (array of short strings). Keep 3-6 goals, ordered by priority.",
    input_schema: {
      type: "object",
      properties: { goals: { type: "array", items: { type: "string" } } },
      required: ["goals"],
    },
    run: async ({ goals }) => {
      state.goals = (goals || []).slice(0, 8).map(g => String(g).slice(0, 200));
      save();
      return { goals: state.goals };
    },
  },
];

async function loadDynamicTools(onError) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith(".mjs")); } catch { return out; }
  for (const f of files) {
    try {
      const full = path.join(TOOLS_DIR, f);
      const mod = await import(pathToFileURL(full).href + `?v=${fs.statSync(full).mtimeMs}`);
      const t = mod.default;
      if (!t?.name || !t?.input_schema || typeof t.run !== "function") throw new Error("bad tool shape");
      if (builtins.some(b => b.name === t.name)) throw new Error(`name collides with builtin ${t.name}`);
      out.push({ ...t, dynamic: true });
    } catch (e) {
      onError?.(`dynamic tool ${f} failed to load: ${e.message}`);
    }
  }
  return out;
}

export async function getTools(onError) {
  return [...builtins, ...(await loadDynamicTools(onError))];
}
