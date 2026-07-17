// Recover SOL→GOLD purchases that were charged on-chain but never credited
// (the old check-too-early race). Scans the treasury's inbound transfers and,
// with --commit <walletPubkey>, credits that wallet's un-credited purchases —
// idempotent via the same sol_purchases dedup the live path uses.
//
//   npm run chain:reconcile                              # dry-run: list senders
//   npm run chain:reconcile -- --commit <yourWalletPubkey>   # credit that wallet
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { Ledger } from '../src/ledger.js';
import { SolOnramp, extractTransfers, goldForLamports, MIN_LAMPORTS } from '../src/chain/onramp.js';
import { loadChainConfig } from '../src/chain/config.js';

async function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--commit');
  const commitWallet = ci >= 0 ? args[ci + 1] : null;

  const env = loadChainConfig();
  const cfg = JSON.parse(fs.readFileSync(path.join(env.chainDir, 'config.json'), 'utf8'));
  const treasury: string = cfg.operator;
  const dbPath = process.env.SKYHARBOUR_DB
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skyharbour.db');

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 8000');
  const ledger = new Ledger(db);
  const conn = new Connection(env.rpc, 'confirmed');
  const onramp = new SolOnramp(db, ledger, treasury, (sig) =>
    conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }));

  console.log(`treasury  ${treasury}`);
  console.log(`rpc       ${env.rpc}`);
  console.log(`db        ${dbPath}`);
  console.log(commitWallet ? `mode      COMMIT for ${commitWallet}` : 'mode      DRY-RUN');

  const sigs = (await conn.getSignaturesForAddress(new PublicKey(treasury), { limit: 1000 })).reverse(); // oldest first
  console.log(`scanning  ${sigs.length} treasury signatures…\n`);

  const seen: Record<string, { count: number; lamports: number }> = {};
  const credited: { signature: string; wallet: string; gold: number }[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // The public devnet RPC 429s hard on getParsedTransaction. Fetch one at a
  // time, spaced out, and back off on 429.
  const is429 = (e: any) => e?.code === 429 || /429|Too Many/i.test(String(e?.message));
  async function getParsed(sig: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      } catch (e) {
        if (is429(e) && attempt < 6) { await sleep(4000 * (attempt + 1)); continue; }
        throw e;
      }
    }
  }

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    if (s.err) continue;
    const parsed = await getParsed(s.signature);
    const inbound = extractTransfers(parsed).filter((t) => t.destination === treasury && t.lamports >= MIN_LAMPORTS);
    for (const t of inbound) {
      const e = (seen[t.source] ??= { count: 0, lamports: 0 });
      e.count++; e.lamports += t.lamports;
    }
    if (commitWallet) {
      const r = onramp.creditFromParsed(s.signature, parsed, commitWallet);
      if (r) {
        credited.push(r);
        console.log(`  + ${String(r.gold).padStart(4)} GOLD  ${r.signature.slice(0, 16)}…`);
      }
    }
    process.stdout.write(`\r  fetched ${i + 1}/${sigs.length}`);
    if (i + 1 < sigs.length) await sleep(1400);
  }
  process.stdout.write('\n');

  console.log('\ninbound senders (≥0.01 SOL) to the treasury:');
  for (const [w, v] of Object.entries(seen)) {
    console.log(`  ${w}  —  ${v.count} transfer(s), ${(v.lamports / 1e9).toFixed(3)} SOL  (=${goldForLamports(v.lamports)} GOLD)`);
  }

  if (commitWallet) {
    const total = credited.reduce((s, c) => s + c.gold, 0);
    console.log(`\ncredited ${credited.length} purchase(s), ${total} GOLD total to ${commitWallet}`);
    if (credited.length === 0) console.log('(nothing new to credit — already reconciled, or no matching transfers)');
  } else {
    console.log('\ndry-run only — re-run with:  npm run chain:reconcile -- --commit <yourWalletPubkey>');
  }
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
