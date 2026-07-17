# Skyharbour Ship Combat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wake the ATTACK stat: seeded raiders ambush long routes, the ship gets a cannon (SPACE), hits spill cargo, kills pay a server-bounded bounty.

**Architecture:** The raider count is a pure deterministic function of (missionId, distance, cargo) implemented identically on both sides — the server never trusts a kill count above what it computes itself. Combat simulation lives client-side (like all flight physics); its only server-visible outputs are `raidersDestroyed` (validated ≤ deterministic count) and a lower `cargoDelivered` (already server-bounded). Rendering/AI go in flight.js; all math goes in flightMath.js/validation.ts as pure tested functions.

**Tech Stack:** unchanged.

## Global Constraints

- Owner-locked numbers: raiders = `0` when `distance ≤ 120`, else `1 + (hash(missionId + ':raiders') % 2) + (cargo === 'FIRERUNE' ? 1 : 0)`, capped at 3; bounty = `3` GOLD per kill (added to rewardGold BEFORE crew shares); `attackSkill(crew) = min(Σ attack, 50)`; `cannonDamage = 1 + floor(attackSkill/25)` (1–3); `cannonCooldown = 0.8 * (1 - attackSkill/100)` seconds; raider HP 2; each raider bolt that hits (DEFENSE dodge applies, same roll as rocks) costs 1 hull AND spills `ceil(10% of loaded)` cargo units.
- The raider-count function is char-for-char mirrored between `server/src/validation.ts` (authority) and `client/flightMath.js`, with a cross-equality test importing both.
- `Telemetry.raidersDestroyed` is optional (absent = 0) so all existing telemetry stays valid; `RunParams` gains `missionId: string; cargo: string` (plan-authorized mechanical update of existing validateRun call sites/tests).
- Honest client clamps: `telemetry()` reports `raidersDestroyed = min(run.kills, raiderCount(...))` and `cargoDelivered = max(0, loaded - run.raiderHits * ceil(loaded * 0.1))` where `loaded = min(effectiveCargo, amount)`.
- Suite + typecheck green from server/ before every commit; node --check on edited client files; escapeHtml on client HTML; dev mode untouched.

---

### Task 1: Shared raider count + attack math

**Files:**
- Modify: `server/src/validation.ts`, `client/flightMath.js`, `client/flightMath.d.ts`
- Test: `server/test/validation.test.ts`, `server/test/client/flightMath.test.ts`

**Interfaces:**
- Produces (BOTH sides, identical):
  - `hash32(str)`: FNV-1a 32-bit (validation.ts gets its own local copy — do not import client code; comment `// mirror of client/flightMath.js hashSeed`; the client already has `hashSeed` — reuse it there).
  - `export function raiderCount(missionId: string, distance: number, cargo: string): number` — formula per Global Constraints (`Math.min(3, …)`).
  - `export const attackSkill = (crew) => Math.min(crew.reduce((s,c)=>s+(c.skills?.attack ?? 0),0), 50);` (both sides)
  - client-only: `export const cannonDamage = (atk) => 1 + Math.floor(atk / 25);` `export const cannonCooldown = (atk) => 0.8 * (1 - atk / 100);`

- [ ] **Step 1: Failing tests**

