// claim.js — pump.fun creator-fee claim, ported from cupseybank/tungbank claimer.ts
// (battle-tested in production). Raw instructions, both programs in one tx:
//  - bonding curve CollectCreatorFeeV2 (pre-bonding residue)
//  - PumpSwap AMM collect_coin_creator_fee (post-bonding fees)
// Gating is balance-based, NOT log-string based (empty bonding vault logs
// "No creator fee to collect" forever after bonding — that trap blocked AMM claims once).
import {
  PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { connection, wallet } from "./wallet.js";
import { state, save, pushEvent } from "./state.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const COLLECT_CREATOR_FEE_V2_DISC = Buffer.from("cf118af204221338", "hex");
const COLLECT_COIN_CREATOR_FEE_DISC = Buffer.from("a039592ab58b2b42", "hex");
const RENT_EXEMPT_0_BYTES = 890_880n;

const LIVE = process.env.LIVE === "true";

function pdas(creator) {
  // NOTE: hyphen vs underscore in the seeds is load-bearing.
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM);
  const [eventAuth] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM);
  const [ammVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM);
  const [ammEventAuth] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM);
  return { creatorVault, eventAuth, ammVaultAuth, ammEventAuth };
}

function buildCollectBonding(creator) {
  const { creatorVault, eventAuth } = pdas(creator);
  const creatorWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, creator);
  const vaultWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, creatorVault, true);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: creatorWsolAta, isSigner: false, isWritable: true },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: vaultWsolAta, isSigner: false, isWritable: true },
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuth, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_V2_DISC,
  });
}

function buildCollectAmm(creator) {
  const { ammVaultAuth, ammEventAuth } = pdas(creator);
  const creatorWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, creator);
  const vaultWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, ammVaultAuth, true);
  return new TransactionInstruction({
    programId: PUMP_AMM,
    keys: [
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: ammVaultAuth, isSigner: false, isWritable: false },
      { pubkey: vaultWsolAta, isSigner: false, isWritable: true },
      { pubkey: creatorWsolAta, isSigner: false, isWritable: true },
      { pubkey: ammEventAuth, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM, isSigner: false, isWritable: false },
    ],
    data: COLLECT_COIN_CREATOR_FEE_DISC,
  });
}

export async function claimableLamports() {
  if (!wallet) return { bonding: 0n, amm: 0n, totalSol: 0 };
  const { creatorVault, ammVaultAuth } = pdas(wallet.publicKey);
  let bonding = 0n, amm = 0n;
  try {
    const bal = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(WSOL_MINT, creatorVault, true));
    bonding += BigInt(bal.value.amount);
  } catch {}
  try {
    const lamports = BigInt(await connection.getBalance(creatorVault));
    if (lamports > RENT_EXEMPT_0_BYTES) bonding += lamports - RENT_EXEMPT_0_BYTES;
  } catch {}
  try {
    const bal = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(WSOL_MINT, ammVaultAuth, true));
    amm += BigInt(bal.value.amount);
  } catch {}
  return { bonding, amm, totalSol: Number(bonding + amm) / 1e9 };
}

export async function claimCreatorFees(minClaimSol = 0.0001) {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const creator = wallet.publicKey;
  const claimable = await claimableLamports();
  const total = claimable.bonding + claimable.amm;
  if (total < BigInt(Math.floor(minClaimSol * 1e9))) {
    return { claimed: false, amountSol: 0, reason: "below threshold" };
  }
  if (!LIVE) {
    pushEvent("info", `[DRY RUN] would claim ~${claimable.totalSol.toFixed(6)} SOL creator fees`);
    return { claimed: false, amountSol: claimable.totalSol, dryRun: true };
  }

  const creatorWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, creator);
  const before = BigInt(await connection.getBalance(creator, "confirmed"));

  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(creator, creatorWsolAta, creator, WSOL_MINT),
  ];
  if (claimable.bonding > 0n) instructions.push(buildCollectBonding(creator));
  if (claimable.amm > 0n) instructions.push(buildCollectAmm(creator));
  instructions.push(createCloseAccountInstruction(creatorWsolAta, creator, creator)); // unwrap WSOL → SOL

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`claim sim failed: ${JSON.stringify(sim.value.err)}`);

  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

  await new Promise(r => setTimeout(r, 2000));
  const after = BigInt(await connection.getBalance(creator, "confirmed"));
  const delta = after - before; // net of tx fee; WSOL rent cancels via CloseAccount
  const amountSol = Number(delta > 0n ? delta : 0n) / 1e9;

  state.lastClaimAt = Date.now(); save();
  pushEvent("info", `claimed ${amountSol.toFixed(6)} SOL creator fees (${sig})`);
  return { claimed: amountSol > 0, amountSol, sig };
}
