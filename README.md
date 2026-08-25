# grokdev — autonomous memecoin developer

observer, researcher, deployer. Full shitbot-style stack rebranded and rewired
for Grok: an obsidian 3D dev unit (Three.js), an autonomous agent backend with
a Grok (xAI) brain, and a 1280×800 stream scene for OBS / pump.fun.

## Stack

- `web/` — landing (Vercel). Black dossier page in the grokdev-woad style, but
  live: it renders the agent's real state, log feed and record, and falls back
  to a built-in simulated feed if the backend is unreachable.
- `server/` — the agent: Grok (xAI) tool-use brain with Claude fallback, Solana
  wallet, pump.fun launch/claim, X, TTS proxy, ask-my-human channel, private
  whispers + Telegram line. Deploy on Railway (+ Postgres).
- `stream/` — OBS scene at `/stream/hud/scene.html` (served by the backend):
  dark dev-terminal HUD with candle chart, dev log, attention monitor (EKG),
  unit readouts and pump.fun chat. Plus chat poller and voice scripts.

## Brain

Two providers, one loop (`server/lib/brain.js`):

- `XAI_API_KEY` set → Grok via api.x.ai (`GROK_MODEL`, default grok-4.5).
- else `ANTHROPIC_API_KEY` → Claude fallback (`MODEL`).
- neither → demo mode (everything faked, page still alive).

## Current state

- Fresh clone of the shitbot engine (v with telegram/whispers/adaptive ticks),
  rebranded grokdev. No keys wired yet — boots in full demo mode.
- Wallet / X: demo mode. `LIVE=false` — all on-chain actions dry-run.
- Operator token: `OPERATOR-TOKEN.txt` (set as `ADMIN_TOKEN` in the env).

## Local

```bash
node server/index.js
```

Serves web + stream on :8949. No keys → full demo mode.
Landing: http://localhost:8949 · Stream scene: http://localhost:8949/stream/hud/scene.html

## Launch checklist

- [ ] `XAI_API_KEY` (brain live on Grok)
- [ ] Burner `WALLET_PRIVATE_KEY` + `LIVE=true`
- [ ] Launch coin → `COIN_MINT`, `PUMP_CHAT_TOKEN`
- [ ] X keys → set `X_URL` in web/api-config.js
- [ ] Railway deploy → set `BACKEND` in web/api-config.js
- [ ] `STREAM_URL` in web/api-config.js → pump.fun livestream page
- [ ] OBS rig (`stream/run-rig.sh`) pointed at the Railway scene
