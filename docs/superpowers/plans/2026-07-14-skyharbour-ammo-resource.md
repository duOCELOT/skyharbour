# Skyharbour Ammo Resource Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ammunition becomes the seventh token — every shot costs a shell, shells cost GOLD, and kill claims must be backed by shells actually burned.

**Architecture:** AMMO joins tokens.ts (kind `ammo`); the pump generalizes to an armory (`buyProvision`); grants add starter shells; `validateRun` gains two ammo rules (rate cap ≈ 2.5 shots/s of flight time; kills × shots-to-kill ≤ shells spent, via a server mirror of `cannonDamage`); complete/fail burn reported shells like fuel; client tracks a shell budget from the live balance and dry-fires at zero.

**Tech Stack:** unchanged.

## Global Constraints

- Locked numbers: `AMMO_PER_GOLD = 2`; `STARTER_AMMO = 20`; 1 shell per shot; server rate cap `ammoSpent ≤ ceil(durationS * 2.5) + 1`; kill consistency `kills * ceil(2 / cannonDamage(attackSkill(crew))) ≤ ammoSpent`; burns clamp to the pilot's AMMO balance (complete AND fail; fail additionally caps at 100).
- `Telemetry.ammoSpent?: number` optional (absent = 0) — all pre-ammo telemetry stays valid, and 0 kills with 0 shells passes trivially.
- AMMO is claimable/chain-generic automatically (isTokenId-driven); the bootstrap TOKENS list gains `'AMMO'` (idempotent script mints only the missing one — operator runs it post-merge).
- Ticker/manifest always show AMMO alongside FUEL/GOLD (authorized render-test updates).
- Suite + typecheck from server/ green before every commit; node --check on edited client files; escapeHtml conventions; dev mode compatible (server untouched behavior for ammo-less callers).

---

### Task 1: AMMO token, armory, starter shells (server)

**Files:**
- Modify: `server/src/tokens.ts`, `server/src/pump.ts`, `server/src/grants.ts`, `server/src/app.ts` (route)
- Test: `server/test/tokens.test.ts`, `server/test/pump.test.ts`, `server/test/grants.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Produces:
  - tokens.ts: `TokenId` union gains `'AMMO'`; `TOKENS.AMMO = { id: 'AMMO', kind: 'ammo', unitPriceGold: 0 }`; `TokenInfo.kind` union gains `'ammo'`; `CARGO_TOKENS` unchanged in content (filter already excludes non-cargo).
  - pump.ts: `export const RATES: Record<'FUEL' | 'AMMO', number> = { FUEL: 4, AMMO: 2 };` and `export function buyProvision(ledger: Ledger, wallet: string, gold: number, token: 'FUEL' | 'AMMO'): { credited: number }` — same validation/overflow guards and atomic legs as buyFuel (GOLD→settlement, mint→wallet at `RATES[token]`); `buyFuel(ledger, wallet, gold)` becomes `const r = buyProvision(ledger, wallet, gold, 'FUEL'); return { fuelCredited: r.credited };` (back-compat).
  - grants.ts: `export const STARTER_AMMO = 20;` — starter grant legs gain `mint −20 AMMO / wallet +20 AMMO`.
  - app.ts: `app.post('/ammo/buy', …)` → `buyProvision(ledger, walletOf(req), gold, 'AMMO')` returning `{ credited }`.

- [ ] **Step 1: Failing tests**

tokens.test.ts: token list test gains `'AMMO'` (7 ids, sorted list updated — authorized); `TOKENS.AMMO.kind === 'ammo'`; CARGO_TOKENS still the four cargos.
pump.test.ts:
```ts
it('sells ammo at 1 GOLD = 2 shells into the same treasury', () => {
  const r = buyProvision(ledger, 'alice', 10, 'AMMO');
  expect(r.credited).toBe(20);
  expect(ledger.balance('wallet:alice', 'AMMO')).toBe(20);
  expect(ledger.balance('settlement', 'GOLD')).toBe(10);
});
it('buyFuel alias unchanged', () => {
  expect(buyFuel(ledger, 'alice', 5).fuelCredited).toBe(20);
});
```
grants.test.ts: starter grant test asserts `ledger.balance('wallet:alice', 'AMMO')` === `STARTER_AMMO` (import it).
app.test.ts:
```ts
it('sells ammo over HTTP', async () => {
  await app.inject({ method: 'POST', url: '/login', headers: asAlice });
  const res = await app.inject({ method: 'POST', url: '/ammo/buy', headers: asAlice, payload: { gold: 5 } });
  expect(res.json().credited).toBe(10);
});
```

- [ ] **Step 2-4:** RED → implement → full suite + typecheck (renderTicker tests may reference balances objects — unaffected until Task 4).
- [ ] **Step 5: Commit** — `git commit -m "feat(server): AMMO — seventh token, armory rates, starter shells"`

---

### Task 2: Shell-backed combat validation + burns (server)

**Files:**
- Modify: `server/src/validation.ts`, `server/src/missions.ts`, `server/src/app.ts` (fail body)
- Test: `server/test/validation.test.ts`, `server/test/missions.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Produces:
  - validation.ts: `export const cannonDamage = (atk: number) => 1 + Math.floor(atk / 25);` (comment: mirror of client/flightMath.js) and `export const shotsToKill = (atk: number) => Math.ceil(2 / cannonDamage(atk));` `Telemetry` gains `ammoSpent?: number`. New rules in validateRun (after the kill rule): with `const shells = t.ammoSpent ?? 0;` reject unless `Number.isInteger(shells) && shells >= 0`; reject if `shells > Math.ceil(t.durationS * 2.5) + 1` (reason `'more shells than the trigger allows'`); reject if `kills * shotsToKill(attackSkill(crew)) > shells` (reason `'kills claimed without shells spent'`).
  - missions.ts complete(): burn legs `wallet −a AMMO / burn +a AMMO` where `a = Math.min(Math.ceil(telemetry.ammoSpent ?? 0), this.ledger.balance(...AMMO))` when a > 0 (same atomic post). fail(id, fuelSpent = 0, ammoSpent = 0): validates ammoSpent finite ≥ 0, burns `min(ceil(ammoSpent), balance, 100)` in the same post.
  - app.ts fail route: body gains optional ammoSpent → `missions.fail(id, fuelSpent ?? 0, ammoSpent ?? 0)`.

