# Skyharbour Improve Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Longer missions that pay hazard money, a GOLD→FUEL pump feeding the settlement treasury, NPC harbour crew with real skills applied in-flight, and per-wallet test fleets — owner-approved design, numbers tunable later.

**Architecture:** All changes ride existing seams: `DevFleet` synthesizes a deterministic three-ship test fleet per wallet; `MissionEngine.generate/complete` gain a distance-scaled hazard-pay term; a tiny `pump.ts` module moves GOLD→settlement and mints FUEL atomically through the existing `Ledger`; `CrewMarket.listings()` joins skills from the fleet so the client sim can honor hired crew; bridge/flight consume the richer listings.

**Tech Stack:** unchanged (TypeScript Fastify server, vanilla ES-module client, Vitest).

## Global Constraints

- Locked numbers (owner-approved 2026-07-13): mission distance `60 + floor(r*241)` (60–300); hazard pay `ceil(distance/4)` GOLD, paid only when `delivered > 0`; fuel rate `FUEL_PER_GOLD = 4`; NPC crew shares as listed in Task 1; test-fleet stats HAULER 8/32/3, COURIER 18/8/1, FREIGHTER 12/18/2.
- Fuel-pump money flow (spec §6 fuel pool): buyer's GOLD → `settlement` account; FUEL minted from `mint` → buyer. One atomic `ledger.post`.
- All balances integers; `Number.isSafeInteger` on request amounts; dev header auth unchanged; no Solana code.
- Every data string rendered via `escapeHtml` (client convention).
- Existing tests stay green EXCEPT two owner-of-this-plan updates, each justified in its task: the missions generation reward assertion (reward formula deliberately changes) and `loop.test.ts`'s fuel budget 300→2000 (test input; generated distances now reach 300, and with skill-0 crews fuel≈distance would race the dry threshold at exactly 300).
- Run tests + `npm run typecheck` from `server/` before every commit.

---

### Task 1: Test fleets + NPC harbour crew (fleet.ts)

**Files:**
- Modify: `server/src/fleet.ts`
- Test: `server/test/fleet.test.ts` (extend)

**Interfaces:**
- Consumes: existing `Ship`, `CrewMember`, `FleetSource`, `DevFleet`, `devFixtures`.
- Produces:
  - Every wallet (known or not) owns a synthesized trio in addition to any fixture ships: ids `${wallet}-hauler` (engine 8, cargo 32, crewSlots 3), `${wallet}-courier` (18/8/1), `${wallet}-freighter` (12/18/2). `DevFleet.getShip` resolves synthesized ids by parsing the `-hauler|-courier|-freighter` suffix.
  - `export const HARBOUR = 'harbour';`
  - `export const NPC_CREW: { member: CrewMember; sharePct: number }[]` — six members owned by `HARBOUR`: `npc-stoker` {fuel:35} @10, `npc-greaser` {fuel:20} @12, `npc-warden` {defense:35} @15, `npc-shieldhand` {defense:20} @18, `npc-veteran` {fuel:15,defense:15} @22, `npc-magsman` {attack:25,defense:10} @25.
  - `devFixtures()` now also includes the six NPC members in its `crew` array (so `DevFleet.getCrew`/`crewOf(HARBOUR)` resolve them).

- [ ] **Step 1: Extend the test (failing)**

