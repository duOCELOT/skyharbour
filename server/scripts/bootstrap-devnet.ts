import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner, percentAmount } from '@metaplex-foundation/umi';
import { createNft, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { loadChainConfig } from '../src/chain/config.js';

const TOKENS = ['GOLD', 'FUEL', 'AMMO', 'LOG', 'MINERAL', 'FURNITURE', 'FIRERUNE'] as const;

async function retry<T>(label: string, fn: () => Promise<T>, n = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= n) throw e;
      console.log(`${label} failed (${(e as Error).message}), retry ${i}/${n - 1}…`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function main() {
  const cfg = loadChainConfig();
  const keypairPath = cfg.keypairPath;
  fs.mkdirSync(path.dirname(keypairPath), { recursive: true });
  let keypair: Keypair;
  if (fs.existsSync(keypairPath)) {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))));
    console.log('loaded operator', keypair.publicKey.toBase58());
  } else {
    keypair = Keypair.generate();
    fs.writeFileSync(keypairPath, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
    console.log('created operator', keypair.publicKey.toBase58(), 'at', keypairPath);
  }

  const conn = new Connection(cfg.rpc, 'confirmed');
  const bal = await conn.getBalance(keypair.publicKey);
  console.log('operator balance', bal / LAMPORTS_PER_SOL, 'SOL');
  if (bal < 0.5 * LAMPORTS_PER_SOL) {
    await retry('airdrop', async () => {
      const sig = await conn.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    });
    console.log('airdropped 2 SOL');
  }

  fs.mkdirSync(cfg.chainDir, { recursive: true });
  const cfgFile = path.join(cfg.chainDir, 'config.json');
  const state = fs.existsSync(cfgFile)
    ? JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    : { network: 'devnet', operator: keypair.publicKey.toBase58(), mints: {}, collections: {} };

  for (const t of TOKENS) {
    if (state.mints[t]) continue;
    const mint = await retry(`mint ${t}`, () => createMint(conn, keypair, keypair.publicKey, null, 0));
    state.mints[t] = mint.toBase58();
    fs.writeFileSync(cfgFile, JSON.stringify(state, null, 2));
    console.log('created mint', t, state.mints[t]);
  }

  const umi = createUmi(cfg.rpc).use(mplTokenMetadata());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(keypair.secretKey)));
  for (const [key, name] of [['ships', 'Skyharbour Ships'], ['crew', 'Skyharbour Crew']] as const) {
    if (state.collections[key]) continue;
    const mint = generateSigner(umi);
    await retry(`collection ${key}`, () => createNft(umi, {
      mint, name, uri: '', sellerFeeBasisPoints: percentAmount(0), isCollection: true,
    }).sendAndConfirm(umi));
    state.collections[key] = mint.publicKey.toString();
    fs.writeFileSync(cfgFile, JSON.stringify(state, null, 2));
    console.log('created collection', key, state.collections[key]);
  }
  console.log('bootstrap complete →', cfgFile);
}

main().catch((e) => { console.error(e); process.exit(1); });
