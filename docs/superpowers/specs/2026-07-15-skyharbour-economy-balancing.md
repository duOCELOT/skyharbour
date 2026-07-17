# Skyharbour Economy Balancing Pass — design

**Date:** 2026-07-15
**Goal:** Give two toothless decisions real weight, proven on paper: (A) combat becomes a *defensive* judgment call instead of free money, and (B) the hazard premium scales with what you're carrying, so cargo choice matters on every route.

This is a **tuning pass** — no new systems, no schema. It changes two formulas and one constant, plus their call sites, tests, and docs.

---

## Current state (the diagnosis)

Constants as they stand today:
- Cargo unit price (GOLD/unit): LOG 1, MINERAL 2, FURNITURE 3, FIRERUNE 10 (`tokens.ts`)
- Armory: FUEL 4/G, AMMO 2/G → a shell costs **0.5 G** (`pump.ts`)
- `hazardPay(distance) = ceil(distance/4)` → 15–75 G over distance 60–300 (`missions.ts:56`)
- Mission reward (generate): `amount × unitPrice + hazardPay(distance)` (`missions.ts:118`)
- Run payout (complete): `delivered × unitPrice + floor(hazardPay(distance) × delivered/amount) + bounty` (`missions.ts:216-217`)
- **`bounty = 3 × raidersDestroyed`** (`missions.ts:215`)
- Combat cost: `shotsToKill = 2` (atk<25) or `1` (atk≥25) → **0.5–1.0 G per kill** in shells
- Raiders: 0 if distance≤120, else 1–2 (+1 for FIRERUNE), cap 3 (`validation.ts`)

**Problem 1 — combat is a no-brainer.** Bounty (3 G) beats even a sloppy shell spend (1.5–2 G with misses), so every kill nets +1 to +2.5 G *before* you count the bigger prize (an unkilled raider spills `ceil(loaded×0.1)` cargo/hit — 10 G/hit on FIRERUNE — plus hull damage). There is no route where holding fire is smart. Ammo-as-a-resource has no bite.

**Problem 2 — hazard swamps cargo.** `hazardPay` is distance-only and cargo-blind. On a 300-distance run it's 75 G, so a LOG haul (cargo 5–20 G) is **94% hazard pay** — what you carry is economic noise; you just fly the longest leg. And the premium is a smooth distance ramp while real danger is a step at distance>120.

---

## Change A — bounty below shell cost (combat becomes defensive)

**`bounty = BOUNTY_PER_KILL × raidersDestroyed`, with `BOUNTY_PER_KILL = 1`** (was 3).

New per-kill margin: bounty +1 G − shell cost 0.5–1.0 G ≈ **break-even to slightly negative**. Shooting for profit is dead. The *only* reason to fire is to stop cargo spill — and that reason scales with cargo value:

| Cargo | spill value per hit (10% of loaded, × unitPrice) | shoot? |
|---|---|---|
| LOG (1 G) | ~1 G | let them through |
| MINERAL (2 G) | ~2 G | marginal |
| FURNITURE (3 G) | ~3 G | usually yes |
| FIRERUNE (10 G) | ~10 G | defend hard |

**Every engagement is now a judgment call priced by the cargo in the hold.** That is the "every decision matters" intent, delivered by a one-constant change.

**Anti-cheat:** unchanged. Kills are still bounded by `raiderCount(...)` and by shells actually burned (`kills × shotsToKill(atk) ≤ ammoBurned`). Lowering the payout can't create an exploit.

**Economy effect:** slightly less GOLD minted per run (a few G). Negligible and deflationary in the right direction.

---

## Change B — hazard scales with cargo value

**`hazardPay(distance, cargo) = ceil(distance × unitPrice(cargo) / 12)`**

This is `ceil((distance/4) × (unitPrice/3))` — the old distance curve times a value factor with **FURNITURE (unitPrice 3) as the 1× baseline**. Value factors: LOG 0.33×, MINERAL 0.67×, FURNITURE 1×, FIRERUNE 3.33×.

`hazardPay` gains a `cargo` parameter; **both call sites** must pass it: generate (`:118`) and complete (`:217`).

### Proof — hazard at the extremes