`server/test/validation.test.ts` add:
```ts
import { raiderCount, attackSkill } from '../src/validation.js';

describe('raider count', () => {
  it('no raiders on short routes', () => {
    expect(raiderCount('m1', 120, 'LOG')).toBe(0);
    expect(raiderCount('m1', 60, 'FIRERUNE')).toBe(0);
  });
  it('1-3 raiders beyond 120, deterministic, FIRERUNE +1, cap 3', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const n = raiderCount(id, 200, 'LOG');
      expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(2);
      expect(raiderCount(id, 200, 'LOG')).toBe(n); // deterministic
      expect(raiderCount(id, 200, 'FIRERUNE')).toBe(Math.min(3, n + 1));
    }
  });
});
describe('attack skill', () => {
  it('caps at 50', () => {
    expect(attackSkill([{ skills: { attack: 30 } } as any, { skills: { attack: 30 } } as any])).toBe(50);
    expect(attackSkill([])).toBe(0);
  });
});
```
`server/test/client/flightMath.test.ts` add:
```ts
import { raiderCount as clientRaiderCount, cannonDamage, cannonCooldown } from '../../../client/flightMath.js';
import { raiderCount as serverRaiderCount } from '../../src/validation.js';

describe('combat math mirrors', () => {
  it('client and server agree on raider counts', () => {
    for (let i = 0; i < 50; i++) {
      const id = `m-${i}`, d = 60 + i * 6;
      for (const cargo of ['LOG', 'FIRERUNE']) {
        expect(clientRaiderCount(id, d, cargo)).toBe(serverRaiderCount(id, d, cargo));
      }
    }
  });
  it('cannon math follows attack skill', () => {
    expect(cannonDamage(0)).toBe(1); expect(cannonDamage(25)).toBe(2); expect(cannonDamage(50)).toBe(3);
    expect(cannonCooldown(0)).toBeCloseTo(0.8); expect(cannonCooldown(50)).toBeCloseTo(0.4);
  });
});
```

- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement** — validation.ts:
```ts
// mirror of client/flightMath.js hashSeed (FNV-1a 32-bit)
function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Raiders ambush long routes. The count is deterministic so the server can
// bound bounty claims without simulating combat.
export function raiderCount(missionId: string, distance: number, cargo: string): number {
  if (distance <= 120) return 0;
  return Math.min(3, 1 + (hash32(`${missionId}:raiders`) % 2) + (cargo === 'FIRERUNE' ? 1 : 0));
}

export const attackSkill = (crew: Pick<CrewMember, 'skills'>[]) =>
  Math.min(crew.reduce((s, c) => s + (c.skills?.attack ?? 0), 0), 50);
```
flightMath.js mirrors `raiderCount` using its existing `hashSeed`, plus `attackSkill`, `cannonDamage`, `cannonCooldown`. Update flightMath.d.ts.
- [ ] **Step 4: Full suite + typecheck; node --check flightMath.js.**
- [ ] **Step 5: Commit** — `git commit -m "feat: raider count + attack math — one formula, both sides"`

---

### Task 2: Server — bounty, bounded

**Files:**
- Modify: `server/src/validation.ts` (Telemetry/RunParams + rule), `server/src/missions.ts` (complete)
- Test: `server/test/validation.test.ts`, `server/test/missions.test.ts`

**Interfaces:**
- Produces: `Telemetry` gains `raidersDestroyed?: number`; `RunParams` gains `missionId: string; cargo: string`; `validateRun` new rule (after the cargo rule): reject unless `Number.isInteger(kills) && kills >= 0 && kills <= raiderCount(params.missionId, params.distance, params.cargo)` where `const kills = t.raidersDestroyed ?? 0;` reason `'more raider kills than raiders'`. `MissionEngine.complete()` passes `{ distance: m.distance, missionAmount: m.amount, missionId: m.id, cargo: m.cargo }` and computes `const bounty = 3 * (telemetry.raidersDestroyed ?? 0);` folded into `rewardGold` (with the existing hazard term) before shares. Plan-authorized: all existing `validateRun(...)` test call sites gain `missionId: 'x', cargo: 'LOG'` (distances ≤120 in those fixtures → rule is a no-op for them; verify, adjust the one 148-distance app round-trip if it exists by passing kills 0 — absent field is 0, fine).

- [ ] **Step 1: Failing tests**