Append to `server/test/fleet.test.ts`:
```ts
import { HARBOUR, NPC_CREW } from '../src/fleet.js';

describe('test fleets', () => {
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);

  it('synthesizes a deterministic trio for any wallet', () => {
    const mine = fleet.shipsOf('zed');
    const ids = mine.map((s) => s.id).sort();
    expect(ids).toEqual(['zed-courier', 'zed-freighter', 'zed-hauler']);
    const hauler = mine.find((s) => s.id === 'zed-hauler')!;
    expect([hauler.engine, hauler.cargo, hauler.crewSlots]).toEqual([8, 32, 3]);
  });

  it('known wallets keep fixtures plus the trio', () => {
    const alices = fleet.shipsOf('alice');
    expect(alices.some((s) => s.id === 'ship-1')).toBe(true);
    expect(alices.some((s) => s.id === 'alice-courier')).toBe(true);
  });

  it('getShip resolves synthesized ids with correct ownership', () => {
    expect(fleet.getShip('zed-courier')).toEqual({ id: 'zed-courier', owner: 'zed', engine: 18, cargo: 8, crewSlots: 1 });
    expect(fleet.getShip('zed-frigate')).toBeUndefined();
  });

  it('harbour owns the six NPC crew', () => {
    expect(NPC_CREW).toHaveLength(6);
    for (const { member, sharePct } of NPC_CREW) {
      expect(member.owner).toBe(HARBOUR);
      expect(fleet.getCrew(member.id)?.owner).toBe(HARBOUR);
      expect(sharePct).toBeGreaterThanOrEqual(10);
      expect(sharePct).toBeLessThanOrEqual(25);
    }
    expect(fleet.getCrew('npc-stoker')?.skills.fuel).toBe(35);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/skyharbour/server && npx vitest run test/fleet.test.ts`
Expected: FAIL — HARBOUR/NPC_CREW not exported, trio missing.

- [ ] **Step 3: Implement**

In `server/src/fleet.ts` add after the interfaces:
```ts
export const HARBOUR = 'harbour';

// Deterministic per-wallet test fleet — stands in for ship NFTs until the
// chain gateway (plan 2) reads real collections. Ids are wallet-scoped so
// ownership checks hold.
const TRIO: [string, number, number, number][] = [
  ['hauler', 8, 32, 3],
  ['courier', 18, 8, 1],
  ['freighter', 12, 18, 2],
];

function trioFor(wallet: string): Ship[] {
  return TRIO.map(([kind, engine, cargo, crewSlots]) => (
    { id: `${wallet}-${kind}`, owner: wallet, engine, cargo, crewSlots }
  ));
}

export const NPC_CREW: { member: CrewMember; sharePct: number }[] = [
  { member: { id: 'npc-stoker', owner: HARBOUR, skills: { fuel: 35 } }, sharePct: 10 },
  { member: { id: 'npc-greaser', owner: HARBOUR, skills: { fuel: 20 } }, sharePct: 12 },
  { member: { id: 'npc-warden', owner: HARBOUR, skills: { defense: 35 } }, sharePct: 15 },
  { member: { id: 'npc-shieldhand', owner: HARBOUR, skills: { defense: 20 } }, sharePct: 18 },
  { member: { id: 'npc-veteran', owner: HARBOUR, skills: { fuel: 15, defense: 15 } }, sharePct: 22 },
  { member: { id: 'npc-magsman', owner: HARBOUR, skills: { attack: 25, defense: 10 } }, sharePct: 25 },
];
```
Change `DevFleet.shipsOf` and `getShip`:
```ts
  shipsOf(wallet: string): Ship[] {
    return [...this.ships.filter((s) => s.owner === wallet), ...trioFor(wallet)];
  }
  getShip(id: string): Ship | undefined {
    const fixture = this.ships.find((s) => s.id === id);
    if (fixture) return fixture;
    const m = id.match(/^(.+)-(hauler|courier|freighter)$/);
    if (!m) return undefined;
    return trioFor(m[1]).find((s) => s.id === id);
  }
```
In `devFixtures()`, append to the returned `crew` array: `...NPC_CREW.map((n) => n.member)`.

