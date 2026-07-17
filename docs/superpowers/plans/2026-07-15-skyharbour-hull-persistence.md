# Skyharbour Hull Persistence & Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HULL becomes a per-ship stat, combat damage persists between flights, and you pay GOLD at the hangar to repair — so fighting carries lasting stakes.

**Architecture:** Persistent hull is a server-side overlay (`ship_hull(shipId, hull)`), never on the NFT. The anti-cheat lock: the server does NOT trust a reported hull — it INFERS raider damage from the cargo shortfall it already validates (`damage = round((loaded − cargoDelivered) / spillPerHit)`), because each raider hit both spills 10% cargo and costs 1 hull. Rocks remain in-flight-only hazards (avoidable, non-persistent). accept() reads current hull as the run's starting hull; complete() decrements it by inferred damage (floor 1 for a landed ship); a REPAIR route restores toward max for 4 GOLD/point into the settlement treasury.

**Tech Stack:** unchanged.

## Global Constraints

- Owner-locked: HULL is a ship stat with per-class ranges — hauler 10–12, freighter 8–9, courier 5–6, relic 9–10, flagship 14; repair `REPAIR_PER_GOLD_POINT = 4` GOLD per hull point restored (GOLD → settlement); a landed ship never drops below hull 1.
- Damage is server-derived, never self-reported: `spillPerHit(loaded) = Math.ceil(loaded * 0.1)`; `inferredHits(loaded, delivered) = spillPerHit > 0 ? Math.max(0, Math.round((loaded − delivered) / spillPerHit)) : 0` where `loaded = min(effectiveCargo(ship, crew), amount)`. No new Telemetry field.
- Manifest determinism: the hull draw is appended LAST per ship in the generator (after engine/cargo/bridge) so names and existing stats stay byte-identical; regenerate + commit the manifests; the drift-guard test must pass.
- Test-fleet ships and fixtures gain hull (hauler-trio 11, courier-trio 5, freighter-trio 9; ship-1 8, ship-2 6 to match their courier-ish stats — pick within-fantasy, pinned by tests).
- `Ship` interface gains `hull: number`; `ChainFleet` RegistryEntry ship variant + mint scripts thread it; `mkRun` starts hull at the passed current-hull (new param) capped at ship.hull, max at ship.hull.
- Suite + typecheck green from server/ before every commit; node --check client files; escapeHtml; dev mode byte-compatible.
- Authorized mechanical test edits: mkRun hull assertions (flat 8 → per-ship), manifest hull range/drift, fleet/fixture hull fields, combat model hull-max references.

---

### Task 1: HULL as a ship stat (types, fleets, fixtures, manifest)

**Files:**
- Modify: `server/src/fleet.ts` (Ship + trio + fixtures), `server/src/chain/fleet.ts` (RegistryEntry ship), `server/scripts/gen-manifests.ts` (hull draw + ranges), `server/scripts/mint-nft.ts` + `server/scripts/mint-batch.ts` (registry mapping + attribute), `server/chain/manifest-ships.json` (regenerated)
- Test: `server/test/fleet.test.ts`, `server/test/chain/manifests.test.ts`, `server/test/chain/nftmeta.test.ts`

**Interfaces:**
- Produces: `Ship` gains `hull: number`. `TRIO` hull: hauler 11, courier 5, freighter 9. `devFixtures()` ships: ship-1 hull 8, ship-2 hull 6. `ChainFleet` ship RegistryEntry gains `hull`. gen-manifests `ShipEntry` gains `hull`; ranges hauler 10–12/freighter 8–9/courier 5–6/relic 9–10/flagship 14; hull drawn as the LAST rng call per ship. `manifestToRegistryEntry('ship', …)` maps `hull`. `shipAttributes` (mint-nft) adds `{ trait_type: 'HULL', value: hull }`.

- [ ] **Step 1: Failing tests** — fleet.test: trio/fixture ships assert `hull` (hauler 11, courier 5, freighter 9, ship-1 8). manifests.test: every ship has hull in its class range; flagship hull 14; drift-guard (committed == generated) still holds; census unchanged. nftmeta.test: shipAttributes includes HULL trait.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement types + generator (append hull draw last), run `npm run chain:gen-manifests` to regenerate + commit both JSONs, thread hull through registry mapping + attribute.
- [ ] **Step 4:** Full suite + typecheck green.
- [ ] **Step 5: Commit** — `git commit -m "feat: HULL is a ship stat — per-class armor, manifest regenerated"`

---

### Task 2: Server hull state + inferred damage + repair

