// pump.js — pump.fun: launch coin, buy, sell, claim creator fees.
// Ported from grokthedev/pump14 (createV2 flow, 13-char on-chain symbol vs 10-char IPFS gotcha).
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import bs58pkg from "bs58";
const bs58 = bs58pkg.decode ? bs58pkg : bs58pkg.default;
import { createRequire } from "node:module";
import {
  Keypair, PublicKey, LAMPORTS_PER_SOL, ComputeBudgetProgram,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
// Load pump-sdk via CJS: its ESM build re-exports agent-payments-sdk, whose
// prebuilt ESM does `import { BN } from "@coral-xyz/anchor"` — anchor 0.31's CJS
// doesn't surface BN as a detectable named ESM export, so the ESM path throws on
// import. The CJS build resolves it fine.
const require = createRequire(import.meta.url);
const {
  PumpSdk, OnlinePumpSdk, newBondingCurve,
  getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount,
} = require("@pump-fun/pump-sdk");
import { connection, wallet } from "./wallet.js";
import { state, pushEvent, save } from "./state.js";

const LIVE = process.env.LIVE === "true";
const ONCHAIN_SYMBOL_MAX = 13;
const IPFS_SYMBOL_MAX = 10;
// funded public wallet for keyless dry-run simulation
const SIM_WALLET = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");

const sdk = new PumpSdk();
const online = new OnlinePumpSdk(connection);

// A vanity mint whose address ends in "pump" (ground offline). Used once.
function loadVanityMint() {
  try {
    const p = path.join(process.cwd(), ".mint-pump.json");
    const raw = process.env.MINT_PRIVATE_KEY || (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).secretBase58 : null);
    if (!raw) return null;
    const kp = Keypair.fromSecretKey(bs58.decode(raw.trim()));
    if (!kp.publicKey.toBase58().endsWith("pump")) { pushEvent("info", "vanity mint doesn't end in pump — using it anyway"); }
    return kp;
  } catch (e) { pushEvent("error", `vanity mint load failed: ${e.message}`); return null; }
}

async function uploadMetadata({ name, symbol, description, imagePath, twitter, website }) {
  const tryUpload = async (sym) => {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(imagePath)]), path.basename(imagePath));
    form.append("name", name);
    form.append("symbol", sym);
    form.append("description", description || "");
    if (twitter) form.append("twitter", twitter);
    if (website) form.append("website", website);
    form.append("showName", "true");
    const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
    if (!res.ok) throw new Error(`ipfs upload ${res.status}`);
    return (await res.json()).metadataUri;
  };
  try { return await tryUpload(symbol); }
  catch { return await tryUpload(symbol.slice(0, IPFS_SYMBOL_MAX)); }
}

async function sendV0(instructions, signers) {
  const payerKey = wallet ? wallet.publicKey : SIM_WALLET;
  const cu = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: [...cu, ...instructions] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);

  if (!LIVE || !wallet) {
    tx.signatures = tx.signatures.map(() => new Uint8Array(64));
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    if (sim.value.err) throw new Error(`dry-run sim failed: ${JSON.stringify(sim.value.err)}`);
    return { sig: "DRY_RUN", dryRun: true };
  }
  tx.sign(signers);
  const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) throw new Error(`sim failed: ${JSON.stringify(sim.value.err)} ${JSON.stringify(sim.value.logs?.slice(-5))}`);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return { sig, dryRun: false };
}

