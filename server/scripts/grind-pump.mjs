// grind-pump.mjs — grind a mint keypair whose address ends in "pump" (vanity CA).
// Uses all cores via worker_threads. Writes result to server/.mint-pump.json.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);

if (isMainThread) {
  const n = Math.max(2, os.cpus().length - 2);
  const t0 = Date.now();
  let total = 0;
  console.log(`grinding "…pump" with ${n} workers`);
  const workers = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(__filename);
    workers.push(w);
    w.on("message", (m) => {
      if (m.found) {
        const out = path.join(path.dirname(__filename), "..", ".mint-pump.json");
        fs.writeFileSync(out, JSON.stringify(m.found, null, 2), { mode: 0o600 });
        console.log(`FOUND ${m.found.address} in ${((Date.now() - t0) / 1000).toFixed(0)}s (${total} tried)`);
        workers.forEach(x => x.terminate());
        process.exit(0);
      } else {
        total += m.count;
        if (total % 1_000_000 < 50_000) console.log(`${(total / 1e6).toFixed(1)}M tried, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    });
  }
} else {
  const { Keypair } = await import("@solana/web3.js");
  const bs58pkg = (await import("bs58")).default;
  const bs58 = bs58pkg.encode ? bs58pkg : bs58pkg.default;
  grind: for (;;) {
    for (let i = 0; i < 50_000; i++) {
      const kp = Keypair.generate();
      const addr = kp.publicKey.toBase58();
      if (addr.endsWith("pump")) {
        parentPort.postMessage({ found: { address: addr, secretBase58: bs58.encode(kp.secretKey) } });
        break grind;
      }
    }
    parentPort.postMessage({ count: 50_000 });
  }
}
