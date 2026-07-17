# Skyharbour SOL On-ramp + Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buy GOLD with devnet SOL (server-verified on-chain transfer), and consolidate the BRIDGE/TOKENS/SETTLEMENT readouts into an always-on control panel beside the 9 command buttons.

**Architecture:** The SOL on-ramp is chain-mode only: the client sends a real SOL transfer to the treasury via Phantom, then POSTs the tx signature; the server fetches the parsed transaction, confirms it transferred SOL from the caller to the treasury, credits GOLD to the ledger, and records the signature so it can never be replayed. The control panel is pure client: the three readout channels leave the big display and their content (balances, settlement meter, hull) becomes a permanent cluster in the middle column.

**Tech Stack:** unchanged server; the client vendors `@solana/web3.js` browser ESM (like three.js) to build the transfer.

## Global Constraints

- Locked rate: `GOLD = Math.floor(lamports / 1_000_000)` (0.1 SOL = 10^8 lamports = 100 GOLD; 1 SOL = 1000 GOLD). Minimum purchase 0.01 SOL (10^7 lamports → 10 GOLD); reject smaller.
- The treasury is the operator pubkey (`chain/config.json` `operator`). SOL goes there.
- Anti-replay: each tx signature credited at most once (`sol_purchases(signature PRIMARY KEY)`), inserted in the same transaction as the GOLD ledger post.
- Verification (server): `connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })` must return a confirmed tx whose `meta.err` is null, containing a `system` `transfer` whose `info.source === callerWallet` and `info.destination === treasury`, summing `lamports >= 10_000_000`; credit `floor(totalLamports / 1_000_000)` GOLD to `wallet:<caller>`.
- Chain-mode only: `/gold/buy` exists always but returns 400 `'chain mode only'` when the server has no on-ramp configured (dev mode). The client BUY GOLD button is disabled unless `/login` reports `chain` + a `treasury`.
- Vendored web3 is self-contained (no CDN at runtime), served under the existing `/client/` allowlist.
- Suite + typecheck green from `server/` before every commit; escapeHtml on client HTML; dev mode byte-compatible; node --check edited client files.

---

### Task 1: SOL → GOLD verification + credit (server)

**Files:**
- Create: `server/src/chain/onramp.ts`
- Modify: `server/src/app.ts` (route + /login treasury), `server/src/index.ts` (wire the on-ramp in chain mode)
- Test: `server/test/chain/onramp.test.ts`, `server/test/app.test.ts` (dev-mode 400)

**Interfaces:**
- Produces:
  - `export const LAMPORTS_PER_GOLD = 1_000_000; export const MIN_LAMPORTS = 10_000_000;`
  - `export interface ParsedXfer { source: string; destination: string; lamports: number }`
  - `export function goldForLamports(lamports: number): number` → `Math.floor(lamports / LAMPORTS_PER_GOLD)`.
  - `export function extractTransfers(parsedTx: any): ParsedXfer[]` — pulls every `program === 'system'` `parsed.type === 'transfer'` instruction's `info` from `transaction.message.instructions` (guard missing fields → []).
  - `class SolOnramp { constructor(db, ledger, treasury: string, fetchTx: (sig: string) => Promise<any>); async redeem(wallet: string, signature: string): Promise<{ gold: number }> }` — throws `Error('purchase already credited')` if the signature is in `sol_purchases`; `Error('transfer not found or unconfirmed')` if fetchTx returns null or `meta.err`; `Error('no SOL sent to the treasury')` if no matching transfer (source===wallet, destination===treasury) sums `>= MIN_LAMPORTS`; else inserts the signature AND posts `mint −gold GOLD / wallet:<wallet> +gold GOLD` in one `db.transaction`, returns `{ gold }`.
  - app.ts: **buildApp owns db + ledger (they are constructed inside buildApp), so the onramp is wired exactly like `opts.chain`/ChainFleet: pass a config object, let buildApp construct the class.** `buildApp` opts gains `onramp?: { treasury: string; fetchTx: (sig: string) => Promise<any> }`. Inside buildApp: `const onramp = opts.onramp ? new SolOnramp(db, ledger, opts.onramp.treasury, opts.onramp.fetchTx) : null;`. Route `POST /gold/buy { signature }` → `if (!onramp) throw new Error('chain mode only'); return onramp.redeem(walletOf(req), signature);` (use the same error-shaping the other routes use). `/login` response gains `treasury: opts.onramp?.treasury ?? null`.
  - index.ts (chain mode): pass `onramp: { treasury: cfg.operator, fetchTx: (sig) => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }) }` into buildApp (mirrors how `chain: { registry, fetchMints }` is already passed). Do NOT construct SolOnramp in index.ts — it has no db/ledger handle.

