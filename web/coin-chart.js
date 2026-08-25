// coin-chart.js — proper candlestick chart for grokdev's coin.
// Data: DexScreener (live price/mcap) + GeckoTerminal OHLCV (1m candles).
// A brand-new coin only has candles in the minutes it actually traded, so the
// series is bucketed on a fixed interval and gaps are forward-filled with flat
// candles (what every trading chart does) — that's what makes it read as a real
// chart instead of two lonely bars. Volume histogram along the bottom.
// Demo mode (pre-launch) generates a random walk in the same candle shape.

const THEME = {
  header: "#8b99ab",
  grid: "rgba(150,180,220,.10)",
  label: "#54606f",
  up: "#3fbf85",
  down: "#e05a45",
  upFill: "rgba(63,191,133,.85)",
  downFill: "rgba(224,90,69,.85)",
  dim: "#54606f",
  cross: "#8fd0ff",
};

const fmtUsd = v => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "b" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + (+v).toFixed(2);
const fmtPrice = v => "$" + (+v).toPrecision(3);

const lastKprice = ks => (ks.length ? ks[ks.length - 1].c : 1);

// Bucket raw OHLCV into a continuous series, forward-filling empty periods.
function densify(raw, stepSec, maxBars, nowSec) {
  if (!raw.length) return [];
  const byBucket = new Map();
  for (const k of raw) byBucket.set(Math.floor(k.t / stepSec) * stepSec, k);
  const end = Math.floor(nowSec / stepSec) * stepSec;
  const start = Math.max(Math.floor(raw[0].t / stepSec) * stepSec, end - (maxBars - 1) * stepSec);
  const out = [];
  let last = raw[0].o;
  for (const k of raw) if (Math.floor(k.t / stepSec) * stepSec <= start) last = k.c;
  for (let t = start; t <= end; t += stepSec) {
    const k = byBucket.get(t);
    if (k) { out.push({ ...k, t, filled: false }); last = k.c; }
    else out.push({ t, o: last, h: last, l: last, c: last, v: 0, filled: true });
  }
  return out.slice(-maxBars);
}

