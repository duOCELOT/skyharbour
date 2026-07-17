# Skyharbour Chain Gateway Implementation Plan (plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Solana devnet becomes the bank: operator scripts mint the six SPL tokens and Metaplex ship/crew collections; players log in by wallet signature, the server reads their NFTs on-chain, and ledger balances claim out as real SPL tokens — with the day-one security items (airdrop gate, reserved system names, zombie-mission recovery) closed.

**Architecture:** Dual-mode server: without `SKYHARBOUR_CHAIN` env everything behaves exactly as today (dev header auth, DevFleet, 176 tests untouched); with `SKYHARBOUR_CHAIN=devnet` the same process adds signature sessions, a `ChainFleet` (sync `FleetSource` over a sqlite holdings cache refreshed at login), and a claim pipeline (`pending → minted` rows with retry). All chain I/O lives in `server/src/chain/`; scripts in `server/scripts/` are operator-run. NFT stats live in a local `registry.json` maintained by the mint scripts (mint address → stats); ownership is read on-chain via `getParsedTokenAccountsByOwner`.

**Tech Stack:** `@solana/web3.js` ^1.95 + `@solana/spl-token` ^0.4 (server runtime), `tweetnacl` ^1 + `bs58` ^5 (signature verify), `@metaplex-foundation/umi` ^0.9 + `umi-bundle-defaults` + `@metaplex-foundation/mpl-token-metadata` ^3 (scripts only).

## Global Constraints

- Dev mode (no `SKYHARBOUR_CHAIN`) must stay byte-compatible: all 176 existing tests green, `x-wallet` header auth still works. Chain features are additive.
- Env contract: `SKYHARBOUR_CHAIN` (`devnet` enables chain mode), `SKYHARBOUR_RPC` (default `https://api.devnet.solana.com`), `SKYHARBOUR_KEYPAIR` (operator keypair JSON path, mode 0600, NEVER committed), `SKYHARBOUR_CHAIN_DIR` (default `<repo>/server/chain`), `SKYHARBOUR_ADMIN_KEY` (operator key for /admin/airdrop).
- Reserved wallet names — `harbour`, `settlement`, `mint`, `burn`, `chain`, and anything starting `escrow:` — are rejected at BOTH login paths (dev + signature) with 400 `'reserved system name'`. Plan-authorized test edit: the improve-batch seal test's harbour `/balances` read is replaced by its (already present) exact `crewShares` assertion.
- Claim accounting: `wallet:<w> -amount TOKEN` → `chain +amount TOKEN` in one atomic post AT CLAIM REQUEST; a `claims` row (`pending`) is settled by the mint worker (`minted` + tx signature, or retried). Never double-mint: the worker marks `minting` before sending and only retries rows that failed before send confirmation, per the logic in Task 5.
- `server/chain/` holds `config.json` + `registry.json` (committed after bootstrap; they contain public addresses only) — the keypair itself lives OUTSIDE the repo (`~/.config/skyharbour/devnet-keypair.json` suggested).
- Key discipline (spec §7): keypair path env-pointed; scripts create it with mode 0600; nothing secret in the repo.
- All client HTML through `escapeHtml`; suite + typecheck green from `server/` before every commit; network-dependent script steps are operator-run smoke steps, unit tests always mock the connection.

---

### Task 1: Reserved names + dual-mode config skeleton

**Files:**
- Create: `server/src/chain/config.ts`
- Modify: `server/src/app.ts` (login guard), `server/test/client/loop.test.ts` (authorized seal-test edit)
- Test: `server/test/chain/config.test.ts`, `server/test/app.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export const RESERVED = ['harbour', 'settlement', 'mint', 'burn', 'chain'];`
  - `export function isReservedWallet(name: string): boolean` — true for RESERVED members (case-insensitive) or `escrow:` prefix.
  - `export interface ChainConfig { enabled: boolean; rpc: string; keypairPath?: string; chainDir: string; adminKey?: string }`
  - `export function loadChainConfig(env = process.env): ChainConfig` — `enabled: env.SKYHARBOUR_CHAIN === 'devnet'`, rpc default `https://api.devnet.solana.com`, chainDir default `path.resolve(<module dir>, '../../chain')`.
  - `/login` (dev) rejects reserved names with 400.

- [ ] **Step 1: Write the failing tests**

`server/test/chain/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { isReservedWallet, loadChainConfig } from '../../src/chain/config.js';

describe('reserved wallet names', () => {
  it('rejects the system accounts in any case', () => {
    for (const w of ['harbour', 'SETTLEMENT', 'mint', 'Burn', 'chain', 'escrow:m1']) {
      expect(isReservedWallet(w)).toBe(true);
    }
    expect(isReservedWallet('alice')).toBe(false);
    expect(isReservedWallet('harbourmaster')).toBe(false);
  });
});

describe('chain config', () => {
  it('is disabled by default and enabled by SKYHARBOUR_CHAIN=devnet', () => {
    expect(loadChainConfig({}).enabled).toBe(false);
    const c = loadChainConfig({ SKYHARBOUR_CHAIN: 'devnet', SKYHARBOUR_RPC: 'http://x', SKYHARBOUR_ADMIN_KEY: 'k' });
    expect(c.enabled).toBe(true);
    expect(c.rpc).toBe('http://x');
    expect(c.adminKey).toBe('k');
  });
  it('defaults the rpc and chainDir', () => {
    const c = loadChainConfig({ SKYHARBOUR_CHAIN: 'devnet' });
    expect(c.rpc).toBe('https://api.devnet.solana.com');
    expect(c.chainDir.endsWith('/chain')).toBe(true);
  });
});
```
Append to `server/test/app.test.ts`:
```ts
it('rejects reserved system names at dev login', async () => {
  const res = await app.inject({ method: 'POST', url: '/login', headers: { 'x-wallet': 'harbour' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/reserved/);
});
```
In `server/test/client/loop.test.ts` (authorized): remove the final harbour `/balances` read + `harbour.GOLD` assertion from the NPC-crew seal test (the exact `crewShares` assertion above it already proves the harbour wage).

- [ ] **Step 2: Verify failures** — `cd ~/skyharbour/server && npx vitest run test/chain/config.test.ts test/app.test.ts`

- [ ] **Step 3: Implement**

`server/src/chain/config.ts`:
```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESERVED = ['harbour', 'settlement', 'mint', 'burn', 'chain'];

export function isReservedWallet(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED.includes(n) || n.startsWith('escrow:');
}

export interface ChainConfig {
  enabled: boolean;
  rpc: string;
  keypairPath?: string;
  chainDir: string;
  adminKey?: string;
}

export function loadChainConfig(env: Record<string, string | undefined> = process.env): ChainConfig {
  return {
    enabled: env.SKYHARBOUR_CHAIN === 'devnet',
    rpc: env.SKYHARBOUR_RPC ?? 'https://api.devnet.solana.com',
    keypairPath: env.SKYHARBOUR_KEYPAIR,
    chainDir: env.SKYHARBOUR_CHAIN_DIR
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../chain'),
    adminKey: env.SKYHARBOUR_ADMIN_KEY,
  };
}
```
In `server/src/app.ts`: `import { isReservedWallet } from './chain/config.js';` and at the top of the `/login` handler:
```ts
    if (isReservedWallet(wallet)) throw new Error('reserved system name');
```

