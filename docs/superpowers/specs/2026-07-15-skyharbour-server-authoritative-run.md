# Skyharbour Server-Authoritative Run — design

**Date:** 2026-07-15
**Goal:** Remove the last client-trust surface in the economy: the run outcome (kills, cargo delivered, hull damage, ammo, success/void) becomes **computed by the server** from a deterministic combat-resolution model, instead of being reported by the client and merely bounded. The client sends only what the player *did* (fire events); the server decides what *happened*.

This is the "combat-resolution model" — not a full physics replay. The three.js flight stays as a visualization; the authoritative outcome is a discrete, trig-free, seeded computation the server owns.

---

## The problem it fixes

Today `client/flight.js` runs the arcade combat (raider bolts, shot-hit detection, `applyRaiderHit` dodge via `Math.random`), calls `telemetry(run, mission, ship)` to produce `{ durationS, fuelSpent, cargoDelivered, raidersDestroyed, ammoSpent }`, and POSTs it to `/missions/:id/complete`. The server (`validateRun`) only **bounds** those numbers — it never reproduces them. A hacked client can therefore submit any outcome that fits inside the bounds (e.g. "delivered max, killed every raider, spent minimum") without having played the run. The bounds keep the economy from breaking, but the *outcome itself is client-authored* — the exact hole the player flagged: "cheating exists at the client level."

## The model: the server owns the outcome

The mission's **seed is the missionId** (a server-generated UUID the client cannot choose). From it the server derives, deterministically:

- the **raider set** — reuse `mkWorld(missionId, distance, cargo).raiders` (already seeded), count = `raiderCount(missionId, distance, cargo)` (0–3);
- each raider's **engage window** `[engageStart_i, attackAt_i]` in sim-seconds, derived from its seeded `z` position and the ship's full-throttle speed (`v = engine × WORLD_SCALE`): `engageStart_i = z_i / v`, `attackAt_i = engageStart_i + ENGAGE_WINDOW`;
- the **rock encounters** — reuse `mkWorld(...).rocks`.

The client submits the player's actions as a compact list of **fire events**:

```
POST /missions/:id/complete  { fireEvents: [{ t: number, raider: number | null }, …] }
```

