# Skyharbour v1 — Design Spec

**Date:** 2026-07-13
**Status:** approved design, pre-implementation
**Repo:** github.com/duOCELOT/skyharbour (v1 is a rethink from scratch; existing repo content is legacy)

## 1. Vision

Skyharbour is a browser dapp mini-game in **Atari Battlezone wireframe style**: green vector lines on black. The world is **floating sky-islands over the void** — there is no ground; the void below is literal emptiness. Players pilot cargo ships between island harbours and **the settlement**, a floating city that all players build collectively through their deliveries.

Everything in the game economy is a token. Ships and crew are NFTs. Fuel, money, and every cargo resource are fungible tokens.

The heart of v1 is **a playable game**. The chain is the bank, not the gameplay.

## 2. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Chain | **Solana** (devnet for all of v1) | Cheapest mass-token minting, strongest game/NFT tooling (SPL + Metaplex), Phantom wallet ubiquity. Polkadot rejected (no coherent indie-game path); Amadeus deferred (tooling unproven — its addon Phase 0 never ran). |
| Architecture | **Ledger-first (Approach A)** | Game runs on an off-chain ledger; Solana touched only at login (read), NFT reads, and claim (batch mint). No run ever waits on a blockchain. |
| Custom on-chain programs in v1 | **None** | Metaplex Certified Collections cover ships/crew; SPL token program covers all fungibles. Backend holds mint authorities. Custom Rust (e.g. trustless crew escrow) is v2+. |
| Chain coupling | **Chain-agnostic core** | All chain interaction goes through one `chain gateway` module behind a settle/read interface. An Amadeus (AMA) adapter can slot in beside the Solana adapter later. |
| Multiplayer | **Solo runs, shared settlement** | Each flight is single-player; the settlement build state, mission pool, and crew market are shared. No realtime netcode in v1. |
| Currency | **GOLD** (new SPL fungible) | Universal unit of account: mission rewards, entry fees, crew shares, fuel purchases. |
| FIRERUNE | **Rare cargo**, not currency | Delivered by rare, riskier, better-paying missions. |

## 3. On-chain asset inventory (Solana devnet)

| Asset | Type | Attributes / notes |
|---|---|---|
| Ships | Metaplex Certified Collection (NFTs) | `ENGINE` (speed), `CARGO` (capacity), `BRIDGE` (crew stations), `HULL` (armor rating). Collection-verified so fakes can't enter the hangar. |
| Crew | Metaplex Certified Collection (NFTs) | Skill set + levels: fuel management, defense, attack, hauling (each with caps). Extensible. |
| GOLD | SPL fungible | The money. |
| FUEL | SPL fungible | Burned every run — the economy's primary sink. Tradeable. |
| AMMO | SPL fungible | The trigger's cost; bought at the armory. |
| Cargo resources | One SPL mint per type: LOG, MINERAL, FURNITURE, … | Consumed by the settlement to build stages. Adding a resource type later = one new mint. |
| FIRERUNE | SPL fungible | Rare cargo tier. |

All mint authorities are held by the chain gateway. Players hold assets in their own wallets; in-game, balances live on the ledger until claimed.

## 4. Architecture

```
Browser (dapp)
├── Game client — Three.js wireframe renderer, keyboard flight,
│   fuel/cargo HUD. Client-side simulation of the run.
├── Wallet — Phantom via solana wallet-adapter. Login = sign a
│   nonce (no transaction to play).
└── Dapp UI — hangar (ships), crew market, mission board,
    settlement view, balances + claim.

Backend (one TypeScript/Node service)
├── Ledger — SQLite (v1). Append-only economic events; balances
│   are derived, never edited.
├── Mission engine — generates missions from settlement needs,
│   resolves runs server-side from posted fire events (deterministic
│   combat resolution, shipped 2026-07-15), executes atomic payouts.
├── Settlement state — global build progress: cargo received,
│   stages unlocked. Shared by all players.
└── Chain gateway — the ONLY module touching Solana:
    signature verification, NFT reads (ships/crew held),
    batch mint on claim. Behind a chain-agnostic interface.
    Implemented 2026-07-14 as dual-mode (`SKYHARBOUR_CHAIN=devnet`), assets via `chain:bootstrap`/`chain:mint-*`, stats in a local registry pending public metadata hosting.

Solana devnet
└── Assets per section 3. No custom programs.
```

## 5. Core loop

1. **Login** — connect Phantom, sign nonce. Backend reads which ship/crew NFTs the wallet holds.
2. **Hangar** — load a ship (must hold a ship NFT). Ship stats come from NFT attributes.
3. **Crew market** — crew-NFT holders list crew for hire with a share % they set. Ship owners hire up to `CREW` slots. Hiring and shares run on the ledger in v1.
4. **Mission board** — missions generated from the settlement's next build stage needs ("Stage 2 needs 500 LOG"). Each mission: cargo type + amount, origin island, GOLD reward, GOLD entry fee. FIRERUNE missions are rare/risky/lucrative. Contract amounts scale per stage: `20 + 10 × stage`.
5. **Accept** — entry fee escrowed on the ledger. FUEL balance must cover the route.
6. **The run** — pilot from origin island to the settlement over the void. ENGINE = speed, CARGO caps load, crew skills are live modifiers (fuel-management slows drain; defense softens hazard hits). Fuel drains continuously. Raiders ambush on long routes (>120u); destroy them for a 3-GOLD bounty each, or flee.
   - **Fail** (fall into the void / fuel out / destroyed): entry fee lost, fuel spent, cargo returns to the mission pool. No reward.