- [ ] **Step 1: Failing tests**

validation.test.ts:
```ts
it('shells are bounded by trigger time and kills need shells', () => {
  const p = { distance: 200, missionAmount: 5, missionId: 'mx', cargo: 'LOG' };
  const kills = raiderCount('mx', 200, 'LOG');
  const base = { durationS: 25, fuelSpent: 200, cargoDelivered: 5 };
  expect(validateRun(p, ship, [], { ...base, raidersDestroyed: kills, ammoSpent: kills * 2 }).ok).toBe(true);
  expect(validateRun(p, ship, [], { ...base, raidersDestroyed: kills, ammoSpent: 0 }).ok).toBe(false); // kills w/o shells
  expect(validateRun(p, ship, [], { ...base, ammoSpent: Math.ceil(25 * 2.5) + 2 }).ok).toBe(false); // trigger cap
  expect(validateRun(p, ship, [], { ...base, ammoSpent: 2.5 }).ok).toBe(false); // fractional
});
```
(no-kill no-shell legacy telemetry stays valid — existing tests prove it by omission.)
missions.test.ts:
```ts
it('spent shells burn on completion, clamped to balance', () => {
  // fund alice with 10 AMMO via ledger seed; complete a >120 mission with kills matching shells 4
  // assert wallet AMMO dropped by 4 and burn account gained 4
});
it('fail burns reported shells too, capped', () => { /* fail(m.id, 10, 6) → AMMO -6 */ });
```
Write both concretely following the file's seed/accept/complete pattern (fund AMMO in the beforeEach seed post: mint −40 AMMO / alice +40).
app.test.ts: fail with `{ fuelSpent: 5, ammoSpent: 3 }` burns both (balances before/after).

- [ ] **Step 2-4:** RED → implement → green.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): shells burn and kills need shells — combat is provisioned"`

---

### Task 3: Client model + api (pure)

**Files:**
- Modify: `client/flightMath.js`, `client/flightMath.d.ts`, `client/api.js`, `client/api.d.ts`
- Test: `server/test/client/flightMath.test.ts`, `server/test/client/api.test.ts`

**Interfaces:**
- Produces:
  - flightMath: `mkRun(ship, crew, distance, fuelBudget, ammoBudget = 0)` — run gains `ammoBudget`, `shots: 0`. `export function fireShot(run): boolean` — false when `run.done` or `run.shots >= run.ammoBudget`, else `run.shots += 1; return true`. `telemetry()` gains `ammoSpent: run.shots`.
  - api: `export const buyAmmo = (gold) => api('/ammo/buy', { method: 'POST', body: { gold } });`; `failMission(id, fuelSpent = 0, ammoSpent = 0)` posts both.

- [ ] **Step 1: Failing tests**

flightMath.test.ts:
```ts
it('the trigger obeys the shell budget', () => {
  const run = mkRun(ship, [], 200, 1000, 2);
  expect(fireShot(run)).toBe(true);
  expect(fireShot(run)).toBe(true);
  expect(fireShot(run)).toBe(false); // dry
  const t = telemetry(run, { id: 'm1', amount: 5, distance: 200, cargo: 'LOG' }, ship);
  expect(t.ammoSpent).toBe(2);
});
it('no shots fired reports zero shells', () => {
  const run = mkRun(ship, [], 100, 1000);
  const t = telemetry(run, { amount: 5, distance: 100 }, ship);
  expect(t.ammoSpent).toBe(0);
});
```
api.test.ts: buyAmmo posts `{gold: 7}` to /ammo/buy; failMission(id, 5, 3) posts `{ fuelSpent: 5, ammoSpent: 3 }`.