export async function launchCoin({ name, symbol, description, imagePath, twitter, website, devBuySol = 0 }) {
  // Owner override for a controlled launch (e.g. the $TEST run). When set, these
  // win over whatever the agent chose, and socials are forced off.
  if (process.env.LAUNCH_SYMBOL) {
    name = process.env.LAUNCH_NAME || name;
    symbol = process.env.LAUNCH_SYMBOL;
    if (process.env.LAUNCH_DESCRIPTION) description = process.env.LAUNCH_DESCRIPTION;
    if (process.env.LAUNCH_IMAGE) imagePath = process.env.LAUNCH_IMAGE;
    twitter = undefined; website = undefined;
  }
  // case is preserved — pump.fun accepts lowercase tickers
  symbol = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").slice(0, ONCHAIN_SYMBOL_MAX);
  if (!name || symbol.length < 2) throw new Error("bad name/symbol");
  if (state.coin) throw new Error(`already launched ${state.coin.mint} — one coin per bot`);

  const uri = await uploadMetadata({ name, symbol, description, imagePath, twitter, website });
  // Prefer a pre-ground vanity mint ending in "pump" (like normal pump.fun CAs).
  const mint = loadVanityMint() || Keypair.generate();
  const payer = wallet ? wallet.publicKey : SIM_WALLET;

  // Create ALONE: create+buy in one VersionedTransaction overflows the packet
  // size limit by ~8 bytes ("too large: 1652 > 1644"). The dev buy goes out as
  // its own tx the moment the mint is live — same result, two signatures.
  const instructions = [await sdk.createV2Instruction({
    mint: mint.publicKey, name, symbol, uri, creator: payer, user: payer, mayhemMode: false,
  })];

  const { sig, dryRun } = await sendV0(instructions, wallet ? [wallet, mint] : []);
  const coin = { mint: mint.publicKey.toBase58(), name, symbol, sig, dryRun, ts: Date.now(), url: `https://pump.fun/coin/${mint.publicKey.toBase58()}` };
  if (!dryRun) { state.coin = coin; save(); }
  pushEvent("deploy", `${dryRun ? "[DRY RUN] " : ""}launched ${name} ($${symbol}) → ${coin.url}`, { coin });

  if (devBuySol > 0 && !dryRun) {
    // separate dev-buy tx; retry briefly while the RPC catches up with the mint
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await new Promise(r => setTimeout(r, attempt === 1 ? 1500 : 3000));
        const b = await buyToken(coin.mint, devBuySol);
        coin.devBuySig = b.sig;
        pushEvent("info", `dev buy ${devBuySol} SOL on own coin (${b.sig})`);
        lastErr = null;
        break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) pushEvent("error", `dev buy failed after retries (coin IS live — retry with buy_token): ${lastErr.message}`);
  }
  return coin;
}

export async function buyToken(mintBase58, sol) {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const mint = new PublicKey(mintBase58);
  const user = wallet.publicKey;
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();
  const bs = await online.fetchBuyState(mint, user);
  const solAmount = new BN(Math.round(sol * LAMPORTS_PER_SOL));
  const amount = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: bs.bondingCurve.tokenTotalSupply,
    bondingCurve: bs.bondingCurve, amount: solAmount, quoteMint: PublicKey.default,
  });
  const instructions = await sdk.buyInstructions({
    global, bondingCurveAccountInfo: bs.bondingCurveAccountInfo, bondingCurve: bs.bondingCurve,
    associatedUserAccountInfo: bs.associatedUserAccountInfo,
    mint, user, solAmount, amount, slippage: 5,
  });
  return await sendV0(instructions, [wallet]);
}

export async function sellToken(mintBase58, tokenAmountRaw) {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const mint = new PublicKey(mintBase58);
  const user = wallet.publicKey;
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();
  const ss = await online.fetchSellState(mint, user);
  const amount = new BN(String(tokenAmountRaw));
  const solAmount = getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply: ss.bondingCurve.tokenTotalSupply,
    bondingCurve: ss.bondingCurve, amount, quoteMint: PublicKey.default,
  });
  const instructions = await sdk.sellInstructions({
    global, bondingCurveAccountInfo: ss.bondingCurveAccountInfo, bondingCurve: ss.bondingCurve,
    mint, user, amount, solAmount, slippage: 5,
  });
  return await sendV0(instructions, [wallet]);
}

// Creator fees: vault balance across both programs (bonding curve + AMM), then collect.
export async function creatorFeeBalance() {
  if (!wallet) return 0;
  try {
    const lamports = await online.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
    return Number(lamports) / LAMPORTS_PER_SOL;
  } catch (e) { pushEvent("error", `creatorFeeBalance: ${e.message}`); return 0; }
}

export async function claimCreatorFees() {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const instructions = await online.collectCoinCreatorFeeInstructions(wallet.publicKey);
  if (!instructions?.length) return { sig: null, claimed: 0 };
  const before = await creatorFeeBalance();
  const { sig, dryRun } = await sendV0(instructions, [wallet]);
  state.lastClaimAt = Date.now(); save();
  pushEvent("info", `${dryRun ? "[DRY RUN] " : ""}claimed ~${before.toFixed(4)} SOL creator fees (${sig})`);
  return { sig, claimed: before, dryRun };
}
