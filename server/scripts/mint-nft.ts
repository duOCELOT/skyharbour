import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner, percentAmount, publicKey } from '@metaplex-foundation/umi';
import { createNft, verifyCollectionV1, findMetadataPda, mplTokenMetadata, transferV1, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { loadChainConfig } from '../src/chain/config.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/duOCELOT/skyharbour/main/nft';
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_URI_LENGTH = 200;

export interface NftAttribute {
  trait_type: string;
  value: number;
}

export interface NftMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  attributes: NftAttribute[];
}

/** lowercase, non-alphanumerics → '-', collapse repeats, trim leading/trailing '-' */
export function slugify(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** returns the lowercased extension if it's an accepted image type, else throws */
export function validateImageExtension(sourcePath: string): string {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    throw new Error(
      `unsupported image extension "${ext || '(none)'}" for ${sourcePath} — expected one of .png, .jpg, .jpeg, .webp`,
    );
  }
  return ext;
}

export function shipAttributes(engine: number, cargo: number, crewSlots: number, hull: number): NftAttribute[] {
  return [
    { trait_type: 'ENGINE', value: engine },
    { trait_type: 'CARGO', value: cargo },
    { trait_type: 'BRIDGE', value: crewSlots },
    { trait_type: 'HULL', value: hull },
  ];
}

export function crewAttributes(skills: Record<string, number>): NftAttribute[] {
  return Object.entries(skills)
    .filter(([, value]) => value > 0)
    .map(([skill, value]) => ({ trait_type: skill.toUpperCase(), value }));
}

export function imageUrl(slug: string, ext: string): string {
  return `${GITHUB_RAW_BASE}/${slug}${ext}`;
}

export function metadataUrl(slug: string): string {
  return `${GITHUB_RAW_BASE}/${slug}.json`;
}

export function buildMetadata(
  kind: 'ship' | 'crew',
  id: string,
  slug: string,
  ext: string,
  attributes: NftAttribute[],
): NftMetadata {
  return {
    name: id,
    symbol: 'SKYH',
    description: `Skyharbour ${kind} — cargo over the void.`,
    image: imageUrl(slug, ext),
    attributes,
  };
}

/** throws if the metadata uri is too long for on-chain storage */
export function assertUriLength(uri: string): void {
  if (uri.length > MAX_URI_LENGTH) {
    throw new Error(`metadata uri exceeds ${MAX_URI_LENGTH} chars (${uri.length}): ${uri}`);
  }
}

async function main() {
  const kind = process.argv[2] as 'ship' | 'crew';
  if (kind !== 'ship' && kind !== 'crew') throw new Error('usage: mint-nft.ts ship|crew --name X [--to PUBKEY] [--image PATH] [--hull N] [stats]');
  const cfg = loadChainConfig();
  const chain = JSON.parse(fs.readFileSync(path.join(cfg.chainDir, 'config.json'), 'utf8'));
  const regPath = path.join(cfg.chainDir, 'registry.json');
  const registry = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : {};
  const secret = JSON.parse(fs.readFileSync(cfg.keypairPath, 'utf8'));

  const umi = createUmi(cfg.rpc).use(mplTokenMetadata());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(secret))));

  const name = arg('name') ?? 'Unnamed';
  const count = Object.values(registry).filter((e: any) => e.type === kind).length + 1;
  const id = `${kind === 'ship' ? 'SH' : 'CR'}-${String(count).padStart(3, '0')} ${name}`;
  const collection = publicKey(chain.collections[kind === 'ship' ? 'ships' : 'crew']);

  const engine = Number(arg('engine', '10'));
  const cargo = Number(arg('cargo', '20'));
  const crewSlots = Number(arg('crew', '2'));
  const hull = Number(arg('hull', '8'));
  const skills: Record<string, number> = Object.fromEntries((['fuel', 'attack', 'defense', 'hauling'] as const)
    .map((s) => [s, Number(arg(s, '0'))]).filter(([, v]) => (v as number) > 0));

  const imagePath = arg('image');
  let uri = '';
  if (imagePath) {
    const slug = slugify(id);
    const ext = validateImageExtension(imagePath);
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const nftDir = path.join(repoRoot, 'nft');
    fs.mkdirSync(nftDir, { recursive: true });
    fs.copyFileSync(imagePath, path.join(nftDir, `${slug}${ext}`));
    const attributes = kind === 'ship' ? shipAttributes(engine, cargo, crewSlots, hull) : crewAttributes(skills);
    const metadata = buildMetadata(kind, id, slug, ext, attributes);
    fs.writeFileSync(path.join(nftDir, `${slug}.json`), JSON.stringify(metadata, null, 2));
    uri = metadataUrl(slug);
    assertUriLength(uri);
  }

  const to = arg('to');
  const mint = generateSigner(umi);
  // Mint the token directly into the recipient's wallet when --to is given
  // (createNft's tokenOwner), instead of mint-to-operator + transferV1 — the
  // separate transfer hit a Metaplex "Incorrect account owner" on devnet.
  await createNft(umi, {
    mint, name: id.slice(0, 32), uri, sellerFeeBasisPoints: percentAmount(0),
    collection: { key: collection, verified: false },
    ...(to ? { tokenOwner: publicKey(to) } : {}),
  }).sendAndConfirm(umi);
  // Collection verification is a Metaplex trust marker, not something the game
  // needs (it recognizes ships/crew from the registry + on-chain holdings). Some
  // devnet collections weren't created as sized collections, which makes Verify
  // fail with "Incorrect account owner" — don't let that block a playable mint.
  try {
    await verifyCollectionV1(umi, {
      metadata: findMetadataPda(umi, { mint: mint.publicKey }), collectionMint: collection,
    }).sendAndConfirm(umi);
  } catch (e) {
    console.warn('  collection verify skipped:', (e as Error).message.split('\n')[0]);
  }

  registry[mint.publicKey.toString()] = kind === 'ship'
    ? { type: 'ship', id, engine, cargo, crewSlots, hull }
    : { type: 'crew', id, skills };
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2));
  console.log('minted', id, '→', mint.publicKey.toString(), to ? `held by ${to}` : '(operator-held)');
  if (imagePath) {
    console.log('art will display in wallets once nft/ is pushed to GitHub');
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
