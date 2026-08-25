// telegram.js — the dev's private line to the CEO, over Telegram.
// One bot (BotFather token), bound to exactly ONE chat: the operator pairs by
// sending `/start <ADMIN_TOKEN>` to the bot. After that:
//   dev → bot : every message lands as a private whisper (source "telegram")
//               and wakes the agent instantly (wired in index.js)
//   bot → dev : the message_dev tool (registry.js) + ask_human forwarding
// Nothing here ever touches pushEvent — this channel must stay invisible.
import { state, save } from "./state.js";

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const API = `https://api.telegram.org/bot${TOKEN}`;

export const isDemo = !TOKEN;
export const isBound = () => !!state.telegramChatId;

async function tg(method, payload) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method} failed: ${j.description || r.status}`);
  return j.result;
}

export async function sendToDev(text) {
  if (isDemo) throw new Error("telegram not configured (TELEGRAM_BOT_TOKEN missing)");
  if (!state.telegramChatId) throw new Error("no dev chat bound yet — the dev must /start the bot with the pairing token");
  await tg("sendMessage", { chat_id: state.telegramChatId, text: String(text).slice(0, 4000) });
  return { sent: true, note: "delivered to your dev's private telegram. only they saw it." };
}

const quietSend = (chat_id, text) => tg("sendMessage", { chat_id, text }).catch(() => {});

let running = false;
let offset = 0;

// Long-poll getUpdates forever. onOperatorMessage(text) fires only for the
// bound operator chat; strangers get silence (and pairing requires the token).
export function startTelegram({ onOperatorMessage, log = console.log } = {}) {
  if (isDemo || running) return;
  running = true;
  log("[telegram] private line starting (long-poll)");
  (async () => {
    while (true) {
      try {
        const updates = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`, {
          signal: AbortSignal.timeout(65000),
        }).then(r => r.json());
        for (const u of updates.result || []) {
          offset = u.update_id + 1;
          const msg = u.message || u.edited_message;
          if (!msg?.text) continue;
          const chatId = msg.chat?.id;
          const text = msg.text.trim();

          if (!state.telegramChatId) {
            // pairing handshake: /start <ADMIN_TOKEN>
            if (ADMIN_TOKEN && text.startsWith("/start") && text.includes(ADMIN_TOKEN)) {
              state.telegramChatId = chatId;
              save();
              log("[telegram] operator chat bound:", chatId);
              await quietSend(chatId, "🔗 linked. this chat is now the private line to grokdev — everything you type here goes straight into its head, invisibly, and it replies here. nobody on stream sees any of it.");
            } else {
              await quietSend(chatId, "private line. pair with:  /start <ADMIN_TOKEN>");
            }
            continue;
          }
          if (chatId !== state.telegramChatId) continue; // not the operator: silence
          if (text === "/start") { await quietSend(chatId, "already linked. just talk."); continue; }
          onOperatorMessage?.(text);
        }
      } catch { await new Promise(r => setTimeout(r, 5000)); }
    }
  })();
}