- [ ] **Step 4: Run full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: all green (no existing assertion pins ship counts per wallet — verify; if one does, report it rather than editing it).

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/fleet.ts server/test/fleet.test.ts && git commit -m "feat(server): per-wallet test fleets + NPC harbour crew"
```

---

### Task 2: Longer missions with hazard pay (missions.ts)

**Files:**
- Modify: `server/src/missions.ts` (generate + complete)
- Test: `server/test/missions.test.ts` (one assertion update + one new test), `server/test/client/loop.test.ts` (budget 300→2000)

**Interfaces:**
- Consumes: existing `MissionEngine`.
- Produces: `Mission.distance ∈ [60, 300]`; `rewardGold = amount * unitPrice + ceil(distance/4)` at generation; payout `rewardGold = delivered * unitPrice + (delivered > 0 ? ceil(distance/4) : 0)`. `export const hazardPay = (distance: number) => Math.ceil(distance / 4);`

- [ ] **Step 1: Update/extend tests (failing)**

In `server/test/missions.test.ts`, the generation test currently asserts `expect(m.rewardGold).toBe(m.amount * 1)` — update it (justified: the reward formula deliberately changes in this plan):
```ts
import { hazardPay } from '../src/missions.js';
// in the generation test:
expect(m.rewardGold).toBe(m.amount * 1 + hazardPay(m.distance));
expect(m.distance).toBeGreaterThanOrEqual(60);
expect(m.distance).toBeLessThanOrEqual(300);
```
The "reward is proportional to delivered cargo" test asserts `payout.rewardGold).toBe(delivered * 1)` — update to `delivered * 1 + hazardPay(m.distance)`.
Add a new test:
```ts
it('hazard pay scales with distance and only pays when cargo lands', () => {
  expect(hazardPay(60)).toBe(15);
  expect(hazardPay(300)).toBe(75);
});
```
In `server/test/client/loop.test.ts` change `mkRun(ship, [], m.distance, 300)` to `mkRun(ship, [], m.distance, 2000)` with the comment `// generous test budget: generated distances now reach 300 and a skill-0 straight run burns fuel ≈ distance`.
Also in the crew-share test of missions.test.ts, shares are `floor(reward*pct/100)` computed from `payout.rewardGold` — that assertion derives from the payout value, so it stays valid; verify rather than edit.

- [ ] **Step 2: Run to verify failures**

Run: `cd ~/skyharbour/server && npx vitest run test/missions.test.ts test/client/loop.test.ts`
Expected: FAIL — hazardPay not exported; reward assertions mismatch.

- [ ] **Step 3: Implement**

In `server/src/missions.ts`:
```ts
export const hazardPay = (distance: number) => Math.ceil(distance / 4);
```
In `generate()`: `distance: 60 + Math.floor(Math.random() * 241), // 60..300` and `const rewardGold = amount * TOKENS[cargo].unitPriceGold + hazardPay(distance);` — note: compute `distance` before `rewardGold` (reorder the object literal into consts first: `const distance = 60 + Math.floor(Math.random() * 241);`).
In `complete()`: `const rewardGold = delivered * TOKENS[m.cargo].unitPriceGold + (delivered > 0 ? hazardPay(m.distance) : 0);`

- [ ] **Step 4: Run full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: all green (app.test round-trip uses live mission values — unaffected; flightMath sweep is generator-independent).

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/missions.ts server/test/missions.test.ts server/test/client/loop.test.ts && git commit -m "feat(server): missions run 60-300 with hazard pay"
```

---

### Task 3: The fuel pump (server)

**Files:**
- Create: `server/src/pump.ts`
- Modify: `server/src/app.ts` (route `POST /fuel/buy`)
- Test: `server/test/pump.test.ts`, `server/test/app.test.ts` (one HTTP test appended)

**Interfaces:**
- Consumes: `Ledger` from `ledger.ts`.
- Produces:
  - `export const FUEL_PER_GOLD = 4;`
  - `export function buyFuel(ledger: Ledger, wallet: string, gold: number): { fuelCredited: number }` — throws `Error('fuel purchase must be a positive integer of GOLD')` unless `Number.isSafeInteger(gold) && gold > 0`; one atomic `ledger.post('fuel pump <wallet>', legs)` with legs: `wallet:<w> -gold GOLD`, `settlement +gold GOLD`, `mint -gold*4 FUEL`, `wallet:<w> +gold*4 FUEL`. Insufficient GOLD surfaces the ledger's `InsufficientFunds`.
  - Route `POST /fuel/buy` body `{ gold: number }` → `{ fuelCredited }` (auth as usual; domain errors → 400 via the existing handler).

- [ ] **Step 1: Write the failing tests**

`server/test/pump.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../src/ledger.js';
import { buyFuel, FUEL_PER_GOLD } from '../src/pump.js';