validation.test.ts:
```ts
it('rejects kill claims beyond the deterministic raider count', () => {
  const p = { distance: 200, missionAmount: 5, missionId: 'mx', cargo: 'LOG' };
  const max = raiderCount('mx', 200, 'LOG');
  const base = { durationS: 25, fuelSpent: 200, cargoDelivered: 5 };
  expect(validateRun(p, ship, [], { ...base, raidersDestroyed: max }).ok).toBe(true);
  expect(validateRun(p, ship, [], { ...base, raidersDestroyed: max + 1 }).ok).toBe(false);
  expect(validateRun(p, ship, [], { ...base, raidersDestroyed: -1 }).ok).toBe(false);
  expect(validateRun({ ...p, distance: 100 }, ship, [], { durationS: 12, fuelSpent: 100, cargoDelivered: 5, raidersDestroyed: 1 }).ok).toBe(false);
});
```
missions.test.ts:
```ts
it('raider kills pay bounty inside the shared reward', () => {
  let m; // generate until distance > 120 (batch of 40)
  for (let i = 0; i < 40 && !m; i++) { const [c] = engine.generate(1); if (c.distance > 120) m = c; }
  expect(m).toBeDefined();
  engine.accept(m.id, 'alice', 'ship-1', []);
  const kills = raiderCount(m.id, m.distance, m.cargo);
  const delivered = Math.min(20, m.amount);
  const payout = engine.complete(m.id, {
    durationS: m.distance / 10 + 1, fuelSpent: m.distance, cargoDelivered: delivered, raidersDestroyed: kills,
  });
  expect(payout.rewardGold).toBe(delivered * TOKENS[m.cargo].unitPriceGold
    + Math.floor(hazardPay(m.distance) * delivered / m.amount) + 3 * kills);
});
```
(import raiderCount/TOKENS/hazardPay as needed; alice needs enough FUEL — the beforeEach seeds 400, distances ≤300, fine.)

- [ ] **Step 2-4:** RED → implement → full suite + typecheck green.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): raider bounty — 3 GOLD per kill, bounded by the seeded count"`

---

### Task 3: Client combat model (pure)

**Files:**
- Modify: `client/flightMath.js`, `client/flightMath.d.ts`
- Test: `server/test/client/flightMath.test.ts`

