# Skyharbour Server-Authoritative Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The run outcome (kills, cargo delivered, hull damage, ammo, success/void) becomes computed by the server from a deterministic combat-resolution model driven by the mission seed + the player's fire events, instead of being reported by the client and merely bounded.

**Architecture:** A pure, deterministic `resolveRun` in the shared `client/flightMath.js` turns `(mission, ship, crew, startHull, ammoAvailable, fireEvents)` into the authoritative outcome. The server calls it in `missions.complete()` and settles the *existing* economy on its numbers; the client calls it too so the cosmetic three.js flight shows the same result. The endpoint stops accepting telemetry and accepts fire events only.

**Tech Stack:** TypeScript/Fastify server, better-sqlite3, Vitest; plain ES-module vanilla-JS client; shared `flightMath.js`.

## Global Constraints

- **Determinism (load-bearing):** the authoritative path uses ONLY integer/time arithmetic and the existing seeded `rng(hashSeed(...))`. NO `Math.random`, NO `Date.now`/wall-clock, NO trig (`Math.sin/cos/atan2`) anywhere `resolveRun` reads. Identical inputs → byte-identical outputs.
- **Aim is client-trusted; everything economic is server-authoritative.** The server validates a shot's *timing* (raider in its engage window), *cadence* (≥ `cannonCooldown(attackSkill)` since the previous accepted shot), and *supply* (total accepted shots ≤ the player's real AMMO balance). It does NOT validate geometry. Perfect-aim = perfect play, bounded by those three — no economy gain.
- `fuelSpent = minFuel(distance, crew)` — the route minimum (fuel is not the run's skill axis).
- **Economy settlement math is UNCHANGED** — reward, bounty, crew shares, burns, hull persistence, `settlement.deliver` all stay exactly as in `complete()`/`fail()` today; only their *inputs* are now server-computed.
- Endpoint contract: `POST /missions/:id/complete { fireEvents: [{ t: number, raider: number | null }, …] }`. No `telemetry` field anywhere.
- Dev mode and chain mode share `complete()`; no chain-specific behavior.
- Raider `hp = 2` (unchanged). `raiderCount`, `cannonDamage`, `cannonCooldown`, `attackSkill`, `defenseSkill`, `haulingSkill`, `minFuel`, `WORLD_SCALE` are reused as-is.
- `ENGAGE_RANGE_WORLD = 300` (world units a raider is shootable before the player reaches its z); a tunable first value.
- Suite + `tsc --noEmit` green from `server/` before every commit; `node --check` edited client files; dev-mode economy behavior otherwise unchanged.

---

### Task 1: The deterministic resolver (shared `flightMath.js`)

**Files:**
- Modify: `client/flightMath.js`
- Test: `server/test/client/resolve.test.ts`

**Interfaces:**
- Produces:
  - `export function raiderTimeline(missionId, distance, cargo, engine)` → `[{ engageStart, attackAt }]`, one per raider from `mkWorld(missionId, distance, cargo).raiders` (same order). With world speed `v = engine` (matches `stepRun`'s `pos.z += throttle*engine*dt`): `attackAt_i = raider.z / v`, `engageStart_i = Math.max(0, (raider.z - ENGAGE_RANGE_WORLD) / v)`.
  - `export const ENGAGE_RANGE_WORLD = 300;`
  - `export function resolveRun(args)` where `args = { missionId, distance, cargo, amount, ship, crew, startHull, ammoAvailable, fireEvents }` and it returns:
    ```
    { ok: true, raidersDestroyed, raiderHits, ammoSpent, fuelSpent,
      loaded, cargoDelivered, hullDamage, finalHull, outcome }   // outcome: 'landed' | 'void'
    // or { ok: false, reason }   // malformed trace
    ```
- Consumes: existing `mkWorld`, `raiderCount`, `attackSkill`, `defenseSkill`, `haulingSkill`, `cannonDamage`, `cannonCooldown`, `hashSeed`, `rng` (make `rng` reachable — it's currently module-private; keep it private and add a small seeded helper `seededChance(key)` = `rng(hashSeed(key))()` for one draw), and `minFuel` (add a local mirror in flightMath OR import path — NOTE: `minFuel` lives in `server/src/validation.ts`; flightMath is client-side and cannot import server code. Add `export const minFuelClient = (distance, crew) => Math.ceil(distance * (1 - fuelSkill(crew)/100))` to flightMath — it already has `fuelSkill` and this matches `validation.ts` exactly. Server `resolveRun` uses this same shared value, so client and server agree.)

**Algorithm (resolveRun):**
1. **Validate the trace** → `{ok:false, reason}` if: `fireEvents` not an array; any event `t` not a finite number or `< 0` or `> T` (`T = distance * WORLD_SCALE / engine`); `t` not non-decreasing across the list; `raider` not `null` and not an integer in `[0, raiderCount-1]`; length `> ammoAvailable + 1` (hard cap — a trace longer than the magazine is tampering). Accepted-shot cadence: walk events in order tracking `lastT`; a shot is *cadence-valid* if `t - lastT >= cannonCooldown(atk)`; cadence-invalid shots are **dropped** (not counted, not fatal — a well-behaved client never sends them). `ammoSpent` = number of accepted (cadence-valid) shots, capped at `ammoAvailable`; shots beyond the cap are dropped.
2. **Kills** — for each raider `i`: its aimed accepted shots are those with `raider===i` AND `engageStart_i <= t <= attackAt_i`, in time order; accumulate `cannonDamage(atk)`; when cumulative ≥ `hp (2)` at time `tk`, raider `i` is destroyed → `raidersDestroyed++`. Track `killedBy_i = tk` (or `Infinity`).
3. **Attacks** — for each raider `i` with `killedBy_i > attackAt_i` (alive when it fires): `seededChance("${missionId}:hit:${i}") < defenseSkill(crew)/100` → dodged; else hit → `hull -= 1`, `raiderHits++`.
4. **Rocks** — for each rock index `j` in `mkWorld(...).rocks`: `seededChance("${missionId}:rock:${j}") < defenseSkill(crew)/100` → safe; else `hull -= 1`.
5. **Outcome** — `loaded = Math.min(ship.cargo + haulingSkill(crew), amount)`; `spill = raiderHits * Math.ceil(loaded * 0.1)`; `cargoDelivered = Math.max(0, loaded - spill)`; `hull` starts at `startHull`; `finalHull = Math.max(1, hull)` for persistence but `outcome = hull <= 0 ? 'void' : 'landed'`; `hullDamage = startHull - finalHull`; `fuelSpent = minFuelClient(distance, crew)`.

- [ ] **Step 1: Failing tests** — `server/test/client/resolve.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { resolveRun, raiderTimeline, mkWorld, raiderCount } from '../../../client/flightMath.js';

// distance>120 so raiders exist; FIRERUNE bumps count. Pick a mission id with known raiderCount.
const M = { missionId: 'mtest-1', distance: 200, cargo: 'MINERAL', amount: 10 };
const ship = { cargo: 20, hull: 8, engine: 10 };
const crew = [{ skills: { attack: 30, defense: 0, hauling: 0, fuel: 0 } }]; // atk 30 → cannonDamage 2 → 1 shot/kill
const N = raiderCount(M.missionId, M.distance, M.cargo);
const tl = raiderTimeline(M.missionId, M.distance, M.cargo, ship.engine);

it('kills every raider when shots land in-window, full delivery, no hull loss from raiders', () => {
  const fireEvents = tl.map((w, i) => ({ t: (w.engageStart + w.attackAt) / 2, raider: i })); // one killing shot each (atk30→dmg2)
  const r = resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 99, fireEvents });
  expect(r.ok).toBe(true);
  expect(r.raidersDestroyed).toBe(N);
  expect(r.raiderHits).toBe(0);
  expect(r.cargoDelivered).toBe(Math.min(ship.cargo, M.amount)); // no spill
  expect(r.outcome).toBe('landed');
  expect(r.ammoSpent).toBe(N);
});

it('empty trace → every raider attacks (defense 0 never dodges), spill + hull damage', () => {
  const r = resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 99, fireEvents: [] });
  expect(r.raidersDestroyed).toBe(0);
  expect(r.raiderHits).toBe(N);
  expect(r.cargoDelivered).toBeLessThan(Math.min(ship.cargo, M.amount));
  expect(r.hullDamage).toBeGreaterThanOrEqual(N); // raiders + maybe rocks
});

it('is deterministic — identical inputs give identical output', () => {
  const fe = [{ t: 1, raider: 0 }];
  expect(resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 5, fireEvents: fe }))
    .toEqual(resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 5, fireEvents: fe }));
});

it('drops shots fired faster than the cannon cooldown', () => {
  // two shots at the same t on raider 0: only one is cadence-valid
  const w = tl[0];
  const fe = [{ t: w.engageStart + 0.01, raider: 0 }, { t: w.engageStart + 0.02, raider: 0 }];
  const r = resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 99, fireEvents: fe });
  expect(r.ammoSpent).toBe(1);
});

it('caps accepted shots at the ammo the pilot actually has', () => {
  const fe = tl.flatMap((w, i) => [{ t: w.engageStart + 0.1, raider: i }]);
  const r = resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 1, fireEvents: fe });
  expect(r.ammoSpent).toBeLessThanOrEqual(1);
});

it('rejects a malformed trace', () => {
  expect(resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 5, fireEvents: [{ t: -1, raider: 0 }] }).ok).toBe(false);
  expect(resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 5, fireEvents: [{ t: 2, raider: 0 }, { t: 1, raider: 0 }] }).ok).toBe(false);
});
```
- [ ] **Step 2-4:** RED → implement `raiderTimeline`, `ENGAGE_RANGE_WORLD`, `minFuelClient`, `seededChance`, `resolveRun` per the algorithm → GREEN. Verify no `Math.random`/trig on the path (`grep -n "Math.random\|Math.sin\|Math.cos\|Math.atan\|Date.now" client/flightMath.js` — any hit must be outside resolveRun's call graph). Full suite + `node --check client/flightMath.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat(flight): deterministic server-authoritative resolveRun"`

---

### Task 2: Server settles on the resolver (`missions.complete`)

**Files:**
- Modify: `server/src/missions.ts` (`complete`), `server/src/app.ts` (the `/complete` route)
- Test: `server/test/missions.test.ts` (and any complete/validateRun test)

**Interfaces:**
- Consumes: `resolveRun`, `raiderTimeline` from `../../client/flightMath.js` (server already imports from there — see `validation.ts` mirroring and existing test imports).
- Produces: `complete(id: string, fireEvents: FireEvent[]): Payout & { outcome: 'landed' | 'void' }` where `type FireEvent = { t: number; raider: number | null }`.

**Behavior:**
- Replace the `telemetry`/`validateRun` block. Resolve crew + ship as today, then:
  ```
  const ammoAvailable = ledger.balance(`wallet:${m.pilot}`, 'AMMO');
  const res = resolveRun({ missionId: m.id, distance: m.distance, cargo: m.cargo, amount: m.amount,
    ship, crew: crew.map(c => c.member), startHull: m.startHull ?? ship.hull, ammoAvailable, fireEvents });
  if (!res.ok) throw new Error(`run rejected: ${res.reason}`);
  ```
- **Void path:** if `res.outcome === 'void'`, run the *fail* settlement (reuse `fail()`'s leg logic — fee→settlement, burn `res.fuelSpent` FUEL and `res.ammoSpent` AMMO, floor hull at 1 via `hullState.damage(m.shipId, ship.hull, startHull-1)`), mark `status:'failed'`, and return `{ outcome:'void', delivered:0, rewardGold:0, crewShares:[], fuelBurned:res.fuelSpent }`. (Factor the shared fail-legs into a private helper so `fail()` and the void path don't duplicate.)
- **Landed path:** use the *existing* success settlement verbatim, but sourced from `res`: `delivered = res.cargoDelivered`, `bounty = 3 * res.raidersDestroyed` (or `BOUNTY_PER_KILL` if the balancing pass has landed — keep whatever constant is in the tree), `fuelBurned = res.fuelSpent`, `ammoBurned = res.ammoSpent` (already ≤ balance by construction — keep the `Math.min(..., balance)` as a belt-and-suspenders). Delete the now-redundant "kills claimed without shells" recheck (kills are server-derived). Hull: `hullState.damage(m.shipId, ship.hull, res.hullDamage)` instead of the `inferredHits` derivation.
- `validateRun` in `validation.ts` is no longer called by `complete`; leave the file (its helpers `minFuel`, `raiderCount`, `attackSkill`, `shotsToKill`, `effectiveCargo` are still used) but remove `validateRun` itself and its now-dead `Telemetry` output checks IF nothing else imports them (grep first; if a test imports `validateRun`, migrate/remove it in Task 4).
- app.ts: `const { fireEvents } = req.body as { fireEvents: FireEvent[] }; return missions.complete(id, fireEvents);`

- [ ] **Step 1: Failing tests** in `server/test/missions.test.ts` (adapt setup from the existing complete tests — seed FUEL/AMMO, accept a mission, then):
```ts
it('lands and pays out when the trace kills the raiders', async () => {
  // build fireEvents from raiderTimeline for the accepted mission; expect status done, reward > 0, delivered == loaded
});
it('an empty trace on a raider route spills cargo and damages hull, still lands if hull survives', async () => { /* … */ });
it('routes to the fail settlement when the run voids (hull to 0)', async () => {
  // a mission whose seeded raiders+rocks exceed startHull with an empty trace → outcome 'void', status 'failed', no reward
});
it('a completed run credits kills the server scored, never a client-claimed count', async () => { /* fireEvents kill 1; assert bounty for exactly 1 */ });
```
- [ ] **Step 2-4:** RED → implement → GREEN. Full suite + `tsc --noEmit`.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): complete() settles on server-resolved run, void routes to fail"`

---

### Task 3: Client records + posts fire events

**Files:**
- Modify: `client/flight.js`, `client/api.js` (+ `client/api.d.ts` if present)
- Test: `server/test/client/api.test.ts` (completeMission posts `{ fireEvents }`)

**Interfaces:**
- `api.js`: change `export const completeMission = (id, fireEvents) => api('/missions/'+id+'/complete', { method: 'POST', body: { fireEvents } });` (was `{ telemetry }`).
- `flight.js`: maintain a `fireEvents` array. When the player fires and `fireShot(run)` succeeds, push `{ t: run.t, raider: <index of the raider the bolt is aimed at, or null> }`. The existing bolt-vs-raider hit loop already knows which raider mesh a bolt strikes; tag the shot with that raider's stable index (assign each `world.raiders[k]` an index at spawn and carry it on the raider object). On landing/void, call `completeMission(mission.id, fireEvents)` instead of `telemetry(...)`. Keep the three.js scene for visuals; its cosmetic kill/hit feedback may stay, but nothing it computes is sent. Optionally call `resolveRun` locally to show the *authoritative* result in the HUD so the player sees what will be credited (recommended, not required).
- Remove the `telemetry(run, mission, ship)` call from the complete path (the function may remain in flightMath for now; Task 4 removes it if unused).

- [ ] **Step 1:** failing api test (completeMission body is `{ fireEvents }`).
- [ ] **Step 2-4:** RED → implement → GREEN; `node --check client/flight.js client/api.js`; boot smoke `/app/` 200.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): flight records + posts fire events, not telemetry"`

---

### Task 4: Migrate remaining tests, retire dead code, docs, seal

**Files:**
- Modify: any test still posting `telemetry`; `client/flightMath.js` (remove `telemetry`, `applyRaiderHit`, `registerKill`, `fireShot`-only-for-telemetry if now unused — grep first); `server/src/validation.ts` (remove `validateRun` if unused); the spec + `server/chain/README.md`/design doc mention.
- Test: whole suite.

- [ ] **Step 1:** grep for `telemetry`, `validateRun`, `applyRaiderHit`, `registerKill` across `server/` and `client/`; migrate each test to drive `fireEvents`/`resolveRun`; delete functions with zero remaining references (keep any still used — e.g. `fireShot` is still called by flight.js).
- [ ] **Step 2:** update `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (run section) + the design doc to describe server-authoritative resolution.
- [ ] **Step 3:** full suite + `tsc --noEmit` green; commit `git commit -m "test+docs: migrate to server-authoritative run; retire telemetry path"`.

---

## Self-review notes

- **Determinism is the whole game.** resolveRun and raiderTimeline must never touch `Math.random`/trig/wall-clock — Task 1 Step 4 greps for it, and the determinism test pins it. Client and server share the exact function, so their results cannot diverge.
- **Type/interface chain:** `resolveRun`/`raiderTimeline`/`ENGAGE_RANGE_WORLD`/`minFuelClient` (T1) ← `complete(id, fireEvents)` + `/complete` route (T2) ← `completeMission(id, fireEvents)` + flight.js trace (T3); `FireEvent = { t, raider }` used identically in T2 and T3.
- **Economy untouched:** T2 reuses the existing success/fail legs verbatim; only the inputs (`delivered`, `raidersDestroyed`, `fuelBurned`, `ammoBurned`, hull damage) change source from client-telemetry to `res`. Composes with the parked balancing pass.
- **Residual, by design:** aim is client-trusted (perfect-aim = perfect play, bounded by ammo/cooldown/raiderCount). Documented in the spec; not a defect.
- **At-risk / verify live:** the client flight's cosmetic combat must feel consistent with `resolveRun` (a raider you shoot on-screen should be one the server scores). Needs the owner's eyeball in playtest (headless screenshots are down on this box) — flag in the final report.
