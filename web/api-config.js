// api-config.js — where the frontend finds the backend.
// grokdev ships frontend-first: with no backend deployed, every /api call fails
// silently and the page runs its built-in demo brain instead. When a Railway
// backend exists, point BACKEND at it and the real feed takes over.
//
//   BACKEND = "https://grokdevbot-production.up.railway.app"
//
const BACKEND = "";

// same-origin on localhost or when no backend override is set; otherwise the
// override only kicks in when we're NOT already on that backend host.
export const API = (() => {
  if (!BACKEND) return "";
  try { if (location.origin === BACKEND) return ""; } catch {}
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "";
  return BACKEND;
})();

// where "watch live" should send people. At coin launch, switch to the
// pump.fun livestream page; until then it's the stream scene itself (/live route
// on the backend, or /stream/hud/scene.html locally).
export const STREAM_URL = "/stream/hud/scene.html";

// the agent's X account — empty until the humans hand over the keys.
export const X_URL = "";
