// jupiter.js — market buy/sell any Solana token through the Jupiter aggregator.
// Ported from the tungbank/cupseybank buyback service (running in production).
//
// Why this exists: pump.fun's own SDK can only trade a coin while it sits on its
// bonding curve. Once a coin graduates to PumpSwap, those instructions fail with
// IncorrectProgramId. Jupiter routes across every venue (bonding curve, PumpSwap,
// Raydium, Meteora…), so buybacks keep working before AND after graduation.
import { PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection, wallet } from "./wallet.js";
import { pushEvent } from "./state.js";

const API = process.env.JUPITER_API_URL || "https://lite-api.jup.ag/swap/v1";
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 500); // 5%
const LIVE = process.env.LIVE === "true";

// pump.fun mints live on Token-2022; deriving an ATA with the wrong program
// silently points at an account that never receives the tokens.
const mintProgramCache = new Map();
async function getMintProgramId(mint) {
  const key = mint.toBase58();
  if (mintProgramCache.has(key)) return mintProgramCache.get(key);
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint account not found: ${key}`);
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  mintProgramCache.set(key, programId);
  return programId;
}

async function tokenBalanceRaw(ata) {
  try { return BigInt((await connection.getTokenAccountBalance(ata)).value.amount); }
  catch { return 0n; }  // ATA doesn't exist yet
}

async function quote({ inputMint, outputMint, amount }) {
  const url = `${API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`jupiter quote HTTP ${r.status}`);
  const q = await r.json();
  if (q.error) throw new Error(`jupiter quote: ${q.error}`);
  if (!q.outAmount || q.outAmount === "0") throw new Error("no route / no liquidity for this token");
  return q;
}

async function swap(quoteResponse) {
  const r = await fetch(`${API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`jupiter swap HTTP ${r.status}`);
  const s = await r.json();
  if (!s.swapTransaction) throw new Error(`jupiter swap: ${s.error || "no transaction returned"}`);

  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64"));
  tx.sign([wallet]);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`swap failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

/** Market-buy `sol` worth of `mintBase58`. Works on any venue Jupiter routes to. */
export async function buyWithSol(mintBase58, sol) {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const mint = new PublicKey(mintBase58);
  const lamports = BigInt(Math.round(sol * LAMPORTS_PER_SOL));
  if (lamports <= 0n) throw new Error("amount must be > 0");

  const programId = await getMintProgramId(mint);
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, programId);
  const q = await quote({ inputMint: WSOL.toBase58(), outputMint: mintBase58, amount: lamports.toString() });

  if (!LIVE) {
    return { dryRun: true, sol, expectedTokens: q.outAmount, route: q.routePlan?.map(r => r.swapInfo?.label).join(" → ") };
  }

  const before = await tokenBalanceRaw(ata);
  const sig = await swap(q);
  await new Promise(r => setTimeout(r, 1500));
  const after = await tokenBalanceRaw(ata);
  const boughtRaw = after - before;

  pushEvent("info", `bought ${sol} SOL of ${mintBase58.slice(0, 6)}… — sig ${sig.slice(0, 12)}…`);
  return { sig, sol, boughtRaw: boughtRaw.toString(), url: `https://solscan.io/tx/${sig}` };
}

/** Market-sell `tokenAmountRaw` base units of `mintBase58` back to SOL. */
export async function sellForSol(mintBase58, tokenAmountRaw) {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const q = await quote({ inputMint: mintBase58, outputMint: WSOL.toBase58(), amount: String(tokenAmountRaw) });
  if (!LIVE) return { dryRun: true, expectedLamports: q.outAmount };
  const sig = await swap(q);
  pushEvent("info", `sold ${tokenAmountRaw} of ${mintBase58.slice(0, 6)}… — sig ${sig.slice(0, 12)}…`);
  return { sig, url: `https://solscan.io/tx/${sig}` };
}

/** Price check without trading — how many tokens 1 SOL currently buys. */
export async function quotePrice(mintBase58) {
  const q = await quote({ inputMint: WSOL.toBase58(), outputMint: mintBase58, amount: String(LAMPORTS_PER_SOL) });
  return { tokensPerSol: q.outAmount, priceImpactPct: q.priceImpactPct, route: q.routePlan?.map(r => r.swapInfo?.label).join(" → ") };
}