**Files:**
- Create: `server/src/hull.ts`
- Modify: `server/src/missions.ts` (accept reads hull, complete decrements), `server/src/validation.ts` (export inferredHits/spillPerHit), `server/src/app.ts` (routes)
- Test: `server/test/hull.test.ts`, `server/test/missions.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Produces:
  - validation.ts: `export const spillPerHit = (loaded: number) => Math.ceil(loaded * 0.1);` `export const inferredHits = (loaded: number, delivered: number) => { const s = spillPerHit(loaded); return s > 0 ? Math.max(0, Math.round((loaded - delivered) / s)) : 0; };`
  - hull.ts: `export const REPAIR_PER_GOLD_POINT = 4;` `class HullState { constructor(db); current(shipId: string, max: number): number /* defaults to max */; set(shipId, hull): void; damage(shipId, max, points): number /* new hull, floored at 1, never below 1 for landed */; repair(ledger, wallet, shipId, max, toPoints): { spent: number; hull: number } }` — repair raises hull toward `min(toPoints, max)`, charges `4 * pointsRestored` GOLD wallet→settlement atomically, throws `'nothing to repair'` if already at/above target or `'not your ship'`-style guard handled by caller.
  - missions.ts: `accept()` passes the ship's CURRENT hull to the mission record (`startHull`), and returns it so the client can start there. `complete()`: `const loaded = min(effectiveCargo, amount); const dmg = inferredHits(loaded, delivered); hullState.damage(m.shipId, ship.hull, dmg);` (landed ⇒ ≥1).
  - app.ts: `POST /ship/repair { shipId, toHull }` → verifies caller owns the ship (fleet.getShip.owner === wallet), calls `hull.repair(...)`; `GET /hangar` or extend `/login` ships to include `{ …ship, currentHull }`.

- [ ] **Step 1: Failing tests** — hull.test: inferredHits math (loaded 20, delivered 14 → 6 lost / spill 2 = 3 hits); repair charges 4/point and clamps to max; damage floors at 1. missions.test: a landed run delivering short leaves the ship damaged next accept; full delivery = no damage. app.test: /ship/repair pays GOLD, restores hull, rejects non-owner.
- [ ] **Steps 2-4:** RED → implement → green.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): hull persists, damage inferred from cargo, repair at the hangar"`

---

### Task 3: Client — start at current hull, hangar hull + repair UI

**Files:**
- Modify: `client/flightMath.js` (mkRun starting hull param), `client/flight.js` (pass current hull), `client/api.js`+`.d.ts` (repairShip), `client/bridge.js` (hangar hull display + repair), `client/render.js` (hangar card hull), `index.html`/`styles.css`
- Test: `server/test/client/flightMath.test.ts`, `server/test/client/render.test.ts`, `server/test/client/api.test.ts`

**Interfaces:**
- flightMath: `mkRun(ship, crew, distance, fuelBudget, ammoBudget = 0, startHull = ship.hull)` — `hull: Math.min(startHull, ship.hull)`, max references become `ship.hull`. api: `repairShip(shipId, toHull)` → POST /ship/repair. render: `renderHangar` ship card shows `HULL <cur>/<max>` and a `REPAIR` button (`data-repair="<shipId>"`) when cur < max. bridge: repair click → repairShip(shipId, max) → refresh economy + hangar; flight.js passes the ship's currentHull (from session ships) into mkRun.

- [ ] **Step 1:** RED render/api/flightMath tests → implement.
- [ ] **Step 2:** suite + typecheck + node --check + boot smoke (index has `data-repair`).
- [ ] **Step 3: Commit** — `git commit -m "feat(client): hangar shows hull, repair button, flights start battered"`

---

### Task 4: Seal + chain + docs

**Files:**
- Test: `server/test/client/loop.test.ts`
- Modify: `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (§3 HULL stat, §6 repair sink)

**Interfaces:** consumes everything.

- [ ] **Step 1: Seal (must pass):** a raider run where the pilot takes hits (delivers short) lands, next accept starts the ship below max; repair restores it for exactly 4×points GOLD; assert hull-damage == inferredHits(loaded, delivered). Negative: a full-delivery run leaves hull untouched.
- [ ] **Step 2:** Spec §3 ships row gains HULL; §6 sinks gains repair. (AMMO mint already covers chain; no new token.)
- [ ] **Step 3:** Full suite + typecheck; commit `git commit -m "test: hull persistence sealed; HULL + repair in the spec"`.

---

## Self-review notes

- Anti-cheat: hull damage is a pure function of the server-validated cargoDelivered — no new trusted field, no repair-dodge cheat (under-reporting damage = over-reporting cargo = capped at loaded). Verified by the seal asserting damage == inferredHits.
- Type consistency: `Ship.hull` (T1) → mkRun startHull (T3) ↔ accept startHull/complete damage (T2); `inferredHits`/`spillPerHit` (T2 validation) used in T2 complete + T4 seal; `REPAIR_PER_GOLD_POINT` (T2) ← client repair (T3); manifest ShipEntry.hull → registry crewSlots-style mapping (T1).
- Determinism: hull drawn last per ship keeps names/other stats byte-stable; drift-guard test enforces committed==generated.
- Deferred (still t-259a41): crew retainers, ship maintenance/decay over time. Logged, not in this plan.
