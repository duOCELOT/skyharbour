# Skyharbour Balancing Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the tracked economy holes: hazard pay scales with delivered fraction (kills the +9.6 G/run deliver-1 grind), failed runs burn the fuel they actually spent, crew re-listing updates the recorded owner, and short routes (60–80u) get hazards so DEFENSE crew matter there.

**Architecture:** Four surgical changes on existing seams — `MissionEngine.complete` payout term, `MissionEngine.fail` + route + `flight.js` gain an optional `fuelSpent`, `CrewMarket.list`'s upsert gains `owner = excluded.owner`, and `flightMath.mkWorld` gets a narrower corridor buffer below 80u.

**Tech Stack:** unchanged.

## Global Constraints

- Locked numbers: payout hazard = `floor(hazardPay(distance) * delivered / amount)`; generation reward keeps FULL `hazardPay(distance)` (advertised maximum); fail burns `min(ceil(fuelSpent), pilot FUEL balance, 2 * distance)`; short-route corridor buffer = 30 (rocks exist for `distance > 60`), long-route buffer stays 40 (`distance > 80` formula unchanged in range).
- All money movements stay single atomic `ledger.post`s; legs zero-sum per token.
- Plan-authorized test edits (mechanical consequences, each named in its task): missions payout assertions gain the scaled-hazard term; the api-client `failMission` test gains the body; flightMath rock-corridor tests gain the 60–80 band.
- Every data string in client HTML through `escapeHtml`; no Solana code; suite + `npm run typecheck` green from `server/` before every commit.

---

### Task 1: Hazard pay scales with delivered fraction

**Files:**
- Modify: `server/src/missions.ts` (complete() payout term only)
- Test: `server/test/missions.test.ts`

**Interfaces:**
- Consumes: existing `hazardPay(distance)`.
- Produces: payout `rewardGold = delivered * unitPrice + Math.floor(hazardPay(m.distance) * delivered / m.amount)`. Generation unchanged. `delivered = 0` still yields 0 total (floor(x*0)=0 — the explicit `delivered > 0` gate becomes redundant and is removed for one formula).

- [ ] **Step 1: Write/adjust the failing tests**

In `server/test/missions.test.ts`:
1. Update the two payout assertions that currently add full `hazardPay(m.distance)` (from the improve batch) to the scaled form — in the atomic-payout test and the proportional-reward test, the expected reward becomes:
```ts
const expectedReward = delivered * 1 + Math.floor(hazardPay(m.distance) * delivered / m.amount);
```
(use it wherever `payout.rewardGold` or share math derives from the reward).
2. Add a new test:
```ts
it('partial delivery earns only its fraction of hazard pay — no deliver-1 grind', () => {
  const [m] = engine.generate(1);
  engine.accept(m.id, 'alice', 'ship-1', []);
  const delivered = 1;
  const payout = engine.complete(m.id, {
    durationS: m.distance / 10 + 1,
    fuelSpent: m.distance,
    cargoDelivered: delivered,
  });
  expect(payout.rewardGold).toBe(1 * 1 + Math.floor(hazardPay(m.distance) * 1 / m.amount));
  // economics note: at pool rate (1G=4F) a d-unit crossing costs ~d/4 GOLD of fuel;
  // fractional hazard can no longer cover it on a token delivery.
});
```
(If `m.amount === 1` the fraction is 1 — the assertion formula still holds; no need to special-case.)

- [ ] **Step 2: Run to verify failures**

Run: `cd ~/skyharbour/server && npx vitest run test/missions.test.ts`
Expected: FAIL on the new/updated assertions.

- [ ] **Step 3: Implement**

In `server/src/missions.ts` `complete()`:
```ts
const rewardGold = delivered * TOKENS[m.cargo].unitPriceGold
  + Math.floor(hazardPay(m.distance) * delivered / m.amount);
```
(with a comment: `// hazard pays out by delivered fraction — a token delivery cannot farm the full crossing bonus (t-c45ecf)`).

