// wallet.js — grokdev's own Solana wallet (burner). Balance, token balances, SOL transfer.
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58pkg from "bs58";
const bs58 = bs58pkg.decode ? bs58pkg : bs58pkg.default;

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
export const connection = new Connection(RPC, "confirmed");

export const wallet = (() => {
  const k = (process.env.WALLET_PRIVATE_KEY || "").trim();
  if (!k) return null;
  try { return Keypair.fromSecretKey(bs58.decode(k)); }
  catch (e) { console.error("bad WALLET_PRIVATE_KEY:", e.message); return null; }
})();

export const isDemo = !wallet;
export const address = wallet ? wallet.publicKey.toBase58() : "DEMO_WALLET_NO_KEY";

export async function solBalance() {
  if (!wallet) return 0;
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

export async function tokenBalances() {
  if (!wallet) return [];
  const out = [];
  for (const programId of [
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // Token-2022 (pump.fun ATAs gotcha)
  ]) {
    try {
      const r = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId });
      for (const { account } of r.value) {
        const info = account.data.parsed.info;
        const ui = info.tokenAmount.uiAmount;
        if (ui > 0) out.push({ mint: info.mint, amount: ui });
      }
    } catch {}
  }
  return out;
}

export async function sendSol(toBase58, sol) {
  if (!wallet) throw new Error("no wallet key configured (demo mode)");
  const ix = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(toBase58),
    lamports: Math.round(sol * LAMPORTS_PER_SOL),
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