let ledger: Ledger;
beforeEach(() => {
  ledger = new Ledger(new Database(':memory:'));
  ledger.post('seed', [
    { account: 'mint', token: 'GOLD', amount: -50 },
    { account: 'wallet:alice', token: 'GOLD', amount: 50 },
  ]);
});

describe('fuel pump', () => {
  it('converts GOLD to FUEL at the pool rate, GOLD lands in the settlement', () => {
    const r = buyFuel(ledger, 'alice', 10);
    expect(r.fuelCredited).toBe(10 * FUEL_PER_GOLD);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(40);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(40);
    expect(ledger.balance('settlement', 'GOLD')).toBe(10);
  });

  it('rejects zero, negative, and fractional purchases', () => {
    for (const bad of [0, -5, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buyFuel(ledger, 'alice', bad)).toThrow(/positive integer/);
    }
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(50);
  });

  it('rejects purchases beyond the wallet GOLD', () => {
    expect(() => buyFuel(ledger, 'alice', 51)).toThrow();
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(0);
  });
});
```
Append to `server/test/app.test.ts`:
```ts
it('sells fuel over HTTP', async () => {
  await app.inject({ method: 'POST', url: '/login', headers: asAlice });
  const res = await app.inject({ method: 'POST', url: '/fuel/buy', headers: asAlice, payload: { gold: 10 } });
  expect(res.statusCode).toBe(200);
  expect(res.json().fuelCredited).toBe(40);
  const bal = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json();
  expect(bal.GOLD).toBe(90);
  expect(bal.FUEL).toBe(340);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd ~/skyharbour/server && npx vitest run test/pump.test.ts test/app.test.ts`
Expected: FAIL — module/route missing.

- [ ] **Step 3: Implement**

`server/src/pump.ts`:
```ts
import { Ledger } from './ledger.js';

// The fuel pool made concrete (spec §6): entry fees accumulate in the
// settlement treasury; pilots buy FUEL back with GOLD at a flat rate.
export const FUEL_PER_GOLD = 4;

export function buyFuel(ledger: Ledger, wallet: string, gold: number): { fuelCredited: number } {
  if (!Number.isSafeInteger(gold) || gold <= 0) {
    throw new Error('fuel purchase must be a positive integer of GOLD');
  }
  const fuel = gold * FUEL_PER_GOLD;
  ledger.post(`fuel pump ${wallet}`, [
    { account: `wallet:${wallet}`, token: 'GOLD', amount: -gold },
    { account: 'settlement', token: 'GOLD', amount: gold },
    { account: 'mint', token: 'FUEL', amount: -fuel },
    { account: `wallet:${wallet}`, token: 'FUEL', amount: fuel },
  ]);
  return { fuelCredited: fuel };
}
```
In `server/src/app.ts`: `import { buyFuel } from './pump.js';` and add near the other POST routes:
```ts
  app.post('/fuel/buy', async (req) => {
    const { gold } = req.body as { gold: number };
    return buyFuel(ledger, walletOf(req), gold);
  });
```

- [ ] **Step 4: Run full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/pump.ts server/src/app.ts server/test/pump.test.ts server/test/app.test.ts && git commit -m "feat(server): fuel pump — GOLD buys FUEL, treasury fills"
```

---

### Task 4: Market exposes skills + NPC auto-listing

**Files:**
- Modify: `server/src/crew.ts` (listings join skills), `server/src/app.ts` (boot-time NPC listing)
- Test: `server/test/crew.test.ts` (extend), `server/test/app.test.ts` (extend)

**Interfaces:**
- Consumes: `NPC_CREW`, `HARBOUR` from `fleet.ts`.
- Produces: `Listing` gains `skills: { fuel?: number; attack?: number; defense?: number }` (joined at read time from `fleet.getCrew`, `{}` if unknown). `buildApp` lists all `NPC_CREW` on the market at boot (idempotent — `list()` is an upsert).

- [ ] **Step 1: Extend tests (failing)**

Append to `server/test/crew.test.ts`:
```ts
it('listings carry the crew skills', () => {
  market.list('crew-1', 'bob', 15);
  expect(market.listings()[0].skills).toEqual({ fuel: 20 });
  expect(market.getListing('crew-1')?.skills.fuel).toBe(20);
});
```
Append to `server/test/app.test.ts`:
```ts
it('the harbour lists NPC crew with skills at boot', async () => {
  const res = await app.inject({ method: 'GET', url: '/crew/market', headers: asAlice });
  const listings = res.json();
  const stoker = listings.find((l: any) => l.crewId === 'npc-stoker');
  expect(stoker).toBeDefined();
  expect(stoker.owner).toBe('harbour');
  expect(stoker.sharePct).toBe(10);
  expect(stoker.skills).toEqual({ fuel: 35 });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd ~/skyharbour/server && npx vitest run test/crew.test.ts test/app.test.ts`
Expected: FAIL — no skills field, no NPC listings.

- [ ] **Step 3: Implement**

In `server/src/crew.ts`: extend the interface and `listings()`:
```ts
export interface Listing {
  crewId: string;
  owner: string;
  sharePct: number;
  skills: { fuel?: number; attack?: number; defense?: number };
}
```
```ts
  listings(): Listing[] {
    const rows = this.db
      .prepare('SELECT crew_id, owner, share_pct FROM crew_listings')
      .all() as { crew_id: string; owner: string; share_pct: number }[];
    return rows.map((r) => ({
      crewId: r.crew_id,
      owner: r.owner,
      sharePct: r.share_pct,
      skills: this.fleet.getCrew(r.crew_id)?.skills ?? {},
    }));
  }
```
(`list()`'s return builds a Listing too — give it `skills: this.fleet.getCrew(crewId)?.skills ?? {}`.)
In `server/src/app.ts` after `missions` is constructed: `import { NPC_CREW, HARBOUR } from './fleet.js';` (merge with existing fleet import) and:
```ts
  for (const { member, sharePct } of NPC_CREW) {
    market.list(member.id, HARBOUR, sharePct); // idempotent upsert — harbour staffs the market
  }
```

- [ ] **Step 4: Run full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: all green (existing crew.test listings assertion `toEqual([{ crewId, owner, sharePct }])` will now fail — extend that expected object with `skills: { fuel: 20 }`; this is the mechanical consequence of the interface change, justified here).

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/crew.ts server/src/app.ts server/test/crew.test.ts server/test/app.test.ts && git commit -m "feat(server): market listings carry skills; harbour NPCs staff it"
```

---

### Task 5: Client — pump UI, hired skills in the sim, richer market render

**Files:**
- Modify: `client/api.js` + `client/api.d.ts` (buyFuel), `client/render.js` + `client/render.d.ts` (renderCrewMarket shows skills), `client/bridge.js` (market cache → sh:launch skills; pump handler), `index.html` (pump panel in hangar frame), `styles.css` (pump styles)
- Test: `server/test/client/render.test.ts` (extend), `server/test/client/api.test.ts` (extend)

**Interfaces:**
- Consumes: `POST /fuel/buy`; listings with `skills`.
- Produces: `buyFuel(gold)` in api.js; crew checkboxes labeled with skills; `sh:launch` detail crew now carry real skills for hired crew (from the cached market listings) as well as own crew; pump buttons `data-gold="10|25|50"` in `#hangar-frame` under a `#fuel-pump` div.

- [ ] **Step 1: Extend pure-module tests (failing)**

Append to `server/test/client/api.test.ts`:
```ts
it('buyFuel posts the gold amount', async () => {
  setWallet('alice');
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    expect(url).toBe('/fuel/buy');
    expect(JSON.parse(init.body)).toEqual({ gold: 25 });
    return { ok: true, json: async () => ({ fuelCredited: 100 }) };
  });
  const { buyFuel } = await import('../../../client/api.js');
  expect((await buyFuel(25)).fuelCredited).toBe(100);
});
```
Append to `server/test/client/render.test.ts`:
```ts
it('crew market shows listing skills', () => {
  const html = renderCrewMarket(
    [{ crewId: 'npc-stoker', owner: 'harbour', sharePct: 10, skills: { fuel: 35 } }],
    [],
  );
  expect(html).toContain('FUEL 35');
  expect(html).toContain('NPC-STOKER');
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd ~/skyharbour/server && npx vitest run test/client/api.test.ts test/client/render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client/api.js`: add `export const buyFuel = (gold) => api('/fuel/buy', { method: 'POST', body: { gold } });` and mirror in `client/api.d.ts`: `export function buyFuel(gold: number): Promise<any>;`

`client/render.js` — in `renderCrewMarket`, label listings with their skills:
```js
function skillLabel(skills) {
  const parts = [];
  if (skills?.fuel) parts.push(`FUEL ${escapeHtml(skills.fuel)}`);
  if (skills?.defense) parts.push(`DEF ${escapeHtml(skills.defense)}`);
  if (skills?.attack) parts.push(`ATK ${escapeHtml(skills.attack)}`);
  return parts.length ? ` — ${parts.join(' · ')}` : '';
}
```
and change the listings map line to:
```js
    ...listings.map((l) => `
      <label class="crew-pick"><input type="checkbox" data-crew="${escapeHtml(l.crewId)}">
        ${escapeHtml(l.crewId).toUpperCase()}${skillLabel(l.skills)} — SHARE ${escapeHtml(l.sharePct)}% (OWNER ${escapeHtml(l.owner).toUpperCase()})</label>`),
```
(own-crew rows may also show `skillLabel(c.skills)` — do it for symmetry.) Update `client/render.d.ts` if its listing type names fields.

`index.html` — inside `#hangar-frame`'s `card-details`, after `#hangar-mount`:
```html
<div id="fuel-pump">
  <p class="pump-title">FUEL PUMP — 1 G = 4 FUEL</p>
  <button class="pump-btn console-btn" data-gold="10">10 G</button>
  <button class="pump-btn console-btn" data-gold="25">25 G</button>
  <button class="pump-btn console-btn" data-gold="50">50 G</button>
</div>
```

`styles.css` — append:
```css
/* ---------- fuel pump ---------- */
#fuel-pump { margin-top: 14px; display: flex; gap: 10px; align-items: baseline; }
.pump-title { font-size: 0.65em; letter-spacing: 0.2em; color: var(--gold); margin: 0 6px 0 0; }
```

`client/bridge.js`:
1. `import { buyFuel } from './api.js';` (merge into the existing import) — and keep the market data: module-scope `let lastMarket = [];` set inside `refreshCrew()`:
```js
async function refreshCrew() {
  if (!session) return;
  lastMarket = await crewMarket();
  $('crew-mount').innerHTML = renderCrewMarket(lastMarket, session.crew);
}
```
2. In the accept path, replace the skills backfill so hired crew get market skills:
```js
    const crew = (mission.crewTerms ?? []).map((t) => {
      const own = session.crew.find((k) => k.id === t.crewId);
      const listed = lastMarket.find((l) => l.crewId === t.crewId);
      return { id: t.crewId, skills: own?.skills ?? listed?.skills ?? {} };
    });
```
3. Pump handler (delegated, after the other listeners):
```js
document.addEventListener('click', async (ev) => {
  const pump = ev.target.closest?.('.pump-btn');
  if (!pump) return;
  if (!session) { say('DOCK IN FIRST, PILOT'); return; }
  try {
    const r = await buyFuel(Number(pump.dataset.gold));
    say(`TANKS +${r.fuelCredited} FUEL`);
    await refreshEconomy();
  } catch (e) { say(String(e.message || e).toUpperCase()); }
});
```

- [ ] **Step 4: Run suites + smoke**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: all green.
Boot smoke: serve on :8426, `curl -s localhost:8426/app/ | grep -c fuel-pump` → 1, kill.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add client/api.js client/api.d.ts client/render.js client/render.d.ts client/bridge.js index.html styles.css && git commit -m "feat(client): fuel pump UI, hired-crew skills in the sim, skill-labeled market"
```

---

### Task 6: End-to-end seal

**Files:**
- Test: `server/test/client/loop.test.ts` (extend with a fuel-pump + NPC-crew loop)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the extended loop test**

Append to `server/test/client/loop.test.ts`:
```ts
it('long mission with NPC crew: refuel, hire, fly, split pay with the harbour', async () => {
  const app = buildApp();
  const h = { 'x-wallet': 'zed' };
  await app.inject({ method: 'POST', url: '/login', headers: h });

  // refuel enough for a 300-crossing on the hauler
  const buy = await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 20 } });
  expect(buy.statusCode).toBe(200); // 300 grant + 80 = 380 FUEL

  const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: h, payload: { count: 1 } })).json();
  const acc = await app.inject({
    method: 'POST', url: `/missions/${m.id}/accept`, headers: h,
    payload: { shipId: 'zed-hauler', crewIds: ['npc-stoker'] },
  });
  expect(acc.statusCode).toBe(200);
  expect(acc.json().crewTerms).toEqual([{ crewId: 'npc-stoker', owner: 'harbour', sharePct: 10 }]);

  const ship = { id: 'zed-hauler', owner: 'zed', engine: 8, cargo: 32, crewSlots: 3 };
  const stoker = { id: 'npc-stoker', skills: { fuel: 35 } };
  const world = mkWorld(m.id, m.distance);
  world.rocks = [];
  const run = mkRun(ship, [stoker], m.distance, 2000);
  while (!run.done) stepRun(run, 1 / 60, { yaw: 0, throttle: 1 }, world);
  expect(run.outcome).toBe('landed');

  const done = await app.inject({
    method: 'POST', url: `/missions/${m.id}/complete`, headers: h,
    payload: { telemetry: telemetry(run, m, ship) },
  });
  expect(done.statusCode).toBe(200);
  const payout = done.json();
  expect(payout.crewShares).toEqual([{ owner: 'harbour', gold: Math.floor(payout.rewardGold * 10 / 100) }]);

  const harbour = (await app.inject({ method: 'GET', url: '/balances', headers: { 'x-wallet': 'harbour' } })).json();
  expect(harbour.GOLD).toBeGreaterThan(0);
});
```
(Note: `mkRun` signature takes the crew array — pass `[stoker]` so the client fuel model matches the server's minFuel for the hired stoker; the telemetry clamp covers the rest.)

- [ ] **Step 2: Run it (must pass — integration seal)**

Run: `cd ~/skyharbour/server && npx vitest run test/client/loop.test.ts && npm test && npm run typecheck`
Expected: all green. If complete 400s, the client/server fuel-skill paths have drifted — fix the client side, never the server.

- [ ] **Step 3: Commit**

```bash
cd ~/skyharbour && git add server/test/client/loop.test.ts && git commit -m "test: long-mission NPC-crew refuel loop seals the improve batch"
```

---

## Self-review notes

- Owner features → tasks: longer missions (T2), refuel (T3 server + T5 UI), NPC crew hire (T1 fixtures + T4 market + T5 sim skills), fake ship NFTs (T1). Economy coherence: hazard pay funds the fuel cost of long routes at pool rate (300 distance ≈ 75 G hazard vs 75 G worth of FUEL at 1:4 — deliberate near-parity, margin comes from cargo value).
- Justified test edits are enumerated in Global Constraints and inside T2/T4.
- Type consistency: `Listing.skills` (T4) consumed by T5's render/bridge; `NPC_CREW`/`HARBOUR` (T1) consumed by T4; `hazardPay` (T2) used in its own tests; `buyFuel` server (T3) vs client (T5) shapes match.
