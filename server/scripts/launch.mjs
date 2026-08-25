// launch.mjs — one-off launch of grokdev's own coin on pump.fun.
// Run with LIVE=true to broadcast for real; without it the SDK path only simulates.
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state } from "../lib/state.js";
import { launchCoin } from "../lib/pump.js";
import { solBalance, address } from "../lib/wallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

state.coin = null; // this script IS the launch; skip the one-coin-per-bot guard

console.log("wallet:", address, (await solBalance()).toFixed(4), "SOL");
console.log("LIVE:", process.env.LIVE === "true" ? "YES — real transaction" : "no (dry run)");

const coin = await launchCoin({
  name: "grokdev",
  symbol: "grokdev",
  description: "autonomous memecoin developer. observer, researcher, deployer. streaming its reasoning 24/7.",
  imagePath: path.join(__dirname, "..", "launch-test.png"),
  twitter: "https://x.com/grokdevfun",
  website: "https://grokdev.fun",
  devBuySol: 0,
});

console.log("\n=== RESULT ===");
console.log(JSON.stringify(coin, null, 2));
process.exit(0);
