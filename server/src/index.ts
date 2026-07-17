import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair } from '@solana/web3.js';
import { buildApp } from './app.js';
import { loadChainConfig } from './chain/config.js';
import { fetchOwnedMints, type RegistryEntry } from './chain/fleet.js';
import { makeSplMint } from './chain/claims.js';
import type { Claims } from './chain/claims.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const chainCfg = loadChainConfig();

let chainOpts: { registry: Record<string, RegistryEntry>; fetchMints: (owner: string) => Promise<string[]> } | undefined;
let onrampOpts: { treasury: string; fetchTx: (sig: string) => Promise<any> } | undefined;
let claimWorker: { conn: Connection; payer: Keypair; mints: Record<string, string> } | undefined;

if (chainCfg.enabled) {
  if (!chainCfg.adminKey) {
    // Fail closed at boot rather than let /admin/airdrop's own gate be the
    // only thing standing between chain mode and an unauthenticated mint
    // spigot — a missing operator key in chain mode is a deploy misconfig,
    // not a runtime condition to limp along under.
    console.error('fatal: chain mode requires SKYHARBOUR_ADMIN_KEY');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(chainCfg.chainDir, 'config.json'), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(chainCfg.chainDir, 'registry.json'), 'utf8'));
  const conn = new Connection(chainCfg.rpc, 'confirmed');
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(chainCfg.keypairPath, 'utf8'))));
  chainOpts = { registry, fetchMints: (o) => fetchOwnedMints(conn, o) };
  // Deliberate: verify at 'confirmed' (the Connection's commitment above), not 'finalized' —
  // a devnet play-money on-ramp accepts the tiny fork-reorg risk to avoid ~13s of added latency.
  onrampOpts = { treasury: cfg.operator, fetchTx: (sig) => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }) };
  claimWorker = { conn, payer, mints: cfg.mints };
  console.log('chain mode: devnet, operator', payer.publicKey.toBase58());
}

const app = buildApp({
  dbPath: process.env.SKYHARBOUR_DB ?? 'skyharbour.db',
  staticRoot: repoRoot,
  chain: chainOpts,
  adminKey: chainCfg.adminKey,
  onramp: onrampOpts,
});
const port = Number(process.env.PORT ?? 8420);

app.listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`skyharbour bridge on http://localhost:${port}/app/`);
    if (claimWorker) {
      // Cast localized here: buildApp hangs { claims } off the instance
      // (see app.ts) rather than through a typed fastify decorator, since
      // index.ts is the only consumer of the handle.
      const handle = (app as unknown as { skyharbour: { claims: Claims } }).skyharbour;
      const mint = makeSplMint(claimWorker.conn, claimWorker.payer, claimWorker.mints);
      setInterval(() => {
        handle.claims.processPending(mint).catch((e: Error) => console.error('claim worker:', e.message));
      }, 15_000);
    }
  })
  .catch((err) => { console.error(err); process.exit(1); });