**Interfaces:**
- Produces:
  - `mkWorld(seedStr, distance, cargo = 'LOG')` gains `raiders: { x: number; y: number; z: number; hp: number }[]` — `raiderCount(seedStr, distance, cargo)` of them, deterministically placed with the world rng at `z ∈ (distance * 0.45, distance - 40)`, `x ∈ (-100, 100)`, `y ∈ (-15, 15)`, `hp: 2`. (Draw raider placement rng AFTER islands so existing rock/island layouts stay byte-identical for old seeds — assert in tests.)
  - `mkRun` gains `attack: attackSkill(crew)`, `kills: 0`, `raiderHits: 0`.
  - `export function applyRaiderHit(run, rand = Math.random): 'dodged' | 'hit'` — dodge if `rand() < run.defense / 100`; on hit: `run.hull -= 1; run.raiderHits += 1;` (dry/void outcomes still resolved by stepRun's checks next tick; also set `run.done/outcome='void'` immediately when hull ≤ 0 to match stepRun semantics).
  - `export function registerKill(run): void` — `run.kills += 1`.
  - `telemetry(run, mission, ship)`: `loaded = min(ship.cargo + run.hauling, mission.amount)`; `spill = run.raiderHits * Math.ceil(loaded * 0.1)`; `cargoDelivered = Math.max(0, loaded - spill)`; `raidersDestroyed = Math.min(run.kills, raiderCount(mission.id ?? '', mission.distance, mission.cargo ?? 'LOG'))` — include the field only when > 0 OR always (always is simpler; absent==0 server-side, but always-present is fine — emit always).

- [ ] **Step 1: Failing tests**
```ts
describe('combat model', () => {
  it('raiders spawn only beyond 120 and deterministically', () => {
    expect(mkWorld('m1', 100, 'LOG').raiders).toEqual([]);
    const w = mkWorld('m1', 200, 'LOG');
    expect(w.raiders.length).toBe(clientRaiderCount('m1', 200, 'LOG'));
    expect(mkWorld('m1', 200, 'LOG')).toEqual(w);
    for (const r of w.raiders) {
      expect(r.z).toBeGreaterThan(200 * 0.45); expect(r.z).toBeLessThan(160); expect(r.hp).toBe(2);
    }
  });
  it('old worlds unchanged by the raider draw', () => {
    const w = mkWorld('short', 70); // pre-combat test world
    expect(w.raiders).toEqual([]);
    expect(w.rocks.length).toBeGreaterThan(0); // still rocky as before
  });
  it('hits spill cargo and can breach the hull; dodge protects', () => {
    const ship = { id: 's', owner: 'a', engine: 10, cargo: 20, crewSlots: 2 };
    const run = mkRun(ship, [], 200, 1000);
    expect(applyRaiderHit(run, () => 0.99)).toBe('hit');
    expect(run.raiderHits).toBe(1); expect(run.hull).toBe(2);
    const guarded = mkRun(ship, [{ id: 'w', skills: { defense: 90 } }], 200, 1000);
    expect(applyRaiderHit(guarded, () => 0.5)).toBe('dodged');
    const t = telemetry(run, { id: 'm1', amount: 20, distance: 200, cargo: 'LOG' }, ship);
    expect(t.cargoDelivered).toBe(20 - Math.ceil(20 * 0.1));
  });
  it('kill reports clamp to the seeded count', () => {
    const ship = { id: 's', owner: 'a', engine: 10, cargo: 20, crewSlots: 2 };
    const run = mkRun(ship, [], 200, 1000);
    for (let i = 0; i < 10; i++) registerKill(run);
    const t = telemetry(run, { id: 'm1', amount: 5, distance: 200, cargo: 'LOG' }, ship);
    expect(t.raidersDestroyed).toBe(clientRaiderCount('m1', 200, 'LOG'));
  });
});
```
- [ ] **Step 2-4:** RED → implement → suite + typecheck + node --check green (the existing dt-sweep/loop tests pass 2-arg mkWorld — default cargo keeps them green; hull-breach immediate-void keeps parity with stepRun).
- [ ] **Step 5: Commit** — `git commit -m "feat(client): combat model — spawns, spills, kills, clamps"`

---

### Task 4: The fight itself (flight.js)

**Files:**
- Modify: `client/flight.js`, `styles.css` (HUD combat bits)
- Test: smoke only (node --check + boot + screenshot; pure logic already tested)

**Interfaces:**
- Consumes: `world.raiders`, `applyRaiderHit`, `registerKill`, `cannonDamage`, `cannonCooldown`, `run.attack`.
- Produces, inside the flight scene:
  - Raider meshes: reuse the wire-ship construction scaled 1.2×, phosphor at 0.9 alpha; store `{ mesh, hp, pos: Vector3, fireAt: number }` per world.raiders entry.
  - Raider AI per frame: move toward a point 35u ahead of the player at speed 9 u/s; every 2.2s spawn a raider bolt (line segment, length 4, speed 60 u/s toward the player's current position, max age 4s).
  - Player cannon: SPACE fires when `now >= nextShot`; bolt speed 120 forward along heading; `nextShot = now + cannonCooldown(run.attack) * 1000`.
  - Hits: player bolt within 8u of a raider → `hp -= cannonDamage(run.attack)`; hp ≤ 0 → `registerKill(run)`, dispose mesh, remove. Raider bolt within 6u of the camera/player → `applyRaiderHit(run)`; on 'hit' flash the HUD (add/remove a `.hud-hit` class on the overlay for 150ms).
  - HUD adds: `RAIDERS <n>` counter (updates on kills) and a cannon-ready dot: `<span id="hud-gun">●</span>` dimmed while cooling (opacity via style).
  - All combat objects disposed in the existing debrief-close traversal (they're scene children — verify bolts are too).
  - Debrief: when `run.kills > 0`, add a line `RAIDERS DESTROYED ${run.kills} — BOUNTY +${run.kills * 3} G` (payout already includes it server-side).
- styles.css: `.hud-hit #flight-overlay`—simplest: `#flight-overlay.hud-hit { box-shadow: inset 0 0 80px rgba(255,98,71,0.5); }` and `#hud-gun { transition: opacity 0.1s; }`.

- [ ] **Step 1: Implement** per the interface block, following flight.js's existing style (module-scope helpers, the singleton renderer, the keys object — add `' '` handling; prevent page scroll: `e.preventDefault()` for Space inside the flight only).
- [ ] **Step 2: Verify** — from server/: full suite + typecheck (unchanged server code); `node --check client/flight.js`; boot smoke on :8430 → /app/ 200 and flight.js served contains `raiders`; kill server. Headless screenshot of /app/ still renders.
- [ ] **Step 3: Commit** — `git commit -m "feat(client): the fight — raiders, cannon, spills, bounty debrief"`

---

### Task 5: Seal + docs

**Files:**
- Test: `server/test/client/loop.test.ts` (extend)
- Modify: `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (§5.6 combat sentence; §7 kill-bound sentence; §9 remove the no-combat cut line)

**Interfaces:** consumes everything.

- [ ] **Step 1: The seal (must pass as written):**
```ts
it('a long run with a full raider wipe pays the bounty through the API', async () => {
  const app = buildApp();
  const h = { 'x-wallet': 'gun' };
  await app.inject({ method: 'POST', url: '/login', headers: h });
  await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 50 } });
  const missions = (await app.inject({ method: 'POST', url: '/missions/generate', headers: h, payload: { count: 40 } })).json();
  const m = missions.find((x: any) => x.distance > 120)!;
  expect(m).toBeDefined();
  await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: h, payload: { shipId: 'gun-freighter', crewIds: [] } });
  const ship = { id: 'gun-freighter', owner: 'gun', engine: 12, cargo: 18, crewSlots: 2 };
  const world = mkWorld(m.id, m.distance, m.cargo); world.rocks = [];
  const run = mkRun(ship, [], m.distance, 5000);
  for (const _ of world.raiders) registerKill(run); // wipe them without taking hits
  while (!run.done) stepRun(run, 1 / 60, { yaw: 0, throttle: 1 }, world);
  const t = telemetry(run, m, ship);
  expect(t.raidersDestroyed).toBe(world.raiders.length);
  const done = await app.inject({ method: 'POST', url: `/missions/${m.id}/complete`, headers: h, payload: { telemetry: t } });
  expect(done.statusCode).toBe(200);
  expect(done.json().rewardGold).toBeGreaterThanOrEqual(3 * world.raiders.length);
});