- [ ] **Step 4: Full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: green (the loop tests assert payout structure via computed values, not hardcoded hazard — verify; report if one pins the old formula rather than editing beyond the two authorized assertions).

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/missions.ts server/test/missions.test.ts && git commit -m "fix(server): hazard pay scales with delivered fraction — grind closed"
```

---

### Task 2: Failed runs burn their reported fuel

**Files:**
- Modify: `server/src/missions.ts` (fail signature), `server/src/app.ts` (fail route body), `client/api.js` + `client/api.d.ts` (failMission), `client/flight.js` (pass run fuel)
- Test: `server/test/missions.test.ts`, `server/test/app.test.ts`, `server/test/client/api.test.ts`

**Interfaces:**
- Produces: `MissionEngine.fail(id: string, fuelSpent = 0): void` — validates `Number.isFinite(fuelSpent) && fuelSpent >= 0` (else `Error('fuelSpent must be a non-negative number')`); burns `const burn = Math.min(Math.ceil(fuelSpent), this.ledger.balance(\`wallet:${m.pilot}\`, 'FUEL'), 2 * m.distance);` — when `burn > 0`, adds legs `wallet:<pilot> -burn FUEL` / `burn +burn FUEL` to the SAME atomic fail post (fee escrow → settlement legs unchanged). Route body: optional `{ fuelSpent?: number }` (missing → 0). Client: `failMission(id, fuelSpent = 0)` posts `{ fuelSpent }`; `flight.js` passes `Math.ceil(run.fuel)` at the debrief fail path and keeps `0` (default) on the scrubbed-launch settlement path.

- [ ] **Step 1: Write the failing tests**

`server/test/missions.test.ts`, in the fail describe:
```ts
it('burns the reported fuel on failure, clamped to balance and 2x distance', () => {
  const [m] = engine.generate(1);
  engine.accept(m.id, 'alice', 'ship-1', []);
  const fuelBefore = ledger.balance('wallet:alice', 'FUEL');
  engine.fail(m.id, 50);
  expect(ledger.balance('wallet:alice', 'FUEL')).toBe(fuelBefore - 50);
  expect(ledger.balance('burn', 'FUEL')).toBeGreaterThanOrEqual(50);
});

it('clamps a wild fuel report to 2x distance', () => {
  const [m] = engine.generate(1);
  engine.accept(m.id, 'alice', 'ship-1', []);
  const fuelBefore = ledger.balance('wallet:alice', 'FUEL');
  engine.fail(m.id, 10_000_000);
  expect(fuelBefore - ledger.balance('wallet:alice', 'FUEL')).toBeLessThanOrEqual(2 * m.distance);
});

it('rejects negative or non-finite fuel reports', () => {
  const [m] = engine.generate(1);
  engine.accept(m.id, 'alice', 'ship-1', []);
  expect(() => engine.fail(m.id, -1)).toThrow(/non-negative/);
  expect(() => engine.fail(m.id, NaN)).toThrow(/non-negative/);
});
```
`server/test/app.test.ts` — extend the fail-path coverage:
```ts
it('fail accepts a fuelSpent body and burns it', async () => {
  await app.inject({ method: 'POST', url: '/login', headers: asAlice });
  const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 } })).json();
  await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice, payload: { shipId: 'ship-1', crewIds: [] } });
  const before = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().FUEL;
  const res = await app.inject({ method: 'POST', url: `/missions/${m.id}/fail`, headers: asAlice, payload: { fuelSpent: 30 } });
  expect(res.statusCode).toBe(200);
  const after = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().FUEL;
  expect(before - after).toBe(30);
});
```
`server/test/client/api.test.ts` — plan-authorized mechanical update: the failMission wrapper now posts a body; add:
```ts
it('failMission posts the spent fuel', async () => {
  setWallet('alice');
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    expect(url).toBe('/missions/m1/fail');
    expect(JSON.parse(init.body)).toEqual({ fuelSpent: 42 });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const { failMission } = await import('../../../client/api.js');
  await failMission('m1', 42);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd ~/skyharbour/server && npx vitest run test/missions.test.ts test/app.test.ts test/client/api.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`server/src/missions.ts`:
```ts
  fail(id: string, fuelSpent = 0): void {
    const m = this.get(id);
    if (!m || m.status !== 'active') throw new Error(`mission ${id} is not active`);
    if (!Number.isFinite(fuelSpent) || fuelSpent < 0) {
      throw new Error('fuelSpent must be a non-negative number');
    }
    const burn = Math.min(
      Math.ceil(fuelSpent),
      this.ledger.balance(`wallet:${m.pilot}`, 'FUEL'),
      2 * m.distance, // sanity cap: no honest failure burns more than a double crossing
    );
    const legs: Leg[] = [
      { account: `escrow:${m.id}`, token: 'GOLD', amount: -m.feeGold },
      { account: 'settlement', token: 'GOLD', amount: m.feeGold },
    ];
    if (burn > 0) {
      legs.push(
        { account: `wallet:${m.pilot}`, token: 'FUEL', amount: -burn },
        { account: 'burn', token: 'FUEL', amount: burn },
      );
    }
    this.db.transaction(() => {
      this.ledger.post(`mission failed ${m.id}`, legs);
      this.save({ ...m, status: 'failed' });
    })();
  }
```
(Adapt to the file's actual current fail() body — it already wraps post+save in a transaction; keep that structure and add the validation + burn legs.)

`server/src/app.ts` fail route:
```ts
  app.post('/missions/:id/fail', async (req) => {
    const { id } = req.params as { id: string };
    const { fuelSpent } = (req.body ?? {}) as { fuelSpent?: number };
    // pilot-only guard stays exactly as-is above this line
    missions.fail(id, fuelSpent ?? 0);
    return { ok: true };
  });
```
(Preserve the existing pilot-only guard lines unchanged. Note: existing tests post no body — Fastify yields undefined body for empty POSTs with no content-type; the `?? {}` keeps them green.)

`client/api.js`: `export const failMission = (id, fuelSpent = 0) => api(`/missions/${id}/fail`, { method: 'POST', body: { fuelSpent } });` and d.ts: `export function failMission(id: string, fuelSpent?: number): Promise<any>;`

`client/flight.js` in `finish()`'s non-landed branch: `await failMission(mission.id, Math.ceil(run.fuel));` (the scrubbed-launch path elsewhere keeps its no-second-arg call → 0).

- [ ] **Step 4: Full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/missions.ts server/src/app.ts client/api.js client/api.d.ts client/flight.js server/test/missions.test.ts server/test/app.test.ts server/test/client/api.test.ts && git commit -m "feat: failed runs burn their reported fuel (clamped) — spec §5.6 fail path complete"
```

---

### Task 3: Crew re-list updates the recorded owner

**Files:**
- Modify: `server/src/crew.ts` (upsert)
- Test: `server/test/crew.test.ts`

**Interfaces:** unchanged signatures; the upsert also sets owner.

- [ ] **Step 1: Write the failing test**

Append to `server/test/crew.test.ts`:
```ts
it('re-listing after an ownership transfer updates the recorded owner', () => {
  // simulate an NFT transfer: same crew id, new owner in the fleet source
  const moved = new CrewMarket(new Database(':memory:'), {
    shipsOf: () => [], crewOf: () => [],
    getShip: () => undefined,
    getCrew: (id: string) => (id === 'crew-1' ? { id: 'crew-1', owner: 'dana', skills: { fuel: 20 } } : undefined),
  });
  moved.list('crew-1', 'dana', 30);
  expect(moved.getListing('crew-1')).toEqual({ crewId: 'crew-1', owner: 'dana', sharePct: 30, skills: { fuel: 20 } });
});
```
And the sharper regression on one market instance: list as bob (fixtures), then simulate the fleet change is impractical on DevFleet — the stub above is the meaningful test. Also assert the upsert path directly:
```ts
it('upsert refreshes owner along with share', () => {
  market.list('crew-1', 'bob', 15);
  market.list('crew-1', 'bob', 20);
  expect(market.getListing('crew-1')?.owner).toBe('bob');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/skyharbour/server && npx vitest run test/crew.test.ts`
Expected: the transfer test FAILS only if the upsert drops the new owner — confirm by inspection whether the INSERT path (first list by dana on a fresh db) makes it pass trivially; the binding change is Step 3 regardless; if the test passes pre-change, strengthen it: list first under a stub returning owner 'bob', then swap the stub's owner to 'dana' (mutable variable in the stub) and re-list as dana, asserting the listing owner flips.

- [ ] **Step 3: Implement**

In `server/src/crew.ts` `list()` SQL:
```sql
INSERT INTO crew_listings (crew_id, owner, share_pct) VALUES (?, ?, ?)
ON CONFLICT(crew_id) DO UPDATE SET share_pct = excluded.share_pct, owner = excluded.owner
```

- [ ] **Step 4: Full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/crew.ts server/test/crew.test.ts && git commit -m "fix(server): crew re-list refreshes owner — NFT transfers can't strand wages"
```

---

### Task 4: Short routes get hazards (60–80u)

**Files:**
- Modify: `client/flightMath.js` (mkWorld corridor)
- Test: `server/test/client/flightMath.test.ts`

**Interfaces:** `mkWorld` unchanged signature; rocks now exist for `distance > 60`: buffer 30 when `distance <= 80` (corridor `z ∈ (30, distance-30)`), buffer 40 above (existing formula and ranges unchanged for >80). `distance <= 60` → no rocks.

- [ ] **Step 1: Write the failing tests**

Update/extend the corridor tests in `server/test/client/flightMath.test.ts` (plan-authorized edit of the existing rock-guard test which currently asserts zero rocks for distance ≤ 80):
```ts
it('short routes 60<d<=80 carry rocks in the tight corridor', () => {
  const w = mkWorld('short', 70);
  expect(w.rocks.length).toBeGreaterThan(0);
  for (const r of w.rocks) {
    expect(r.z).toBeGreaterThan(30);
    expect(r.z).toBeLessThan(40); // 70-30
    expect(Math.abs(r.x)).toBeLessThan(120);
  }
});

it('no rocks at or below 60', () => {
  expect(mkWorld('hop', 60).rocks).toEqual([]);
  expect(mkWorld('hop2', 50).rocks).toEqual([]);
});
```
(The existing `distance=120` corridor test stays byte-identical — the >80 path must not change.)

- [ ] **Step 2: Run to verify failures**

Run: `cd ~/skyharbour/server && npx vitest run test/client/flightMath.test.ts`
Expected: FAIL — short routes currently rock-free.

- [ ] **Step 3: Implement**

In `client/flightMath.js` `mkWorld`, replace the rock-count/placement block:
```js
  const rocks = [];
  // Hazards exist above 60u. Short crossings (<=80) use a tighter 30u buffer
  // so DEFENSE crew matter there too; long crossings keep the 40u buffer.
  const buffer = distance > 80 ? 40 : 30;
  const span = distance - 2 * buffer;
  const nRocks = distance > 60 ? Math.floor(distance / 12) : 0;
  for (let i = 0; i < nRocks; i++) {
    rocks.push({
      x: (r() - 0.5) * 220,
      y: (r() - 0.5) * 30,
      z: buffer + r() * span,
      r: 4 + r() * 8,
    });
  }
```
(Keep the target-offset and island blocks untouched. Note `span > 0` whenever `nRocks > 0`: distance 61 → span 1.)

- [ ] **Step 4: Full suite + typecheck**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: green — the production-dt sweep and loop tests clear `world.rocks = []` explicitly, so they are unaffected; verify.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add client/flightMath.js server/test/client/flightMath.test.ts && git commit -m "feat(client): short routes carry rocks — defense crew matter under 80u"
```

---

## Self-review notes

- Tracker coverage: t-c45ecf (T1), fail-burns-no-fuel + DIST wontfix noted in tracker (T2 handles the burn; DIST display stays as contract distance — cosmetic, recorded), crew upsert owner (T3), short-route hazards (T4). Fuel-purchase mechanic already shipped in the improve batch.
- Type consistency: `fail(id, fuelSpent=0)` server/client/route aligned in T2; no other signatures change.
- Deliberately NOT in this pass: hired-crew wage exclusivity, fuel escrow at accept, mint overflow exemption, `open()` scan — tracked, deferred.