export function mountCoinChart(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const getCoin = opts.getCoin || (async () => null);

  let coin = null, px = null, pairAddr = null;
  let raw = [];               // OHLCV backfill from geckoterminal (rate-limited, best-effort)
  let ownBuckets = new Map(); // candles we build ourselves from live DexScreener prices
  const STEP = 300;           // 5-minute candles
  const MAX_BARS = 32;        // 32 x 5m ≈ 2.7h — fewer, wider, cleaner

  // Our own candles are the reliable source: geckoterminal 429s easily and a
  // fresh pump.fun pool often has no OHLCV yet. Each price sample updates the
  // current minute's bucket. Persisted so an OBS/browser restart keeps history.
  const lsKey = () => `sb_candles_${coin?.mint || "none"}`;
  function loadOwn() {
    try {
      const j = JSON.parse(localStorage.getItem(lsKey()) || "[]");
      const cut = Math.floor(Date.now() / 1000) - MAX_BARS * STEP * 3;
      ownBuckets = new Map(j.filter(k => k.t > cut).map(k => [k.t, k]));
    } catch {}
  }
  function saveOwn() {
    try { localStorage.setItem(lsKey(), JSON.stringify([...ownBuckets.values()].slice(-MAX_BARS * 2))); } catch {}
  }
  function sample(price) {
    if (!(price > 0)) return;
    const t = Math.floor(Date.now() / 1000 / STEP) * STEP;
    const k = ownBuckets.get(t);
    if (!k) ownBuckets.set(t, { t, o: price, h: price, l: price, c: price, v: 0 });
    else { k.c = price; k.h = Math.max(k.h, price); k.l = Math.min(k.l, price); }
    if (ownBuckets.size > MAX_BARS * 3) ownBuckets.delete([...ownBuckets.keys()][0]);
    saveOwn();
  }
  // merge geckoterminal history with our own live buckets (ours wins on overlap)
  function merged() {
    const m = new Map();
    for (const k of raw) m.set(Math.floor(k.t / STEP) * STEP, k);
    for (const [t, k] of ownBuckets) m.set(t, { ...m.get(t), ...k, v: (m.get(t)?.v ?? 0) || k.v });
    return [...m.values()].sort((a, b) => a.t - b.t);
  }

  // ---- demo candles (pre-launch) ----
  let demo = [];
  let demoPrice = 0.0000042;
  function demoStep() {
    const o = demoPrice;
    let c = o, h = o, l = o;
    for (let i = 0; i < 5; i++) {
      c *= 1 + (Math.random() - 0.487) * 0.03;
      h = Math.max(h, c); l = Math.min(l, c);
    }
    demoPrice = c;
    demo.push({ t: Math.floor(Date.now() / 1000), o, h, l, c, v: 20 + Math.random() * 120, filled: false });
    if (demo.length > MAX_BARS) demo.shift();
  }
  for (let i = 0; i < MAX_BARS; i++) demoStep();

  async function pollMarket() {
    const had = coin?.mint;
    try { coin = (await getCoin()) || coin; } catch {}
    if (!coin?.mint) return;
    if (!had) loadOwn();
    try {
      const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + coin.mint);
      const j = await r.json();
      const pairs = (j.pairs || []).filter(p => p.chainId === "solana");
      if (!pairs.length) return;
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const p = pairs[0];
      px = {
        usd: +p.priceUsd, m5: +(p.priceChange?.m5 ?? 0), h24: +(p.priceChange?.h24 ?? 0),
        mcap: p.marketCap || p.fdv || 0,
      };
      if (!pairAddr) { pairAddr = p.pairAddress; pollOhlcv(); }
      pairAddr = p.pairAddress;
      sample(px.usd);
    } catch {}
  }
  async function pollOhlcv() {
    if (!coin?.mint) return;
    try {
      // via our backend: geckoterminal has no CORS and rate-limits per IP
      const r = await fetch(`/api/ohlcv?mint=${coin.mint}&aggregate=5`);
      if (!r.ok) throw 0;
      const j = await r.json();
      if (Array.isArray(j.candles) && j.candles.length) raw = j.candles;
    } catch {}
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const series = coin?.mint ? merged() : [];
    const live = series.length > 0;
    const sym = coin?.symbol || "GROKDEV";
    const nowSec = Math.floor(Date.now() / 1000);
    let ks = live ? densify(series, STEP, MAX_BARS, nowSec) : demo;
    if (!ks.length) ks = demo;

    const lastK = ks[ks.length - 1];
    const lastPx = live && px ? px.usd : lastK.c;
    const chg = live && px ? px.m5 : (lastK.c >= ks[0].o ? 1 : -1);

    // header
    ctx.font = "600 34px 'SF Mono', Menlo, monospace";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = THEME.header;
    ctx.fillText("$" + sym + (live ? "  5m" : " · sim"), 24, 40);
    ctx.textAlign = "right";
    ctx.fillStyle = chg >= 0 ? THEME.up : THEME.down;
    ctx.fillText(fmtPrice(lastPx), W - 24, 40);

    const top = 88, bot = H - 78, left = 158, right = W - 24;

    let lo = Math.min(...ks.map(k => k.l), lastPx);
    let hi = Math.max(...ks.map(k => k.h), lastPx);
    // flat/quiet market: keep a sane band so candles sit mid-chart, not on a hairline
    const mid = (hi + lo) / 2 || lastKprice(ks);
    const minSpan = mid * 0.02;
    if (!(hi - lo > minSpan)) { hi = mid + minSpan / 2; lo = mid - minSpan / 2; }
    const pad = (hi - lo) * 0.14; hi += pad; lo -= pad;
    const Y = v => bot - (v - lo) / (hi - lo) * (bot - top);

    // grid + price axis
    ctx.lineWidth = 1; ctx.strokeStyle = THEME.grid;
    ctx.font = "500 16px 'SF Mono', Menlo, monospace"; ctx.fillStyle = THEME.label;
    for (let i = 0; i <= 2; i++) {
      const y = top + (bot - top) * i / 2;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText((hi - (hi - lo) * i / 2).toPrecision(3), left - 10, y);
    }

    // candles
    const n = ks.length;
    const slot = (right - left) / n;
    const bw = Math.max(5, Math.min(20, slot * 0.62));
    ks.forEach((k, i) => {
      const x = left + slot * i + slot / 2;
      const up = k.c >= k.o;
      const col = up ? THEME.up : THEME.down;
      // wick (real trades only)
      if (!k.filled) {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, bw * 0.14);
        ctx.beginPath(); ctx.moveTo(x, Y(k.h)); ctx.lineTo(x, Y(k.l)); ctx.stroke();
      }
      // body (flat/filled periods render as a thin doji line)
      const yo = Y(k.o), yc = Y(k.c);
      if (k.filled) {
        // no trades this period — a continuous line reads as "price held", which
        // is true, instead of a gap that reads as broken data
        ctx.fillStyle = "rgba(120,140,165,.45)";
        ctx.fillRect(x - slot / 2, yc - 1, slot + 1, 2);
      } else {
        ctx.fillStyle = up ? THEME.upFill : THEME.downFill;
        ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(2.5, Math.abs(yc - yo)));
      }
    });

    // last-price marker line
    const ly = Y(lastPx);
    ctx.setLineDash([5, 5]); ctx.strokeStyle = THEME.cross; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(left, ly); ctx.lineTo(right, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = THEME.cross;
    ctx.fillRect(6, ly - 13, 132, 26);
    ctx.fillStyle = "#04060b"; ctx.font = "600 15px 'SF Mono', Menlo, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(fmtPrice(lastPx).slice(0, 12), 72, ly);

    // footer
    ctx.font = "500 18px 'SF Mono', Menlo, monospace"; ctx.textAlign = "left"; ctx.fillStyle = THEME.dim;
    ctx.fillText(
      live && px ? `5m ${px.m5 >= 0 ? "+" : ""}${px.m5.toFixed(1)}%   24h ${px.h24 >= 0 ? "+" : ""}${px.h24.toFixed(1)}%   mc ${fmtUsd(px.mcap)}`
                 : "practice chart — real candles at launch",
      24, H - 20);
    ctx.textAlign = "right";
    ctx.fillText(live ? "live" : "pre-launch", W - 24, H - 20);
  }

  pollMarket(); draw();
  const timers = [
    setInterval(pollMarket, 8000),
    setInterval(pollOhlcv, 45000),   // server-cached, so this is cheap
    setInterval(() => { if (!(coin?.mint)) demoStep(); draw(); }, 4000),
    setInterval(draw, 1000),
  ];
  return { stop: () => timers.forEach(clearInterval), draw };
}