- [ ] **Step 4: Full suite + typecheck** — expected green (177+).

- [ ] **Step 5: Commit** — `git add server/src/chain/config.ts server/src/app.ts server/test/chain/config.test.ts server/test/app.test.ts server/test/client/loop.test.ts && git commit -m "feat(server): reserved system names + dual-mode chain config"`

---

### Task 2: Deps + operator bootstrap script (devnet assets)

**Files:**
- Modify: `server/package.json` (deps + scripts)
- Create: `server/scripts/bootstrap-devnet.ts`
- Create: `server/chain/README.md`

**Interfaces:**
- Produces: `npm run chain:bootstrap` — idempotent operator script: loads or creates the keypair at `SKYHOUR_KEYPAIR` (default `~/.config/skyharbour/devnet-keypair.json`, mode 0600), requests a devnet SOL airdrop if balance < 0.5 SOL (with 3 retries), creates the six fungible mints (decimals 0, mint authority = operator) if `config.json` lacks them, creates the two Metaplex collection NFTs ("Skyharbour Ships", "Skyharbour Crew") via umi if missing, writes `server/chain/config.json`: `{ "network": "devnet", "operator": "<pubkey>", "mints": { "GOLD": "...", "FUEL": "...", "LOG": "...", "MINERAL": "...", "FURNITURE": "...", "FIRERUNE": "..." }, "collections": { "ships": "...", "crew": "..." } }`. No unit tests (network script) — verified by the operator smoke step; keep every on-chain call wrapped in a `retry(fn, 3)` helper with 2s backoff.

- [ ] **Step 1: Install deps**

Run: `cd ~/skyharbour/server && npm install @solana/web3.js@^1.95 @solana/spl-token@^0.4 tweetnacl@^1 bs58@^5 && npm install -D @metaplex-foundation/umi@^0.9 @metaplex-foundation/umi-bundle-defaults@^0.9 @metaplex-foundation/mpl-token-metadata@^3`

Add to package.json scripts:
```json
"chain:bootstrap": "tsx scripts/bootstrap-devnet.ts",
"chain:mint-ship": "tsx scripts/mint-nft.ts ship",
"chain:mint-crew": "tsx scripts/mint-nft.ts crew"
```

- [ ] **Step 2: Write the script**

`server/scripts/bootstrap-devnet.ts`:
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner, percentAmount } from '@metaplex-foundation/umi';
import { createNft, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { loadChainConfig } from '../src/chain/config.js';

const TOKENS = ['GOLD', 'FUEL', 'LOG', 'MINERAL', 'FURNITURE', 'FIRERUNE'] as const;

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
  const keypairPath = cfg.keypairPath ?? path.join(os.homedir(), '.config/skyharbour/devnet-keypair.json');
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
```
`server/chain/README.md`: three lines — what config.json/registry.json are, that the keypair lives outside the repo, and the bootstrap/mint commands.

- [ ] **Step 3: Typecheck + suite** — `npm test && npm run typecheck` (script compiles; no runtime test).

- [ ] **Step 4: Operator smoke (network — controller/operator runs it, retries allowed):** `cd ~/skyharbour/server && npm run chain:bootstrap` → expect `bootstrap complete` and a populated `server/chain/config.json`. If devnet airdrop is rate-limited, rerun later — the script is idempotent; commit proceeds regardless with the README noting the pending bootstrap.

- [ ] **Step 5: Commit** — `git add server/package.json server/package-lock.json server/scripts/bootstrap-devnet.ts server/chain/README.md server/chain/config.json 2>/dev/null; git add server/package.json server/package-lock.json server/scripts/bootstrap-devnet.ts server/chain/README.md; git commit -m "feat(chain): devnet bootstrap — operator keypair, six mints, two collections"` (include config.json only if bootstrap ran).

---

### Task 3: Signature login (nonce → verify → session)

**Files:**
- Create: `server/src/chain/auth.ts`
- Modify: `server/src/app.ts` (routes + auth hook accepts sessions)
- Test: `server/test/chain/auth.test.ts`, `server/test/app.test.ts` (extend)

**Interfaces:**
- Produces:
  - `class ChainAuth { constructor(db: Database.Database); issueNonce(pubkey: string): string; verify(pubkey: string, signatureB64: string): string /* session token */; walletFor(session: string): string | undefined }`
  - Nonce message format (exact): `Skyharbour docking clearance: <nonce>` — the client signs this UTF-8 string. Nonces are single-use, 10-minute expiry, stored in table `auth_nonces(pubkey, nonce, created)`; sessions in `auth_sessions(token, wallet, created)`; token = 32 random bytes hex.
  - `verify` checks `tweetnacl.sign.detached.verify(message, signature, bs58.decode(pubkey))`, rejects reserved names (`isReservedWallet`), deletes the nonce, throws `Error('signature rejected')` on any failure.
  - Routes: `POST /auth/nonce {wallet}` → `{ nonce, message }` (no auth needed → add to the auth-hook bypass alongside static); `POST /auth/verify {wallet, signature}` → `{ session }` (no auth needed, same bypass).
  - Auth hook: before the dev-header check, if header `x-session` maps to a wallet via `ChainAuth.walletFor`, use it.

- [ ] **Step 1: Write the failing tests**

`server/test/chain/auth.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ChainAuth } from '../../src/chain/auth.js';

let auth: ChainAuth;
let kp: nacl.SignKeyPair;
let pub: string;
beforeEach(() => {
  auth = new ChainAuth(new Database(':memory:'));
  kp = nacl.sign.keyPair();
  pub = bs58.encode(kp.publicKey);
});

function sign(message: string) {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)).toString('base64');
}