- [ ] **Step 1: Failing tests**

`server/test/chain/onramp.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../../src/ledger.js';
import { SolOnramp, goldForLamports, extractTransfers } from '../../src/chain/onramp.js';

const TREASURY = 'TREASURYpubkey';
const BUYER = 'BUYERpubkey';
function txWith(lamports: number, src = BUYER, dst = TREASURY, err: unknown = null) {
  return { meta: { err }, transaction: { message: { instructions: [
    { program: 'system', parsed: { type: 'transfer', info: { source: src, destination: dst, lamports } } },
  ] } } };
}

let db: Database.Database; let ledger: Ledger;
beforeEach(() => { db = new Database(':memory:'); ledger = new Ledger(db); });

describe('rate + parsing', () => {
  it('0.1 SOL = 100 GOLD', () => { expect(goldForLamports(100_000_000)).toBe(100); expect(goldForLamports(1_000_000_000)).toBe(1000); });
  it('extractTransfers pulls system transfers', () => {
    expect(extractTransfers(txWith(5))).toEqual([{ source: BUYER, destination: TREASURY, lamports: 5 }]);
    expect(extractTransfers({})).toEqual([]);
  });
});

describe('redeem', () => {
  const ok = async () => txWith(100_000_000);
  it('credits GOLD for a valid transfer', async () => {
    const onramp = new SolOnramp(db, ledger, TREASURY, ok);
    const r = await onramp.redeem(BUYER, 'sigA');
    expect(r.gold).toBe(100);
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100);
  });
  it('rejects a replayed signature', async () => {
    const onramp = new SolOnramp(db, ledger, TREASURY, ok);
    await onramp.redeem(BUYER, 'sigA');
    await expect(onramp.redeem(BUYER, 'sigA')).rejects.toThrow(/already credited/);
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100); // not doubled
  });
  it('rejects a transfer to the wrong destination or from the wrong wallet', async () => {
    const wrongDst = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, BUYER, 'someoneElse'));
    await expect(wrongDst.redeem(BUYER, 's1')).rejects.toThrow(/no SOL sent to the treasury/);
    const wrongSrc = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, 'notBuyer', TREASURY));
    await expect(wrongSrc.redeem(BUYER, 's2')).rejects.toThrow(/no SOL sent/);
  });
  it('rejects below the minimum and unconfirmed/errored txs', async () => {
    const tiny = new SolOnramp(db, ledger, TREASURY, async () => txWith(9_999_999));
    await expect(tiny.redeem(BUYER, 's3')).rejects.toThrow(/no SOL sent/);
    const missing = new SolOnramp(db, ledger, TREASURY, async () => null);
    await expect(missing.redeem(BUYER, 's4')).rejects.toThrow(/not found or unconfirmed/);
    const failed = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, BUYER, TREASURY, 'InstructionError'));
    await expect(failed.redeem(BUYER, 's5')).rejects.toThrow(/not found or unconfirmed/);
  });
});
```
`server/test/app.test.ts`:
```ts
it('gold/buy is chain-mode only in dev', async () => {
  await app.inject({ method: 'POST', url: '/login', headers: asAlice });
  const res = await app.inject({ method: 'POST', url: '/gold/buy', headers: asAlice, payload: { signature: 'x' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/chain mode only/);
});
it('login reports a null treasury in dev', async () => {
  const r = (await app.inject({ method: 'POST', url: '/login', headers: asAlice })).json();
  expect(r.treasury).toBe(null);
});
```