- [ ] **Step 2-4:** RED → implement → green (+ node --check, d.ts updates).
- [ ] **Step 5: Commit** — `git commit -m "feat(client): shell budget in the model — fireShot, ammoSpent, armory api"`

---

### Task 4: Client UI — armory, dry trigger, HUD shells

**Files:**
- Modify: `client/flight.js`, `client/bridge.js`, `client/render.js`, `index.html`, `styles.css`
- Test: `server/test/client/render.test.ts` (ticker/manifest AMMO — authorized updates); smoke for the rest

**Interfaces:**
- flight.js: launch passes `bal.AMMO ?? 0` as mkRun's 5th arg (it already fetches balances for fuel); SPACE path calls `fireShot(run)` — only spawn a bolt when true (dry: no bolt; set the gun dot to a dim red for 200ms via inline style); HUD gains `SHELLS <n>` (`run.ammoBudget - run.shots`); debrief fail path sends `failMission(mission.id, Math.ceil(run.fuel), run.shots)`; landed path telemetry already carries ammoSpent.
- bridge.js: pump handler generalizes — buttons carry `data-token="FUEL"|"AMMO"`; handler calls buyFuel/buyAmmo by token and says `TANKS +N FUEL` / `MAGAZINE +N SHELLS`.
- index.html: the `#fuel-pump` div becomes `#provisions` — title `PROVISIONS — 1G = 4 FUEL · 2 SHELLS`, keeps the three fuel buttons (data-token FUEL) and adds `5 G` / `10 G` shell buttons (data-token AMMO). Keep the `#fuel-pump` id as an alias? NO — update any selector references (grep bridge.js/styles.css) to `#provisions`.
- render.js: `renderTicker` always shows `AMMO n` after FUEL; `renderManifest` row for AMMO always. Authorized: update the two render tests' expectations.

- [ ] **Step 1:** RED the render tests (`renderTicker({ ...bal, AMMO: 12 })` contains 'AMMO 12'; manifest row) → implement all per interfaces.
- [ ] **Step 2:** Full suite + typecheck; node --check flight.js/bridge.js/render.js; boot smoke :8432 → /app/ 200, served index contains `provisions` once and `data-token="AMMO"`.
- [ ] **Step 3: Commit** — `git commit -m "feat(client): armory provisions, dry trigger, shells on the HUD"`

---

### Task 5: Seal + chain + docs

**Files:**
- Test: `server/test/client/loop.test.ts` (extend)
- Modify: `server/scripts/bootstrap-devnet.ts` (TOKENS gains 'AMMO'), `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (§3 row, §6 sink line)

**Interfaces:** consumes everything.

- [ ] **Step 1: Seal test (must pass as written):** extend the combat seal — the raider-wipe run now buys ammo first (`POST /ammo/buy { gold: 10 }` → 20 shells), passes `20` as mkRun's ammoBudget, calls `fireShot(run)` twice per registered kill BEFORE registerKill (shells then kills), completes, and asserts: 200 status, AMMO balance dropped by exactly `t.ammoSpent`, and rewardGold ≥ 3 × kills. Also the negative: kills with `ammoSpent: 0` hand-built telemetry → 400 `/without shells/`.
- [ ] **Step 2:** bootstrap-devnet.ts TOKENS array gains `'AMMO'` (type the array as the tokens.ts union import if convenient, else keep the local literal — must match tokens.ts ids). Do NOT run it (operator/controller runs post-merge).
- [ ] **Step 3:** Spec §3 table row for AMMO (`SPL fungible — the trigger's cost; bought at the armory`), §6 sinks line gains shells.
- [ ] **Step 4:** Full suite + typecheck; commit `git commit -m "test: shells seal the combat economy; AMMO joins the genesis mints"`.

---

## Self-review notes

- Every decision costs: shells at accept-time planning (T1 armory), in-flight (T3/T4 dry trigger), at settlement (T2 burns + validation). Kill claims now consume purchased resources — the bounty cheat ceiling gains a real cost.
- Type consistency: `buyProvision`/RATES (T1) ← route (T1) ← api buyAmmo (T3) ← bridge (T4); `ammoSpent` optional through Telemetry (T2) ↔ telemetry() (T3) ↔ seal (T5); `fireShot` (T3) ← flight.js (T4); fail 3-arg chain (T2 server ↔ T3 api ↔ T4 flight).
- Management levers deferred by owner decision (hull repair, crew retainers, maintenance) — logged in tracker by the controller, not in this plan.