describe('signature login', () => {
  it('verifies a signed nonce and issues a session', () => {
    const nonce = auth.issueNonce(pub);
    const session = auth.verify(pub, sign(`Skyharbour docking clearance: ${nonce}`));
    expect(auth.walletFor(session)).toBe(pub);
  });
  it('rejects a bad signature and a replayed nonce', () => {
    const nonce = auth.issueNonce(pub);
    expect(() => auth.verify(pub, sign('wrong message'))).toThrow(/rejected/);
    const good = sign(`Skyharbour docking clearance: ${nonce}`);
    expect(() => auth.verify(pub, good)).toThrow(/rejected/); // nonce consumed by the failed attempt? NO —
    // failed verify must NOT consume the nonce; adjust: after the bad attempt, the good one succeeds:
  });
  it('bad attempts do not consume the nonce; success does', () => {
    const nonce = auth.issueNonce(pub);
    expect(() => auth.verify(pub, sign('wrong'))).toThrow(/rejected/);
    const good = sign(`Skyharbour docking clearance: ${nonce}`);
    const session = auth.verify(pub, good);
    expect(auth.walletFor(session)).toBe(pub);
    expect(() => auth.verify(pub, good)).toThrow(/rejected/); // replay after success fails
  });
  it('rejects reserved names outright', () => {
    expect(() => auth.issueNonce('harbour')).toThrow(/reserved/);
  });
  it('unknown session maps to nobody', () => {
    expect(auth.walletFor('deadbeef')).toBeUndefined();
  });
});
```
(Delete the second test's trailing confusion — keep tests 1, 3, 4, 5: signed-nonce success, non-consuming failure + replay-after-success rejection, reserved rejection, unknown session.)

Append to `server/test/app.test.ts`:
```ts
it('auth hook accepts a chain session token', async () => {
  const nacl = (await import('tweetnacl')).default;
  const bs58 = (await import('bs58')).default;
  const kp = nacl.sign.keyPair();
  const pub = bs58.encode(kp.publicKey);
  const { nonce, message } = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: pub } })).json();
  expect(message).toBe(`Skyharbour docking clearance: ${nonce}`);
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)).toString('base64');
  const { session } = (await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: pub, signature } })).json();
  const res = await app.inject({ method: 'GET', url: '/balances', headers: { 'x-session': session } });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Verify failures** — vitest on the two files.

- [ ] **Step 3: Implement**

`server/src/chain/auth.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { isReservedWallet } from './config.js';

const NONCE_TTL_MS = 10 * 60 * 1000;

export class ChainAuth {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_nonces (
        pubkey TEXT PRIMARY KEY, nonce TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY, wallet TEXT NOT NULL, created INTEGER NOT NULL
      );
    `);
  }

  issueNonce(pubkey: string): string {
    if (isReservedWallet(pubkey)) throw new Error('reserved system name');
    const nonce = randomBytes(16).toString('hex');
    this.db.prepare(`
      INSERT INTO auth_nonces (pubkey, nonce, created) VALUES (?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET nonce = excluded.nonce, created = excluded.created
    `).run(pubkey, nonce, Date.now());
    return nonce;
  }

  verify(pubkey: string, signatureB64: string): string {
    if (isReservedWallet(pubkey)) throw new Error('signature rejected');
    const row = this.db.prepare('SELECT nonce, created FROM auth_nonces WHERE pubkey = ?').get(pubkey) as
      | { nonce: string; created: number } | undefined;
    if (!row || Date.now() - row.created > NONCE_TTL_MS) throw new Error('signature rejected');
    let ok = false;
    try {
      ok = nacl.sign.detached.verify(
        new TextEncoder().encode(`Skyharbour docking clearance: ${row.nonce}`),
        Uint8Array.from(Buffer.from(signatureB64, 'base64')),
        bs58.decode(pubkey),
      );
    } catch { ok = false; }
    if (!ok) throw new Error('signature rejected');
    this.db.prepare('DELETE FROM auth_nonces WHERE pubkey = ?').run(pubkey);
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_sessions (token, wallet, created) VALUES (?, ?, ?)').run(token, pubkey, Date.now());
    return token;
  }

  walletFor(session: string): string | undefined {
    const row = this.db.prepare('SELECT wallet FROM auth_sessions WHERE token = ?').get(session) as
      | { wallet: string } | undefined;
    return row?.wallet;
  }
}
```
In `server/src/app.ts`: construct `const chainAuth = new ChainAuth(db);` after the other modules; extend the auth-hook bypass condition with `req.url.startsWith('/auth/')`; before the dev-header check:
```ts
    const session = req.headers['x-session'];
    if (typeof session === 'string') {
      const w = chainAuth.walletFor(session);
      if (w) { (req as unknown as { wallet: string }).wallet = w; return; }
      return reply.code(401).send({ error: 'invalid session' });
    }
```
Routes:
```ts
  app.post('/auth/nonce', async (req) => {
    const { wallet } = req.body as { wallet: string };
    const nonce = chainAuth.issueNonce(wallet);
    return { nonce, message: `Skyharbour docking clearance: ${nonce}` };
  });
  app.post('/auth/verify', async (req) => {
    const { wallet, signature } = req.body as { wallet: string; signature: string };
    return { session: chainAuth.verify(wallet, signature) };
  });
```

- [ ] **Step 4: Full suite + typecheck** — green.

- [ ] **Step 5: Commit** — `git add server/src/chain/auth.ts server/src/app.ts server/test/chain/auth.test.ts server/test/app.test.ts && git commit -m "feat(chain): signature login — nonce, ed25519 verify, sessions"`

---

### Task 4: ChainFleet — on-chain holdings behind the FleetSource seam

**Files:**
- Create: `server/src/chain/fleet.ts`
- Modify: `server/src/app.ts` (chain mode wiring in buildApp + login refresh)
- Test: `server/test/chain/fleet.test.ts`

**Interfaces:**
- Produces:
  - Registry file shape (`server/chain/registry.json`, maintained by mint scripts): `{ "<mintAddress>": { "type": "ship", "id": "SH-001 Rustbucket", "engine": 8, "cargo": 32, "crewSlots": 3 } | { "type": "crew", "id": "CR-001 Old Stoker", "skills": { "fuel": 35 } } }`.
  - `class ChainFleet implements FleetSource { constructor(db: Database.Database, registry: Record<string, RegistryEntry>); shipsOf/crewOf/getShip/getCrew (sync, from the holdings cache joined to the registry); async refreshHoldings(wallet: string, fetchMints: (owner: string) => Promise<string[]>): Promise<void> }` — `refreshHoldings` replaces the wallet's rows in `chain_holdings(wallet, mint)` with the fetched mints that exist in the registry. Ship/crew ids are the registry `id` values; owner = the holding wallet.
  - `export async function fetchOwnedMints(connection: Connection, owner: string): Promise<string[]>` — `getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: TOKEN_PROGRAM_ID })`, keep accounts with `tokenAmount.uiAmount === 1 && decimals === 0`, return mint base58 strings.
  - `buildApp` gains `opts.chain?: { fleet: ChainFleet; fetchMints: (owner: string) => Promise<string[]> }` — when present, the fleet used by grants/market/missions is the ChainFleet, and the `/login` route awaits `chain.fleet.refreshHoldings(wallet, chain.fetchMints)` before reading ships/crew. (NPC crew: in chain mode `devFixtures()` NPC members are ALSO loaded into the ChainFleet registry-side as virtual crew owned by `harbour` — pass them in via a `virtualCrew` constructor arg so the market keeps working: `constructor(db, registry, virtualCrew: CrewMember[] = [])`.)

- [ ] **Step 1: Write the failing tests**

`server/test/chain/fleet.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChainFleet } from '../../src/chain/fleet.js';
import { NPC_CREW } from '../../src/fleet.js';

const registry = {
  MintShipA: { type: 'ship', id: 'SH-001 Rustbucket', engine: 8, cargo: 32, crewSlots: 3 },
  MintCrewB: { type: 'crew', id: 'CR-001 Old Stoker', skills: { fuel: 35 } },
  MintShipC: { type: 'ship', id: 'SH-002 Swift', engine: 18, cargo: 8, crewSlots: 1 },
} as const;