- [ ] **Step 2-4:** RED → implement onramp.ts + app wiring + index.ts (chain mode) → full suite + typecheck green.
- [ ] **Step 5: Commit** — `git commit -m "feat(chain): SOL buys GOLD — verified on-chain transfer, replay-proof"`

---

### Task 2: Vendor web3 + client SOL payment + api

**Files:**
- Create: `server/scripts/vendor-web3.sh` note is optional; just copy the file. `client/vendor/solana-web3.esm.js`
- Modify: `index.html` (importmap gains `@solana/web3.js`), `client/api.js` + `.d.ts` (buyGold + solPayForGold)
- Test: `server/test/client/api.test.ts` (buyGold posts the signature)

**Interfaces:**
- Produces:
  - Vendored file copied: `cp server/node_modules/@solana/web3.js/lib/index.browser.esm.js client/vendor/solana-web3.esm.js`; importmap entry `"@solana/web3.js": "./client/vendor/solana-web3.esm.js"`.
  - api.js: `export const buyGold = (signature) => api('/gold/buy', { method: 'POST', body: { signature } });`
  - api.js: `export async function solPayForGold(rpc, treasury, wallet, lamports)` — imports `{ Connection, PublicKey, SystemProgram, Transaction }` from `@solana/web3.js`; builds a transfer from `wallet`→`treasury` for `lamports`, sets `recentBlockhash` from `new Connection(rpc).getLatestBlockhash()` and `feePayer = new PublicKey(wallet)`, calls `window.solana.signAndSendTransaction(tx)` → `{ signature }`, returns the signature. (Guard: throws `Error('no wallet')` if `!window.solana`.)

- [ ] **Step 1: Vendor + importmap + failing test**

Run: `cp ~/skyharbour/server/node_modules/@solana/web3.js/lib/index.browser.esm.js ~/skyharbour/client/vendor/solana-web3.esm.js`
importmap in index.html gains the entry.
`server/test/client/api.test.ts`:
```ts
it('buyGold posts the signature', async () => {
  setWallet('alice');
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    expect(url).toBe('/gold/buy');
    expect(JSON.parse(init.body)).toEqual({ signature: 'sigZ' });
    return { ok: true, json: async () => ({ gold: 100 }) };
  });
  const { buyGold } = await import('../../../client/api.js');
  expect((await buyGold('sigZ')).gold).toBe(100);
});
```
(solPayForGold itself is not unit-tested — it needs a live wallet/RPC; it's exercised by the operator smoke.)

- [ ] **Step 2-4:** RED → implement → full suite + typecheck; node --check api.js; boot smoke: `curl -s -o /dev/null -w '%{http_code}' localhost:PORT/app/client/vendor/solana-web3.esm.js` → 200.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): vendor web3, buy-gold api + SOL transfer helper"`

---

### Task 3: The control panel — consolidate readouts

**Files:**
- Modify: `index.html` (middle column restructure + rail drops 3 channels), `client/bridge.js` (render into the panel; drop channel-specific mounts), `client/render.js` (panel renderers), `styles.css`, `script.js` (rail no longer has the 3 slugs)
- Test: `server/test/client/render.test.ts` (panel renderers)

