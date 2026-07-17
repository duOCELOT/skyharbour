import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner, percentAmount, publicKey } from '@metaplex-foundation/umi';
import { createNft, verifyCollectionV1, findMetadataPda, mplTokenMetadata, transferV1, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { loadChainConfig } from '../src/chain/config.js';
import {
  buildMetadata, slugify, metadataUrl, validateImageExtension, assertUriLength,
  shipAttributes, crewAttributes,
} from './mint-nft.js';
import type { ShipEntry, CrewEntry } from './gen-manifests.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function retry<T>(label: string, fn: () => Promise<T>, n = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= n) throw e;
      console.log(`${label} failed (${(e as Error).message}), retry ${i}/${n - 1}…`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

export interface ShipRegistryEntry {
  type: 'ship';
  id: string;
  engine: number;
  cargo: number;
  crewSlots: number;
  hull: number;
}

export interface CrewRegistryEntry {
  type: 'crew';
  id: string;
  skills: Record<string, number>;
}

/** Pure mapping from a manifest entry to the registry shape mint-batch persists. Bridge → crewSlots for ships; crew skills pass through untouched. */
export function manifestToRegistryEntry(
  kind: 'ship' | 'crew',
  entry: ShipEntry | CrewEntry,
  id: string,
): ShipRegistryEntry | CrewRegistryEntry {
  if (kind === 'ship') {
    const s = entry as ShipEntry;
    return { type: 'ship', id, engine: s.engine, cargo: s.cargo, crewSlots: s.bridge, hull: s.hull };
  }
  const c = entry as CrewEntry;
  return { type: 'crew', id, skills: c.skills as Record<string, number> };
}

/** `SH-<pos padded 3> <name>` / `CR-<pos padded 4> <name>` — pos is the manifest position (1-indexed), stable across runs. */
export function batchId(kind: 'ship' | 'crew', pos: number, name: string): string {
  return kind === 'ship'
    ? `SH-${String(pos).padStart(3, '0')} ${name}`
    : `CR-${String(pos).padStart(4, '0')} ${name}`;
}

async function main() {
  const manifestArg = arg('manifest');
  if (manifestArg !== 'ships' && manifestArg !== 'crew') {
    throw new Error('usage: mint-batch.ts --manifest ships|crew --from N --to M [--to-wallet PUBKEY]');
  }
  const kind: 'ship' | 'crew' = manifestArg === 'ships' ? 'ship' : 'crew';

  const from = Number(arg('from'));
  const to = Number(arg('to'));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error('--from/--to must form a 1-indexed inclusive range with 1 <= from <= to');
  }

  const cfg = loadChainConfig();
  const chain = JSON.parse(fs.readFileSync(path.join(cfg.chainDir, 'config.json'), 'utf8'));
  const regPath = path.join(cfg.chainDir, 'registry.json');
  const registry: Record<string, ShipRegistryEntry | CrewRegistryEntry> = fs.existsSync(regPath)
    ? JSON.parse(fs.readFileSync(regPath, 'utf8'))
    : {};
  const mintedIds = new Set(Object.values(registry).map((e) => e.id));
  const secret = JSON.parse(fs.readFileSync(cfg.keypairPath, 'utf8'));

  const manifestPath = path.join(cfg.chainDir, `manifest-${manifestArg}.json`);
  const manifest: ((ShipEntry | CrewEntry) & { image?: string })[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (to > manifest.length) {
    throw new Error(`--to ${to} exceeds manifest length ${manifest.length}`);
  }

  const umi = createUmi(cfg.rpc).use(mplTokenMetadata());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(secret))));

  const collection = publicKey(chain.collections[manifestArg]);
  const toWallet = arg('to-wallet');
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const nftDir = path.join(repoRoot, 'nft');

  for (let pos = from; pos <= to; pos++) {
    const entry = manifest[pos - 1];
    const id = batchId(kind, pos, entry.name);

    if (mintedIds.has(id)) {
      console.log('skip (already in registry)', id);
      continue;
    }

    let uri = '';
    if (entry.image) {
      const slug = slugify(id);
      const ext = validateImageExtension(entry.image);
      fs.mkdirSync(nftDir, { recursive: true });
      fs.copyFileSync(entry.image, path.join(nftDir, `${slug}${ext}`));
      const attributes = kind === 'ship'
        ? shipAttributes((entry as ShipEntry).engine, (entry as ShipEntry).cargo, (entry as ShipEntry).bridge, (entry as ShipEntry).hull)
        : crewAttributes((entry as CrewEntry).skills as Record<string, number>);
      const metadata = buildMetadata(kind, id, slug, ext, attributes);
      fs.writeFileSync(path.join(nftDir, `${slug}.json`), JSON.stringify(metadata, null, 2));
      uri = metadataUrl(slug);
      assertUriLength(uri);
    }

    try {
      const mint = generateSigner(umi);
      await retry(`mint ${id}`, () => createNft(umi, {
        mint, name: id.slice(0, 32), uri, sellerFeeBasisPoints: percentAmount(0),
        collection: { key: collection, verified: false },
      }).sendAndConfirm(umi));
      await retry(`verify ${id}`, () => verifyCollectionV1(umi, {
        metadata: findMetadataPda(umi, { mint: mint.publicKey }), collectionMint: collection,
      }).sendAndConfirm(umi));
      if (toWallet) {
        await retry(`transfer ${id}`, () => transferV1(umi, {
          mint: mint.publicKey, authority: umi.identity, tokenOwner: umi.identity.publicKey,
          destinationOwner: publicKey(toWallet), tokenStandard: TokenStandard.NonFungible,
        }).sendAndConfirm(umi));
      }

      registry[mint.publicKey.toString()] = manifestToRegistryEntry(kind, entry, id);
      fs.writeFileSync(regPath, JSON.stringify(registry, null, 2));
      mintedIds.add(id);
      console.log('minted', id, '→', mint.publicKey.toString(), toWallet ? `held by ${toWallet}` : '(operator-held)');
    } catch (e) {
      console.error(`hard failure minting ${id} (position ${pos}):`, e);
      console.error(
        `resume with: --manifest ${manifestArg} --from ${pos} --to ${to}${toWallet ? ` --to-wallet ${toWallet}` : ''}`,
      );
      process.exit(1);
    }
  }
  console.log(`batch mint complete: ${manifestArg} ${from}-${to}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