let fleet: ChainFleet;
beforeEach(() => {
  fleet = new ChainFleet(new Database(':memory:'), registry as any, NPC_CREW.map((n) => n.member));
});

describe('chain fleet', () => {
  it('is empty before refresh and populated after', async () => {
    expect(fleet.shipsOf('walletX')).toEqual([]);
    await fleet.refreshHoldings('walletX', async () => ['MintShipA', 'MintCrewB', 'UnknownMint']);
    const ships = fleet.shipsOf('walletX');
    expect(ships).toHaveLength(1);
    expect(ships[0]).toEqual({ id: 'SH-001 Rustbucket', owner: 'walletX', engine: 8, cargo: 32, crewSlots: 3 });
    expect(fleet.crewOf('walletX')[0].skills).toEqual({ fuel: 35 });
  });

  it('refresh replaces stale holdings (NFT sold)', async () => {
    await fleet.refreshHoldings('walletX', async () => ['MintShipA']);
    await fleet.refreshHoldings('walletX', async () => ['MintShipC']);
    expect(fleet.shipsOf('walletX').map((s) => s.id)).toEqual(['SH-002 Swift']);
  });

  it('getShip/getCrew resolve by registry id with the holder as owner', async () => {
    await fleet.refreshHoldings('walletX', async () => ['MintShipA']);
    expect(fleet.getShip('SH-001 Rustbucket')?.owner).toBe('walletX');
    expect(fleet.getShip('SH-002 Swift')).toBeUndefined(); // nobody holds it
  });

  it('serves the harbour NPC crew virtually', () => {
    expect(fleet.getCrew('npc-stoker')?.owner).toBe('harbour');
    expect(fleet.crewOf('harbour').length).toBeGreaterThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement**

`server/src/chain/fleet.ts`:
```ts
import type Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { FleetSource, Ship, CrewMember } from '../fleet.js';

export type RegistryEntry =
  | { type: 'ship'; id: string; engine: number; cargo: number; crewSlots: number }
  | { type: 'crew'; id: string; skills: { fuel?: number; attack?: number; defense?: number } };

export class ChainFleet implements FleetSource {
  constructor(
    private db: Database.Database,
    private registry: Record<string, RegistryEntry>,
    private virtualCrew: CrewMember[] = [],
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS chain_holdings (wallet TEXT NOT NULL, mint TEXT NOT NULL, PRIMARY KEY (wallet, mint))');
  }

  async refreshHoldings(wallet: string, fetchMints: (owner: string) => Promise<string[]>): Promise<void> {
    const mints = (await fetchMints(wallet)).filter((m) => this.registry[m]);
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chain_holdings WHERE wallet = ?').run(wallet);
      const ins = this.db.prepare('INSERT OR IGNORE INTO chain_holdings (wallet, mint) VALUES (?, ?)');
      for (const m of mints) ins.run(wallet, m);
    });
    txn();
  }

  private holdingsOf(wallet: string): RegistryEntry[] {
    const rows = this.db.prepare('SELECT mint FROM chain_holdings WHERE wallet = ?').all(wallet) as { mint: string }[];
    return rows.map((r) => this.registry[r.mint]).filter(Boolean);
  }

  shipsOf(wallet: string): Ship[] {
    return this.holdingsOf(wallet)
      .filter((e): e is Extract<RegistryEntry, { type: 'ship' }> => e.type === 'ship')
      .map((e) => ({ id: e.id, owner: wallet, engine: e.engine, cargo: e.cargo, crewSlots: e.crewSlots }));
  }

  crewOf(wallet: string): CrewMember[] {
    const own = this.holdingsOf(wallet)
      .filter((e): e is Extract<RegistryEntry, { type: 'crew' }> => e.type === 'crew')
      .map((e) => ({ id: e.id, owner: wallet, skills: e.skills }));
    return [...own, ...this.virtualCrew.filter((c) => c.owner === wallet)];
  }

  getShip(id: string): Ship | undefined {
    const row = this.db.prepare(`
      SELECT wallet, mint FROM chain_holdings
    `).all() as { wallet: string; mint: string }[];
    for (const r of row) {
      const e = this.registry[r.mint];
      if (e?.type === 'ship' && e.id === id) {
        return { id: e.id, owner: r.wallet, engine: e.engine, cargo: e.cargo, crewSlots: e.crewSlots };
      }
    }
    return undefined;
  }

  getCrew(id: string): CrewMember | undefined {
    const virtual = this.virtualCrew.find((c) => c.id === id);
    if (virtual) return virtual;
    const rows = this.db.prepare('SELECT wallet, mint FROM chain_holdings').all() as { wallet: string; mint: string }[];
    for (const r of rows) {
      const e = this.registry[r.mint];
      if (e?.type === 'crew' && e.id === id) return { id: e.id, owner: r.wallet, skills: e.skills };
    }
    return undefined;
  }
}

export async function fetchOwnedMints(connection: Connection, owner: string): Promise<string[]> {
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: TOKEN_PROGRAM_ID });
  return res.value
    .map((a) => a.account.data.parsed.info)
    .filter((i) => i.tokenAmount?.decimals === 0 && i.tokenAmount?.uiAmount === 1)
    .map((i) => i.mint as string);
}
```
In `server/src/app.ts`: `buildApp(opts: { dbPath?; staticRoot?; chain?: { fleet: import('./chain/fleet.js').ChainFleet; fetchMints: (owner: string) => Promise<string[]> } })`; `const fleet = opts.chain?.fleet ?? new DevFleet(ships, crew);` (keep devFixtures for NPC virtualCrew regardless); in `/login`, before reading ships: `if (opts.chain) await opts.chain.fleet.refreshHoldings(wallet, opts.chain.fetchMints);`

- [ ] **Step 4: Full suite + typecheck** — green (dev-mode paths untouched: `opts.chain` absent everywhere in existing tests).

- [ ] **Step 5: Commit** — `git add server/src/chain/fleet.ts server/src/app.ts server/test/chain/fleet.test.ts && git commit -m "feat(chain): ChainFleet — on-chain NFT holdings behind the FleetSource seam"`

---

### Task 5: Claims — ledger out, SPL mint with retry

**Files:**
- Create: `server/src/chain/claims.ts`
- Modify: `server/src/app.ts` (routes)
- Test: `server/test/chain/claims.test.ts`, `server/test/app.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type MintFn = (wallet: string, token: TokenId, amount: number) => Promise<string /* tx sig */>;`
  - `class Claims { constructor(db: Database.Database, ledger: Ledger); request(wallet: string, token: TokenId): { id: number; amount: number } — claims the FULL current ledger balance; throws Error('nothing to claim') on 0; atomic: ledger post wallet:<w> -amount → chain +amount PLUS the claims row insert in one db.transaction; listFor(wallet): ClaimRow[]; processPending(mint: MintFn): Promise<{ minted: number; failed: number }> }`
  - `claims` table: `id INTEGER PK, wallet, token, amount, status ('pending'|'minting'|'minted'|'failed'), sig, attempts, created, updated`. `processPending` takes each `pending` or `failed (attempts < 5)` row, sets `minting`, calls `mint`, on success `minted`+sig; on throw `failed`, attempts+1. Rows stuck in `minting` (crash mid-send) are NOT auto-retried (double-mint risk) — they surface in `listFor` for operator resolution; a `resolveStuck(id, outcome: 'minted'|'failed', sig?)` method lets the operator settle them.
  - Routes: `POST /claim { token }` → request(); `GET /claims` → caller's rows. Available in BOTH modes (dev mode simply never runs the worker — rows stay pending; harmless and testable).
  - `export function makeSplMint(connection: Connection, payer: Keypair, mints: Record<TokenId, string>): MintFn` — `mintTo` the associated token account (create idempotently via `getOrCreateAssociatedTokenAccount`).

- [ ] **Step 1: Write the failing tests**

`server/test/chain/claims.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../../src/ledger.js';
import { Claims } from '../../src/chain/claims.js';

let db: Database.Database; let ledger: Ledger; let claims: Claims;
beforeEach(() => {
  db = new Database(':memory:');
  ledger = new Ledger(db);
  claims = new Claims(db, ledger);
  ledger.post('seed', [
    { account: 'mint', token: 'GOLD', amount: -120 },
    { account: 'wallet:PubKeyX', token: 'GOLD', amount: 120 },
  ]);
});

describe('claim request', () => {
  it('moves the full balance to the chain account and files a pending row', () => {
    const r = claims.request('PubKeyX', 'GOLD');
    expect(r.amount).toBe(120);
    expect(ledger.balance('wallet:PubKeyX', 'GOLD')).toBe(0);
    expect(ledger.balance('chain', 'GOLD')).toBe(120);
    expect(claims.listFor('PubKeyX')[0].status).toBe('pending');
  });
  it('rejects empty claims', () => {
    expect(() => claims.request('PubKeyX', 'FUEL')).toThrow(/nothing to claim/);
  });
});

describe('mint worker', () => {
  it('mints pending rows and records the signature', async () => {
    claims.request('PubKeyX', 'GOLD');
    const calls: any[] = [];
    const res = await claims.processPending(async (w, t, a) => { calls.push([w, t, a]); return 'SIG1'; });
    expect(res).toEqual({ minted: 1, failed: 0 });
    expect(calls).toEqual([['PubKeyX', 'GOLD', 120]]);
    const row = claims.listFor('PubKeyX')[0];
    expect(row.status).toBe('minted');
    expect(row.sig).toBe('SIG1');
  });
  it('marks failures and retries them next round, up to 5 attempts', async () => {
    claims.request('PubKeyX', 'GOLD');
    await claims.processPending(async () => { throw new Error('rpc down'); });
    expect(claims.listFor('PubKeyX')[0].status).toBe('failed');
    const res = await claims.processPending(async () => 'SIG2');
    expect(res.minted).toBe(1);
  });
  it('never re-mints a minted row', async () => {
    claims.request('PubKeyX', 'GOLD');
    await claims.processPending(async () => 'SIG1');
    const res = await claims.processPending(async () => { throw new Error('should not be called'); });
    expect(res).toEqual({ minted: 0, failed: 0 });
  });
});
```
Append to `server/test/app.test.ts`:
```ts
it('claims over HTTP: full balance out, row visible', async () => {
  await app.inject({ method: 'POST', url: '/login', headers: asAlice });
  const res = await app.inject({ method: 'POST', url: '/claim', headers: asAlice, payload: { token: 'GOLD' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().amount).toBe(100);
  const rows = (await app.inject({ method: 'GET', url: '/claims', headers: asAlice })).json();
  expect(rows[0].status).toBe('pending');
  const bal = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json();
  expect(bal.GOLD).toBe(0);
});
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement**

`server/src/chain/claims.ts`:
```ts
import type Database from 'better-sqlite3';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Ledger } from '../ledger.js';
import { isTokenId, type TokenId } from '../tokens.js';

export type MintFn = (wallet: string, token: TokenId, amount: number) => Promise<string>;

export interface ClaimRow {
  id: number; wallet: string; token: TokenId; amount: number;
  status: 'pending' | 'minting' | 'minted' | 'failed'; sig: string | null; attempts: number;
}

export class Claims {
  constructor(private db: Database.Database, private ledger: Ledger) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL, token TEXT NOT NULL, amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', sig TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL DEFAULT (datetime('now')), updated TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  request(wallet: string, token: TokenId): { id: number; amount: number } {
    if (!isTokenId(token)) throw new Error('unknown token');
    const amount = this.ledger.balance(`wallet:${wallet}`, token);
    if (amount <= 0) throw new Error('nothing to claim');
    let id = 0;
    this.db.transaction(() => {
      this.ledger.post(`claim ${wallet} ${token}`, [
        { account: `wallet:${wallet}`, token, amount: -amount },
        { account: 'chain', token, amount },
      ]);
      const r = this.db.prepare('INSERT INTO claims (wallet, token, amount) VALUES (?, ?, ?)').run(wallet, token, amount);
      id = Number(r.lastInsertRowid);
    })();
    return { id, amount };
  }

  listFor(wallet: string): ClaimRow[] {
    return this.db.prepare('SELECT id, wallet, token, amount, status, sig, attempts FROM claims WHERE wallet = ? ORDER BY id DESC')
      .all(wallet) as ClaimRow[];
  }

  async processPending(mint: MintFn): Promise<{ minted: number; failed: number }> {
    const rows = this.db.prepare(
      "SELECT id, wallet, token, amount FROM claims WHERE status = 'pending' OR (status = 'failed' AND attempts < 5)",
    ).all() as ClaimRow[];
    let minted = 0, failed = 0;
    for (const row of rows) {
      this.db.prepare("UPDATE claims SET status = 'minting', updated = datetime('now') WHERE id = ?").run(row.id);
      try {
        const sig = await mint(row.wallet, row.token as TokenId, row.amount);
        this.db.prepare("UPDATE claims SET status = 'minted', sig = ?, updated = datetime('now') WHERE id = ?").run(sig, row.id);
        minted++;
      } catch {
        this.db.prepare("UPDATE claims SET status = 'failed', attempts = attempts + 1, updated = datetime('now') WHERE id = ?").run(row.id);
        failed++;
      }
    }
    return { minted, failed };
  }

  resolveStuck(id: number, outcome: 'minted' | 'failed', sig?: string): void {
    this.db.prepare("UPDATE claims SET status = ?, sig = COALESCE(?, sig), updated = datetime('now') WHERE id = ? AND status = 'minting'")
      .run(outcome, sig ?? null, id);
  }
}

export function makeSplMint(connection: Connection, payer: Keypair, mints: Record<string, string>): MintFn {
  return async (wallet, token, amount) => {
    const mintPk = new PublicKey(mints[token]);
    const owner = new PublicKey(wallet);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, owner);
    return mintTo(connection, payer, mintPk, ata.address, payer, amount);
  };
}
```
Routes in app.ts: `const claims = new Claims(db, ledger);` +
```ts
  app.post('/claim', async (req) => {
    const { token } = req.body as { token: TokenId };
    return claims.request(walletOf(req), token);
  });
  app.get('/claims', async (req) => claims.listFor(walletOf(req)));
```

- [ ] **Step 4: Full suite + typecheck** — green.

- [ ] **Step 5: Commit** — `git add server/src/chain/claims.ts server/src/app.ts server/test/chain/claims.test.ts server/test/app.test.ts && git commit -m "feat(chain): claims — ledger out, SPL mint worker with retry, no double-mint"`

---

### Task 6: Admin gate + chain-mode boot wiring

**Files:**
- Modify: `server/src/app.ts` (airdrop gate), `server/src/index.ts` (chain-mode assembly + claim worker interval)
- Test: `server/test/app.test.ts` (extend)

**Interfaces:**
- Produces: `buildApp` opts gains `adminKey?: string`; when set, `POST /admin/airdrop` requires header `x-admin-key === adminKey` else 403 `'operator key required'`; when unset, behavior unchanged (dev). `index.ts`: loads `loadChainConfig()`; when enabled, reads `chain/config.json` + `registry.json`, builds `Connection`, operator `Keypair`, `ChainFleet` (with `devFixtures()` NPC members as virtualCrew), passes `chain` + `adminKey` into buildApp, and runs `setInterval(() => claims.processPending(makeSplMint(...)), 15000)` — expose the Claims instance from buildApp via `app.decorate('claims', claims)` so index.ts can reach it (typed via a small module augmentation or a returned handle: simplest is `return Object.assign(app, { skyharbour: { claims } })` — pick ONE: `buildApp` returns the fastify instance with `(app as any).skyharbour = { claims }` and index.ts reads it; keep the cast localized and commented).

- [ ] **Step 1: Failing tests** — append to `server/test/app.test.ts`:
```ts
it('airdrop requires the operator key when one is configured', async () => {
  const gated = buildApp({ adminKey: 'sesame' });
  const denied = await gated.inject({ method: 'POST', url: '/admin/airdrop', headers: asAlice, payload: { wallets: ['alice'], amount: 5 } });
  expect(denied.statusCode).toBe(403);
  const ok = await gated.inject({
    method: 'POST', url: '/admin/airdrop',
    headers: { ...asAlice, 'x-admin-key': 'sesame' }, payload: { wallets: ['alice'], amount: 5 },
  });
  expect(ok.statusCode).toBe(200);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement** — in the airdrop route, first lines:
```ts
    if (opts.adminKey && req.headers['x-admin-key'] !== opts.adminKey) {
      return reply.code(403).send({ error: 'operator key required' });
    }
```
(the handler gains `reply` — adjust signature). `index.ts`:
```ts
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { loadChainConfig } from './chain/config.js';
import { ChainFleet, fetchOwnedMints } from './chain/fleet.js';
import { makeSplMint } from './chain/claims.js';
import { devFixtures } from './fleet.js';
// …existing repoRoot/buildApp imports stay…

const chainCfg = loadChainConfig();
let chainOpts;
if (chainCfg.enabled) {
  const cfg = JSON.parse(fs.readFileSync(path.join(chainCfg.chainDir, 'config.json'), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(chainCfg.chainDir, 'registry.json'), 'utf8'));
  const conn = new Connection(chainCfg.rpc, 'confirmed');
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(chainCfg.keypairPath!, 'utf8'))));
  const chainDb = undefined; // ChainFleet shares the app db — see buildApp change below
  chainOpts = { cfg, registry, conn, payer };
  console.log('chain mode: devnet, operator', payer.publicKey.toBase58());
}
```
— NOTE to implementer: `ChainFleet` needs the same sqlite handle as the app. Cleanest: `buildApp` opts.chain becomes `{ registry: Record<string, RegistryEntry>; fetchMints: (owner: string) => Promise<string[]> }` and buildApp constructs `new ChainFleet(db, registry, devFixtures().crew.filter(c => c.owner === 'harbour'))` itself (adjust Task 4's wiring accordingly if not already shaped this way — the Task 4 tests only exercise the class, so reshaping the buildApp option is free). index.ts then passes `{ registry, fetchMints: (o) => fetchOwnedMints(conn, o) }`, `adminKey: chainCfg.adminKey`, and after listen starts the worker:
```ts
const handle = (app as any).skyharbour;
if (chainCfg.enabled && handle?.claims) {
  const mint = makeSplMint(conn, payer, cfg.mints);
  setInterval(() => handle.claims.processPending(mint).catch((e: Error) => console.error('claim worker:', e.message)), 15_000);
}
```

- [ ] **Step 4: Full suite + typecheck** — green.

- [ ] **Step 5: Commit** — `git add server/src/app.ts server/src/index.ts server/test/app.test.ts && git commit -m "feat(chain): operator-gated airdrop + chain-mode boot and claim worker"`

---

### Task 7: Ghost runs — GET /missions/mine + abandon UI

**Files:**
- Modify: `server/src/missions.ts` (mine()), `server/src/app.ts` (route), `client/bridge.js`, `client/render.js` (+`client/render.d.ts`), `index.html` (missions frame mount reused)
- Test: `server/test/missions.test.ts`, `server/test/app.test.ts`, `server/test/client/render.test.ts`

**Interfaces:**
- Produces: `MissionEngine.mine(wallet: string): Mission[]` (active missions piloted by wallet); route `GET /missions/mine`; `renderGhostRuns(missions)` in render.js → for each, a line `LOG ×5 → SETTLEMENT (D148) <button class="abandon-btn" data-mission="id">ABANDON</button>`, empty string when none; bridge: after login, fetch mine → prepend into `#missions-mount`'s parent via a `#ghosts-mount` div added right above the mount in index.html; delegated abandon click → `failMission(id, 0)` → refresh board+economy. All strings escaped.

- [ ] **Step 1: Failing tests**

`server/test/missions.test.ts`:
```ts
it('mine() lists only the callers active missions', () => {
  const [m] = engine.generate(1);
  engine.accept(m.id, 'alice', 'ship-1', []);
  expect(engine.mine('alice').map((x) => x.id)).toEqual([m.id]);
  expect(engine.mine('bob')).toEqual([]);
  engine.fail(m.id);
  expect(engine.mine('alice')).toEqual([]);
});
```
`server/test/app.test.ts`:
```ts
it('GET /missions/mine returns the callers active missions', async () => {
  await app.inject({ method: 'POST', url: '/login', headers: asAlice });
  const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 } })).json();
  await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice, payload: { shipId: 'ship-1', crewIds: [] } });
  const mine = (await app.inject({ method: 'GET', url: '/missions/mine', headers: asAlice })).json();
  expect(mine.map((x: any) => x.id)).toEqual([m.id]);
});
```
`server/test/client/render.test.ts`:
```ts
it('ghost runs render abandon buttons and escape data', () => {
  const html = renderGhostRuns([{ id: 'g1', cargo: 'LOG', amount: 5, distance: 148, status: 'active' }]);
  expect(html).toContain('data-mission="g1"');
  expect(html).toContain('ABANDON');
  expect(renderGhostRuns([])).toBe('');
});
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement**

missions.ts:
```ts
  mine(wallet: string): Mission[] {
    const rows = this.db.prepare('SELECT data FROM missions').all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Mission)
      .filter((m) => m.status === 'active' && m.pilot === wallet);
  }
```
app.ts (BEFORE the `/missions/:id/...` routes or Fastify will not conflict — distinct literal path is fine):
```ts
  app.get('/missions/mine', async (req) => missions.mine(walletOf(req)));
```
render.js:
```js
export function renderGhostRuns(missions) {
  if (!missions.length) return '';
  const rows = missions.map((m) => `
    <p class="ghost-run">GHOST RUN: ${escapeHtml(m.cargo)} ×${escapeHtml(m.amount)} (D${escapeHtml(m.distance)})
      <button class="abandon-btn console-btn" data-mission="${escapeHtml(m.id)}">ABANDON</button></p>`);
  return `<div class="ghosts">${rows.join('')}</div>`;
}
```
(+ d.ts line). index.html: add `<div class="live-mount" id="ghosts-mount"></div>` directly above `#missions-mount`. bridge.js: import `renderGhostRuns` + `missionsMine = () => api('/missions/mine')` — add `export const missionsMine = () => api('/missions/mine');` to api.js (+d.ts); in doLogin's refresh block also `$('ghosts-mount').innerHTML = renderGhostRuns(await missionsMine());`; delegated click:
```js
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest?.('.abandon-btn');
  if (!btn || !session) return;
  try {
    await failMission(btn.dataset.mission, 0);
    say('GHOST RUN ABANDONED — FEE FORFEITED');
    $('ghosts-mount').innerHTML = renderGhostRuns(await missionsMine());
    await Promise.all([refreshEconomy(), refreshBoard()]);
  } catch (e) { say(String(e.message || e).toUpperCase()); }
});
```
styles.css: `.ghost-run { font-size: 0.72em; color: var(--danger); letter-spacing: 0.1em; }`

- [ ] **Step 4: Full suite + typecheck + boot smoke** (curl /app/ serves; grep ghosts-mount = 1).

- [ ] **Step 5: Commit** — `git add server/src/missions.ts server/src/app.ts client/api.js client/api.d.ts client/render.js client/render.d.ts client/bridge.js index.html styles.css server/test/missions.test.ts server/test/app.test.ts server/test/client/render.test.ts && git commit -m "feat: ghost runs — mid-flight reloads are recoverable"`

---

### Task 8: Client chain login + live claim manifest

**Files:**
- Modify: `client/api.js` (+d.ts): session store + auth calls; `client/bridge.js` (Phantom flow + claim buttons)
- Test: `server/test/client/api.test.ts` (extend)

**Interfaces:**
- Produces:
  - api.js: `getSession()/setSession(t)/clearSession()` (localStorage `sh-session`); `api()` sends `x-session` when a session exists (and then does NOT send `x-wallet`); `authNonce(wallet)`, `authVerify(wallet, signature)`, `claim(token)`, `claimsList()` wrappers.
  - bridge.js `doLogin()`: if `window.solana?.isPhantom` → `const { publicKey } = await window.solana.connect(); const pub = publicKey.toBase58();` → `authNonce(pub)` → `const sig = await window.solana.signMessage(new TextEncoder().encode(message), 'utf8');` → `authVerify(pub, btoa(String.fromCharCode(...sig.signature)))` → `setSession(session)` → proceed with `login()` as before. No Phantom → existing prompt flow. Sign-out clears session too.
  - Claim manifest: `#claim-button` becomes live — enabled when logged in; click → for each of GOLD/FUEL and nonzero cargo balances call `claim(token)`; then `say(...)` with total claimed and refresh manifest; below the button render last 3 claims from `claimsList()` (`PENDING/MINTED` + short sig) into a `#claims-mount` div added under the button in index.html.

- [ ] **Step 1: Failing tests** — extend `server/test/client/api.test.ts`:
```ts
it('prefers the session header over the dev wallet', async () => {
  setWallet('alice');
  const { setSession, clearSession, api } = await import('../../../client/api.js');
  setSession('tok123');
  (globalThis as any).fetch = vi.fn(async (_url: string, init: any) => {
    expect(init.headers['x-session']).toBe('tok123');
    expect(init.headers['x-wallet']).toBeUndefined();
    return { ok: true, json: async () => ({}) };
  });
  await api('/balances');
  clearSession();
});

it('claim wrapper posts the token', async () => {
  setWallet('alice');
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    expect(url).toBe('/claim');
    expect(JSON.parse(init.body)).toEqual({ token: 'GOLD' });
    return { ok: true, json: async () => ({ id: 1, amount: 5 }) };
  });
  const { claim } = await import('../../../client/api.js');
  expect((await claim('GOLD')).amount).toBe(5);
});
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement** per the interface block (api.js header logic: build headers as `{ ...(getSession() ? { 'x-session': getSession() } : { 'x-wallet': getWallet() ?? '' }), ... }`; bridge Phantom flow inside a try/catch that falls back to the prompt flow with `say('WALLET REFUSED — DEV DOCKING')`; index.html adds `<div id="claims-mount"></div>` after the claim button; enable the button in bridge after login (`$('claim-button').disabled = false;`) with the click handler:
```js
$('claim-button').addEventListener('click', async () => {
  if (!session) { say('DOCK IN FIRST, PILOT'); return; }
  try {
    const bal = await balances();
    const claimable = Object.entries(bal).filter(([, v]) => v > 0);
    if (!claimable.length) { say('NOTHING TO CLAIM'); return; }
    let total = 0;
    for (const [t] of claimable) { const r = await claim(t); total += r.amount; }
    say(`CLAIM FILED — ${total} TOKENS QUEUED FOR THE CHAIN`);
    const rows = (await claimsList()).slice(0, 3);
    $('claims-mount').innerHTML = rows.map((c) =>
      `<p class="manifest-line">${escapeHtml(c.token)} ${escapeHtml(c.amount)} <span class="dots"></span> <b>${escapeHtml(c.status).toUpperCase()}</b></p>`).join('');
    await refreshEconomy();
  } catch (e) { say(String(e.message || e).toUpperCase()); }
});
```
(bridge imports escapeHtml from render.js — it already may; verify.)

- [ ] **Step 4: Full suite + typecheck + boot smoke.**

- [ ] **Step 5: Commit** — `git add client/api.js client/api.d.ts client/bridge.js index.html server/test/client/api.test.ts && git commit -m "feat(client): Phantom signature docking + live claim manifest"`

---

### Task 9: NFT mint script (ships + crew into the collections)

**Files:**
- Create: `server/scripts/mint-nft.ts`
- Test: none (operator script; typecheck only)

**Interfaces:**
- Produces: `npm run chain:mint-ship -- --to <pubkey> --name "Rustbucket" --engine 8 --cargo 32 --crew 3` and `npm run chain:mint-crew -- --to <pubkey> --name "Old Stoker" --fuel 35 [--defense N --attack N]`. Creates a Metaplex NFT (`createNft`, supply 1) named `SH <name>` / `CR <name>`, `collection: { key: <ships|crew collection>, verified: false }` then `verifyCollectionV1`; transfers to `--to` if given (else stays with operator); appends `{ [mintAddress]: { type, id: '<SH|CR>-<n> <name>', ...stats } }` to `server/chain/registry.json` (id counter = current registry count of that type + 1, zero-padded 3).

- [ ] **Step 1: Write the script** (single file, argv parsing with `process.argv` — no dependency):
```ts
import fs from 'node:fs';
import path from 'node:path';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, generateSigner, percentAmount, publicKey } from '@metaplex-foundation/umi';
import { createNft, verifyCollectionV1, findMetadataPda, mplTokenMetadata, transferV1, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { loadChainConfig } from '../src/chain/config.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const kind = process.argv[2] as 'ship' | 'crew';
  if (kind !== 'ship' && kind !== 'crew') throw new Error('usage: mint-nft.ts ship|crew --name X [--to PUBKEY] [stats]');
  const cfg = loadChainConfig();
  const chain = JSON.parse(fs.readFileSync(path.join(cfg.chainDir, 'config.json'), 'utf8'));
  const regPath = path.join(cfg.chainDir, 'registry.json');
  const registry = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : {};
  const secret = JSON.parse(fs.readFileSync(cfg.keypairPath ?? `${process.env.HOME}/.config/skyharbour/devnet-keypair.json`, 'utf8'));

  const umi = createUmi(cfg.rpc).use(mplTokenMetadata());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(secret))));

  const name = arg('name') ?? 'Unnamed';
  const count = Object.values(registry).filter((e: any) => e.type === kind).length + 1;
  const id = `${kind === 'ship' ? 'SH' : 'CR'}-${String(count).padStart(3, '0')} ${name}`;
  const collection = publicKey(chain.collections[kind === 'ship' ? 'ships' : 'crew']);

  const mint = generateSigner(umi);
  await createNft(umi, {
    mint, name: id.slice(0, 32), uri: '', sellerFeeBasisPoints: percentAmount(0),
    collection: { key: collection, verified: false },
  }).sendAndConfirm(umi);
  await verifyCollectionV1(umi, {
    metadata: findMetadataPda(umi, { mint: mint.publicKey }), collectionMint: collection,
  }).sendAndConfirm(umi);

  const to = arg('to');
  if (to) {
    await transferV1(umi, {
      mint: mint.publicKey, authority: umi.identity, tokenOwner: umi.identity.publicKey,
      destinationOwner: publicKey(to), tokenStandard: TokenStandard.NonFungible,
    }).sendAndConfirm(umi);
  }

  registry[mint.publicKey.toString()] = kind === 'ship'
    ? { type: 'ship', id, engine: Number(arg('engine', '10')), cargo: Number(arg('cargo', '20')), crewSlots: Number(arg('crew', '2')) }
    : { type: 'crew', id, skills: Object.fromEntries((['fuel', 'attack', 'defense'] as const)
        .map((s) => [s, Number(arg(s, '0'))]).filter(([, v]) => (v as number) > 0)) };
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2));
  console.log('minted', id, '→', mint.publicKey.toString(), to ? `held by ${to}` : '(operator-held)');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Typecheck + suite** — green (scripts are typechecked via include; confirm tsconfig `include` covers `scripts/` — if not, add it).