**Interfaces:**
- Produces:
  - `render.js` gains `renderPanel(balances, settlementState, ship)` → a compact block: GOLD/FUEL/AMMO row (tabular), a settlement build meter (reuse renderSettlement's meter math), and `HULL cur/max` for the selected ship. All escaped.
  - index.html middle column: part1 keeps art; a new `#control-panel` block replaces/augments part2 area showing `renderPanel` output, above the CRT (part3) and the 9 buttons (part4). The nav rail loses the `bridge` (home stays as BRIDGE? — keep BRIDGE the void view), `settlement`, and `tokens` build/info buttons: final rail = `1·SHIP`, `2·MISSION`, `3·CREW`, `BRIDGE`, `VOID CHART`, `STORY`. (Remove SETTLEMENT + TOKENS nav buttons; their frames may remain in the DOM unused or be deleted — delete `settlement-frame`, `tokens-frame` to keep it clean, and remove their hashchange cases.)
  - bridge.js: `refreshEconomy()` also re-renders `#control-panel` via `renderPanel(bal, settlementState, selectedShip)`; keep the ticker + manifest updates. Add BUY GOLD to the panel: a `data-cmd="buygold"` button (or reuse a console button) that, when `session.treasury` present, calls `solPayForGold(session.rpc?, session.treasury, session.wallet, 100_000_000)` then `buyGold(sig)` then refresh; when absent, `say('SOL PURCHASE NEEDS CHAIN MODE')`. (rpc: expose via /login too, or default the devnet URL client-side — simplest: `const DEVNET_RPC = 'https://api.devnet.solana.com'` in bridge.js.)

- [ ] **Step 1: Failing render test**
```ts
it('renderPanel shows balances, the build meter, and hull', () => {
  const html = renderPanel(
    { GOLD: 104, FUEL: 152, AMMO: 20, LOG: 0 },
    { stage: { index: 0, name: 'Landing Dock', needs: { LOG: 100 } }, received: { LOG: 5 }, remainingNeeds: { LOG: 95 }, completedStages: 0 },
    { id: 'ship-1', hull: 8, currentHull: 5 },
  );
  expect(html).toContain('104'); expect(html).toContain('AMMO');
  expect(html).toContain('LANDING DOCK'); expect(html).toContain('5/8');
});
```
- [ ] **Step 2-4:** RED → implement the restructure → full suite + typecheck; node --check the client files; static-verify the rail (`grep data-slug index.html` shows ship/mission/crew/bridge/voidchart/story only, no settlement/tokens) and the panel mount exists; boot smoke `/app/` 200 and served index contains `control-panel`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): control panel — balances, build meter, hull, buy-gold beside the buttons"`

---

### Task 4: Seal + docs + operator note

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (§6 SOL on-ramp source line), `server/chain/README.md` (buy-gold flow + treasury = operator)
- Test: `server/test/chain/onramp.test.ts` already seals the redeem path; add one app-level chain-mode round trip if a fake onramp can be injected via buildApp opts.

**Interfaces:** consumes everything.

- [ ] **Step 1:** app.test chain-mode redeem, using the already-locked injectable shape `onramp: { treasury, fetchTx }`: `buildApp({ onramp: { treasury: 'T', fetchTx: async () => ({ meta: { err: null }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: 'alice', destination: 'T', lamports: 100_000_000 } } }] } } }) } })`. The dev session wallet is `alice`, so the fake tx must source from `alice`. Log in as alice, POST /gold/buy `{ signature: 'sigT' }` → 200, `gold: 100`; a second POST with the same signature → error `/already credited/`.
- [ ] **Step 2:** Spec §6 sources gains "SOL on-ramp (0.1 SOL = 100 GOLD, devnet, treasury = operator)"; README documents the flow + that replay is blocked per signature.
- [ ] **Step 3:** Full suite + typecheck; commit `git commit -m "test+docs: SOL on-ramp sealed at the API; control panel + on-ramp in the spec"`.

---

## Self-review notes

- Money-path safety: GOLD only mints against a real, confirmed, treasury-bound SOL transfer FROM the authenticated wallet, credited once per signature (dedup in the same db.transaction as the ledger post). No self-reported amount — lamports come from the on-chain parsed tx.
- Type consistency: `goldForLamports`/`extractTransfers`/`SolOnramp` (T1) ← index/app wiring (T1) ← `buyGold`/`solPayForGold` (T2) ← panel buy-gold button (T3); `renderPanel(bal, settlement, ship)` (T3) consumed by refreshEconomy.
- Deferred/at-risk: `solPayForGold` (browser wallet + RPC) is operator-smoke-only, not unit-tested — the owner verifies the live buy with Phantom on devnet. Control-panel visuals need live viewing (headless screenshots are down on this box) — flag to the owner.
- Chain-mode gating keeps dev mode byte-compatible: /gold/buy 400s, the panel button is disabled, /login treasury is null.