| Cargo | unit | old hazard @d=300 | **new** @d=300 | old @d=120 | **new** @d=120 |
|---|---|---|---|---|---|
| LOG | 1 | 75 | **25** | 30 | **10** |
| MINERAL | 2 | 75 | **50** | 30 | **20** |
| FURNITURE | 3 | 75 | **75** | 30 | **30** |
| FIRERUNE | 10 | 75 | **250** | 30 | **100** |

### Proof — full-run net (amount 5, fee = floor(reward/10), worst-case fuel = no fuel-crew)

Fuel cost = `minFuel × 0.25`; at d=300 worst fuel = 300 → **75 G**. Shells for up to 3 raiders ≈ 3 G.

| Run | reward | fee | fuel | **net (worst fuel)** | net (fuel-crew, ~38 G fuel) |
|---|---|---|---|---|---|
| LOG @300 | 5+25 = 30 | 3 | 75 | **−48 G** (dead) | **−11 G** (still poor) |
| FURNITURE @300 | 15+75 = 90 | 9 | 75 | **+6 G** | **+43 G** |
| FIRERUNE @300 | 50+250 = 300 | 30 | 75 | **+192 G** | **+232 G** |

Short bulk LOG stays viable: LOG amount 20 @d=60 → reward 20+5 = 25, fee 2, fuel 15 → **+8 G**.

### Consequences (stated honestly — this is the "prove each choice pays or costs")

1. **FIRERUNE-far becomes the premier earner** (~+200 G/run). This is the intended "big risk pay" — and it's **naturally governed**: `generate()` only issues missions for cargo the settlement still needs, so you can't farm FIRERUNE infinitely; the stage's FIRERUNE need caps supply. FIRERUNE also draws the most raiders (up to 3) and carries the highest spill risk (10 G/unit) — Change A means you *must* spend shells to protect it, clawing back some margin.
2. **Cheap-cargo-far becomes marginal-to-dead.** A long LOG haul now loses money without fuel-crew. This is arguably correct (why pay a big hazard premium to drag cheap logs across the void?), and the safety valve is **REQUEST NEW POSTINGS** — an unprofitable long-LOG mission just gets ignored and rerolled. **Risk to watch in playtest:** if LOG (a settlement-need tier) repeatedly rolls long, its missions could stall. *Not fixing this now* (respecting the chosen curve); if it bites in playtest, the cheapest follow-up is biasing cheap-cargo missions toward shorter distances in `generate()`, or a small hazard floor. Flagged, not built.
3. Crew shares (% of reward) scale proportionally — no separate change needed.

---

## Files touched

- `server/src/missions.ts` — `hazardPay` signature (+cargo param, new formula); `BOUNTY_PER_KILL` constant (1); both call sites (`:118`, `:217`).
- `server/src/pump.ts`, `tokens.ts`, `validation.ts` — **read-only** (unit prices + shell cost referenced in the proof; not changed).
- Tests: `server/test/missions.test.ts` (and any test asserting reward/hazard/bounty numbers) — updated to the new balance; new focused tests for the value-scaled hazard table and the bounty constant.
- Client: **no formula mirror needed** — the mission board displays server-computed `rewardGold`; `bounty` is server-only (confirm with a grep that no client code hardcodes 3× bounty or the old hazard formula).
- Docs: `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` economy section + `server/chain/README.md` if it cites the old numbers.

## Testing strategy

- `hazardPay(300,'LOG')===25`, `hazardPay(300,'FIRERUNE')===250`, `hazardPay(300,'FURNITURE')===75`, `hazardPay(120,'MINERAL')===20` — pin the value-scaled table.
- Generate a mission and assert `rewardGold === amount×unitPrice + hazardPay(distance,cargo)`.
- A completed run with N raider kills credits exactly `... + 1×N` bounty (assert against the ledger, not a self-reported number).
- Existing anti-cheat tests (kills bounded by raiderCount and by shells burned) must stay green — the clamp logic is untouched.
- Full suite + `tsc --noEmit` green.

## Out of scope (queued, not this pass)

Crew retainers, ship maintenance, chain hardening (session TTL / nonce rate-limit / SIWS), the LOG-long-haul distance-bias guardrail (watch-and-see).