7. **Delivery payout** (one atomic ledger transaction): settlement receives cargo → build meter rises globally → GOLD reward paid → crew shares auto-split to crew owners → escrow released.
8. **Claim** — any time, convert ledger balances (GOLD, FUEL, resources) into real SPL tokens in the wallet, batch-minted by the chain gateway. Trade anywhere on Solana afterward.

**v1 simplification:** cargo is loaded at origin island depots. Harvesting as gameplay (landing on islands to chop/dig) is v2.

## 6. Economy flows

- **Sources:** GOLD rewards from settlement (missions); **ship-owner grant** — each wallet holding a ship NFT receives, once, 100 GOLD + 300 FUEL (3 average runs) on first hangar load; **FUEL airdrops** — operator-triggered batch credits of FUEL to active pilots (retention/event lever); **SOL on-ramp** — 0.1 SOL = 100 GOLD (GOLD = floor(lamports / 1_000_000)), devnet, treasury = the operator pubkey; verified on-chain, credited once per signature. Numbers tunable during balancing; the mechanisms are fixed.
- **Sinks:** FUEL burned per run; GOLD entry fees (kept by the settlement win or lose — they fund the **fuel pool**); fuel purchases; shells — AMMO bought at the armory and burned on confirmed raider kills; ship repair — GOLD spent at the hangar to restore hull points after raider/hazard damage.
- **Fuel pool** (owner decision 2026-07-13): entry fees accumulate in the settlement's treasury and fund the FUEL supply — players buy FUEL with GOLD from the pool, closing the loop (GOLD sink → FUEL source). Exchange rate and mechanics defined in the balancing pass.
- **Player-to-player:** crew hire shares (crew owners earn passively); post-claim trading on external Solana venues.
- **Collective:** every delivered unit advances the shared settlement; stage completions are global events all players see.

## 7. Trust and failure handling

- **Run resolution (server-authoritative, shipped 2026-07-15):** the client submits only the raw fire events it fired (`{ t, raider }` per shot) — no self-reported outcome. The server's `resolveRun` (deterministic, shared with the client, seeded off the mission id) replays the trace against the same seeded raider/rock layout the client flew against and computes kills, raider hits, hull damage, cargo delivered, and outcome itself; fuel is charged at the route minimum (`minFuel`). Aim is client-trusted — a shot's claimed target raider isn't geometrically verified — but everything economic (shot timing/cadence, ammo supply, kill thresholds, dodges, hull, delivered cargo, success/void) is server-computed, so a hacked client can at best achieve perfect honest play and never author an outcome outright. v1 bar: cheating must be harder than playing — not tournament-grade.
- **Ledger safety:** append-only events; derived balances. A claim that fails mid-mint is marked `pending` and retried — never double-claimed, never lost.
- **Key management:** mint-authority keys live only in the chain gateway host, mode 0600, env-pointed, never in the repo (same discipline as the yggdrasil amadeus addon design).
- **Devnet-only until** the economy survives real players; mainnet is a separate, explicit later decision.

## 8. Testing

- **Unit tests** on ledger + payout math (fees, shares, escrow, atomicity) — the money paths.
- **Property tests** on run resolution: `resolveRun` must reject malformed fire traces (bad time ordering, cadence violations, ammo overruns) without throwing, and must be deterministic — identical `(mission, ship, crew, fireEvents)` inputs produce byte-identical outputs.
- **Integration tests** for the chain gateway against devnet (mint, read, claim retry).
- Game client: playtested by flying it; no automated tests on rendering in v1.

## 9. Out of scope for v1 (explicit cut lines)

- Harvesting gameplay (chop/dig on islands) — v2.
- Realtime multiplayer / other ships visible in-flight — v2+.
- Custom Anchor/Rust programs (trustless crew escrow, on-chain missions) — v2+.
- Amadeus (AMA) settlement adapter — future, via the chain-gateway seam.
- Mainnet, marketplaces UI, royalties, ship/crew minting storefront — later.
- Raider combat balancing / over-claims rejected — shipped 2026-07-14.
- Server-authoritative run resolution (client-computed telemetry + `validateRun` retired in favor of `resolveRun`) — shipped 2026-07-15.

## 10. Success criteria for v1

1. A stranger with a Phantom wallet and a ship NFT can log in, hire crew, fly a mission, and get paid — in under 10 minutes, in a browser.
2. The settlement visibly grows from aggregate deliveries.
3. Claimed tokens are real SPL tokens visible in Phantom on devnet.
4. The money math survives its test suite; impossible runs are rejected.