`t` = sim-seconds since launch (the client's `run.t` at the shot); `raider` = the raider index the shot was aimed at, or `null` for a miss (still costs a shell). No telemetry, no positions, no outcome — the server discards anything the client thinks happened.

## Server resolution algorithm

Given the mission, ship, crew (all server-side) and the seed:

1. **Validate the trace.** `t` monotonic non-decreasing and within `[0, T]` where `T = distance × WORLD_SCALE / engine`; consecutive shots at least `cannonCooldown(attackSkill(crew))` apart; total shots ≤ the player's **AMMO balance** (can't fire shells you don't own). `ammoSpent` = count of accepted shots. Reject a malformed trace (fail the run, don't credit).
2. **Score kills.** For each raider `i`, take its aimed valid shots (those with `raider===i` and `engageStart_i ≤ t ≤ attackAt_i`) in time order; each deals `cannonDamage(attackSkill(crew))`; when cumulative damage ≥ raider hp (2) at a shot time `tk`, the raider is **destroyed** (counts toward `raidersDestroyed`). If `tk ≤ attackAt_i` the raider never attacks.
3. **Resolve attacks.** Every raider **alive at `attackAt_i`** fires: dodge with a **seeded** draw `rng("${missionId}:hit:${i}") < defenseSkill(crew)/100` → dodged, else a hit: `hull -= 1`, `raiderHits += 1`.
4. **Resolve rocks.** For each rock `j`: `rng("${missionId}:rock:${j}") < defenseSkill(crew)/100` → safe, else `hull -= 1`. (No player input — DEFENSE crew is the only lever, exactly as today.)
5. **Compute the outcome, server-side:**
   - `loaded = min(ship.cargo + haulingSkill(crew), mission.amount)`
   - `spill = raiderHits × ceil(loaded × 0.1)`; `cargoDelivered = max(0, loaded − spill)`
   - `fuelSpent = minFuel(distance, crew)` — the route minimum (fuel is a route cost, not the run's skill axis; see decisions)
   - `outcome = hull ≤ 0 ? 'void' : 'landed'`
   - `hull` (final) persists via the existing `HullState`.
6. **Settle the economy with these server-computed numbers** through the *existing* `complete()` / fail path — reward from validated `cargoDelivered`, bounty from `raidersDestroyed`, crew shares, FUEL+AMMO burns, hull persistence, settlement delivery. A `void` outcome routes to the existing fail settlement (cargo lost, fuel+ammo burned, hull floored at 1).

The result is that **every economically-meaningful number is produced by the server** from the seed + the raw fire trace. The client cannot report an outcome at all.

## What stays client-side — the one honest tradeoff

**Aim is client-trusted; timing, cadence, ammo, kill-thresholds, dodges, and all outcomes are server-authoritative.** A shot claims to target raider `i`; the server validates the *timing* (raider in its engage window, cooldown respected, ammo available) but not the *geometry* (whether the reticle was truly on the raider). So a cheating client can claim every shot is a perfect hit on an in-window raider.

Why this is acceptable and still closes the hole:
- Kills are bounded by `raiderCount` (server seed), by shells actually spent (server-counted, ≤ your real AMMO), by `cannonCooldown` (can't fire faster than the gun), and by `shotsToKill`/`cannonDamage` (attack skill). A "perfect-aim" cheater therefore achieves exactly **what a perfectly-aiming honest player achieves** — no more GOLD, no more kills, and it costs the same real shells.
- The forgeable surface shrinks from "author any outcome" to "have perfect aim," which is a *skill ceiling*, not an *economy exploit*. Proving a human (not a bot) pushed the trigger is an anti-bot problem, explicitly out of scope.

This is the deliberate line the "combat-resolution model" draws (vs. the full-physics-replay option, which would also validate geometry at the cost of a heavy, float-fragile engine rewrite).

## Shared code & determinism

- The resolver lives in **`client/flightMath.js`** (already the shared client/server model) as a pure function, e.g. `resolveRun(mission, ship, crew, fireEvents) → { raidersDestroyed, raiderHits, hull, cargoDelivered, fuelSpent, ammoSpent, outcome }`. The **server** calls it for authority; the **client** calls it too, so the flight visualization shows the same result the server will compute (no "I killed it but the server disagrees" confusion).
- **Determinism is structural:** the resolver uses only integer/time arithmetic and the existing seeded `rng(hashSeed(...))` — **no `Math.random`, no wall-clock, no trig** on the authoritative path. It is therefore reproducible across JS engines (the failure mode that makes full-physics replay fragile does not arise here). `client/flight.js` keeps its three.js trig for *rendering only*; nothing it computes is trusted.
- `applyRaiderHit` / `registerKill` / the ad-hoc `Math.random` dodge in the live loop are retired from the authoritative path (flight.js may keep cosmetic equivalents, but they feed nothing the server reads).

## How it composes with the rest

- **Orthogonal to the economy-balancing spec** (bounty 3→1, value-scaled hazard): this changes *how the outcome is produced*, not *what it's worth*. The settlement math is untouched; both specs compose cleanly.
- **Dev mode unaffected in spirit** — the endpoint contract changes for everyone (telemetry → fireEvents), but dev and chain mode share the same `complete()`; no chain-specific behavior.
- **SOL on-ramp / claims** — untouched.

## Anti-cheat analysis (before → after)

| Vector | Today | After |
|---|---|---|
| Report inflated cargo delivered | bounded by capacity | **impossible** — server computes it from resolved spill |
| Claim kills you didn't make | bounded by raiderCount | **impossible** — server scores kills from your fire timing |
| Claim zero damage on a rough run | inferred from shortfall | **impossible** — server resolves hull from seeded rocks + unkilled raiders |
| Spend fewer shells than kills need | cross-checked vs report | **impossible** — server counts shells from the trace |
| Author the whole outcome | the actual hole | **closed** — client sends inputs only |
| Perfect aim without playing well | n/a | **allowed** (= perfect honest play; bounded by ammo/cooldown/raider count) — the documented residual |

## Testing strategy

- `resolveRun` unit tests (server + shared): a trace that kills all raiders in-window → `raidersDestroyed = N`, `raiderHits = 0`, full delivery; an empty trace → all raiders attack → spill + hull damage per seeded dodges; shots faster than cooldown → rejected; shots exceeding AMMO → rejected; a raider killed *after* its `attackAt` → counts as destroyed **and** as having attacked; hull ≤ 0 → `outcome:'void'` routes to fail settlement.
- **Determinism test:** the same `(mission, ship, crew, fireEvents)` yields byte-identical results across repeated calls and matches a frozen golden vector (guards accidental `Math.random`/trig creeping onto the path).
- **Economy invariants preserved:** existing complete/fail settlement tests adapted to drive `fireEvents` instead of telemetry; ledger zero-sum and hull persistence unchanged.
- **Client parity:** flight.js's cosmetic result equals `resolveRun`'s for a recorded trace (so the player sees what the server credits).

## Migration / back-compat

- `/missions/:id/complete` body changes from `{ telemetry }` to `{ fireEvents }`; `missions.complete(id, fireEvents)` computes telemetry internally. `validateRun` is repurposed from *output bounding* to *input validation* (trace well-formedness) or retired if `resolveRun` subsumes it.
- All existing tests that post telemetry are rewritten to post traces (or call `resolveRun` directly). This is a breaking internal contract change, done in one wave.
- `failMission` stays for genuine abandons (client closes / gives up); a completed-but-void run is resolved server-side into the fail settlement.

## Open decisions for your review

1. **Fuel = route minimum.** The model drops "dodging burns extra fuel" (fuel becomes `minFuel(distance, crew)` flat). Fuel was never a real skill axis (honest runs already burn ≈ minimum). Confirm you're fine losing that nuance for a clean model — or we keep a small dodge-fuel penalty.
2. **Aim client-trusted** (the residual above). Confirm you accept "perfect-aim = perfect play, bounded by resources" as the line, rather than paying for full geometric validation (that's the full-physics-replay option you already passed on).
3. **`ENGAGE_WINDOW` length** is a tuning knob (how long a raider is shootable before it attacks). It sets the timing difficulty. Ship a first value and tune in playtest, like the other combat constants.

## Out of scope

Full physics replay, movement/steering authority, anti-bot/human-proof measures, the parked economy-balancing pass, crew retainers / ship maintenance.