it('over-claimed kills are rejected by the server', async () => {
  // same setup shape; telemetry with raidersDestroyed = raiderCount + 1 → 400 /more raider kills/
});
```
(Write the second test fully: same generate/accept flow, hand-built valid telemetry except `raidersDestroyed: serverRaiderCount(m.id, m.distance, m.cargo) + 1`, expect 400 and error match. Import raiderCount from ../../src/validation.js. Note raiders may be [] if… distance > 120 guarantees ≥1.)
- [ ] **Step 2:** Run seal + full suite + typecheck (must pass; drift = fix client side).
- [ ] **Step 3: Spec edits** (three one-liners; §9's "no raiders/shooting" cut line becomes "shipped 2026-07-14").
- [ ] **Step 4: Commit** — `git commit -m "test: combat seal — bounty through the API, over-claims rejected"`

---

## Self-review notes

- Money-cheat ceiling honored: bounty ≤ 9 G/run, server-derived count, kills validated in validateRun (T2) AND clamped client-side (T3).
- Type consistency: `raiderCount(missionId, distance, cargo)` same 3-arg shape both sides (T1) used in T2 rule, T3 clamp, T5 seal; `RunParams.missionId/cargo` threaded through complete() (T2); mkWorld 3rd arg optional keeps every earlier test valid.
- Determinism protected: T3 test pins old worlds byte-stable (raider rng drawn last).
- YAGNI: no raider loot tables, no ammo economy, no PvP — raiders die or you flee.