- [ ] **Step 3: Operator smoke (network):** after Task 2's bootstrap succeeded, mint one test ship to the operator: `npm run chain:mint-ship -- --name Rustbucket --engine 8 --cargo 32 --crew 3` → registry.json gains one ship entry. Commit registry.json when it exists.

- [ ] **Step 4: Commit** — `git add server/scripts/mint-nft.ts server/package.json server/chain/registry.json 2>/dev/null; git add server/scripts/mint-nft.ts server/package.json; git commit -m "feat(chain): Metaplex mint script — ships and crew into the collections"`

---

### Task 10: Devnet-gated integration test + docs

**Files:**
- Create: `server/test/chain/devnet.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (§4 note: chain gateway shipped, dual-mode)
- Test: the file itself (skipped by default)

**Interfaces:** the test suite runs ONLY when `SKYHARBOUR_CHAIN_TEST=1` (CI/default runs skip it): connects to the configured RPC, asserts `chain/config.json` mints exist on-chain (`getMint`), asserts the operator balance > 0, and — if `registry.json` is non-empty — fetchOwnedMints(operator) intersects the registry. Guard shape:
```ts
const enabled = process.env.SKYHARBOUR_CHAIN_TEST === '1';
(enabled ? describe : describe.skip)('devnet integration', () => { … });
```

- [ ] **Step 1: Write it** (with `getMint` from spl-token per config mint, 30s timeout via `it('…', async () => {…}, 30_000)`).
- [ ] **Step 2: Default run stays green + typecheck.** Operator may run `SKYHOUR_CHAIN_TEST=1 npx vitest run test/chain/devnet.integration.test.ts` — correct env var name is `SKYHARBOUR_CHAIN_TEST` (fix any typo).
- [ ] **Step 3: Spec doc note** — in §4, one sentence under the chain-gateway bullet: implemented 2026-07-14 as dual-mode (`SKYHARBOUR_CHAIN=devnet`), assets via `chain:bootstrap`/`chain:mint-*`, stats in a local registry pending public metadata hosting.
- [ ] **Step 4: Commit** — `git add server/test/chain/devnet.integration.test.ts docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md && git commit -m "test(chain): devnet-gated integration seal + spec note"`

---

## Self-review notes

- Spec §2–4 coverage: signature login (T3, T8), NFT reads behind the seam (T4), claim batch-mint with retry/no-double-mint (T5, worker in T6), Metaplex collections + mints (T2, T9), key discipline (T2: 0600, outside repo), devnet-only (all). Day-1 items: airdrop gate (T6), reserved names (T1), ghost runs (T7); market-skills item was closed in the improve batch.
- Type consistency: `RegistryEntry` (T4) consumed by T9's registry writes and T6's boot; `MintFn` (T5) consumed by T6; `ChainAuth` (T3) consumed by app hook; session header contract (T3 server ↔ T8 client); `renderGhostRuns`/`missionsMine` (T7) internally consistent.
- Known risks, stated: devnet RPC flakiness (retries + idempotent scripts; operator steps may defer), Phantom `signMessage` return shape differences (bridge handles `{ signature }`), `getParsedTokenAccountsByOwner` cost at scale (fine for devnet).
- Deliberate deferrals: metadata URI hosting (registry-local for now), operator dashboards for stuck claims (`resolveStuck` exists, UI later), fuel escrow at accept (t-b817e6).
