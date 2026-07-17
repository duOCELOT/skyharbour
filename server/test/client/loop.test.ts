import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { raiderCount, shotsToKill } from '../../src/validation.js';
import { BOUNTY_PER_KILL, type FireEvent } from '../../src/missions.js';
import { resolveRun, raiderTimeline, cannonCooldown } from '../../../client/flightMath.js';

type DryShip = { cargo: number; hull: number; engine: number };

// Builds a fire trace landing one killing volley on every raider on the
// route (mirrors server/test/missions.test.ts's helper of the same name).
function killAllTrace(missionId: string, distance: number, cargo: string, engine: number, atk: number): FireEvent[] {
  const shots = shotsToKill(atk);
  const cooldown = cannonCooldown(atk);
  const tl = raiderTimeline(missionId, distance, cargo, engine);
  const order = tl.map((w, i) => ({ ...w, i })).sort((a, b) => a.engageStart - b.engageStart);
  const events: FireEvent[] = [];
  let cursor = 0;
  for (const w of order) {
    let t = Math.max(cursor, w.engageStart);
    for (let s = 0; s < shots; s++) {
      events.push({ t, raider: w.i });
      t += cooldown + 0.01;
    }
    cursor = t;
  }
  return events;
}

type LooseMission = { id: string; distance: number; amount: number; cargo: string };

// Generates missions one at a time (count: 1 — a single larger batch call
// shares one depleting local snapshot of settlement needs and can silently
// return far fewer missions than requested, see MissionEngine.generate)
// until a dry-run resolveRun result (same seed/ship/crew complete() will
// use) satisfies `predicate` — lets these HTTP-loop tests target a specific
// resolver outcome deterministically instead of guessing a mission id's hash.
async function findMission(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string>,
  dryShip: DryShip,
  buildTrace: (m: LooseMission) => FireEvent[],
  predicate: (res: ReturnType<typeof resolveRun>, m: LooseMission) => boolean,
  crew: { id?: string; owner?: string; skills?: Record<string, number> }[] = [],
  ammoAvailable = 999,
): Promise<{ m: LooseMission; fireEvents: FireEvent[] }> {
  for (let i = 0; i < 300; i++) {
    const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers, payload: { count: 1 } })).json();
    const fireEvents = buildTrace(m);
    const res = resolveRun({
      missionId: m.id,
      distance: m.distance,
      cargo: m.cargo,
      amount: m.amount,
      ship: dryShip,
      crew,
      startHull: dryShip.hull,
      ammoAvailable,
      fireEvents,
    });
    if (res.ok && predicate(res, m)) return { m, fireEvents };
  }
  throw new Error('no matching mission found via HTTP generate');
}

describe('full loop: fly the mission exactly as the browser would', () => {
  it('accept → simulated flight → complete pays out', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'alice' };
    await app.inject({ method: 'POST', url: '/login', headers: h });

    const ship = { id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8 };
    const { m, fireEvents } = await findMission(app, h, ship, () => [], (r) => r.outcome === 'landed' && r.raiderHits === 0);

    const acc = await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: h, payload: { shipId: 'ship-1', crewIds: [] } });
    expect(acc.statusCode).toBe(200);

    const done = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: h,
      payload: { fireEvents },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().delivered).toBeGreaterThan(0);

    const bal = (await app.inject({ method: 'GET', url: '/balances', headers: h })).json();
    expect(bal.GOLD).toBeGreaterThan(0);
  });

  it('long mission with NPC crew: refuel, hire, fly, split pay with the harbour', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'zed' };
    await app.inject({ method: 'POST', url: '/login', headers: h });

    // refuel enough for a 300-crossing on the hauler
    const buy = await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 20 } });
    expect(buy.statusCode).toBe(200); // 300 grant + 80 = 380 FUEL

    const ship = { id: 'zed-hauler', owner: 'zed', engine: 8, cargo: 32, crewSlots: 3, hull: 11 };
    const stoker = { id: 'npc-stoker', owner: 'harbour', skills: { fuel: 35 } };
    const { m, fireEvents } = await findMission(app, h, ship, () => [], (r) => r.outcome === 'landed' && r.raiderHits === 0, [stoker]);

    const acc = await app.inject({
      method: 'POST', url: `/missions/${m.id}/accept`, headers: h,
      payload: { shipId: 'zed-hauler', crewIds: ['npc-stoker'] },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().crewTerms).toEqual([{ crewId: 'npc-stoker', owner: 'harbour', sharePct: 10 }]);

    const done = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: h,
      payload: { fireEvents },
    });
    expect(done.statusCode).toBe(200);
    const payout = done.json();
    expect(payout.crewShares).toEqual([{ owner: 'harbour', gold: Math.floor(payout.rewardGold * 10 / 100) }]);
  });

  it('a courier with a longshoreman out-hauls its hull through the full API loop', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'kai' };
    await app.inject({ method: 'POST', url: '/login', headers: h });
    await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 25 } });
    const ship = { id: 'kai-courier', owner: 'kai', engine: 18, cargo: 8, crewSlots: 1, hull: 5 };
    const longshoreman = { id: 'npc-longshoreman', owner: 'harbour', skills: { hauling: 20 } };
    const { m, fireEvents } = await findMission(app, h, ship, () => [], (r) => r.outcome === 'landed' && r.raiderHits === 0, [longshoreman]);

    const acc = await app.inject({
      method: 'POST', url: `/missions/${m.id}/accept`, headers: h,
      payload: { shipId: 'kai-courier', crewIds: ['npc-longshoreman'] },
    });
    expect(acc.statusCode).toBe(200);
    const done = await app.inject({ method: 'POST', url: `/missions/${m.id}/complete`, headers: h, payload: { fireEvents } });
    expect(done.statusCode).toBe(200);
    expect(done.json().delivered).toBe(Math.min(28, m.amount)); // 8 cargo + 20 hauling, no spill
  });

  it('hauling seal: mission batch must always yield at least one with amount > 8', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'seal' };
    await app.inject({ method: 'POST', url: '/login', headers: h });
    const missions = (await app.inject({ method: 'POST', url: '/missions/generate', headers: h, payload: { count: 20 } })).json();
    const m = missions.find((x: any) => x.amount > 8)!;
    expect(m).toBeDefined();
  });

  it('a long run with a full raider wipe pays the bounty through the API', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'gun' };
    await app.inject({ method: 'POST', url: '/login', headers: h });
    await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 50 } });
    // armory run: 10 GOLD buys 20 shells (pump.ts RATES.AMMO = 2) — the run
    // budgets ammo up front, same as the browser would before undocking.
    const ammoBuy = await app.inject({ method: 'POST', url: '/ammo/buy', headers: h, payload: { gold: 10 } });
    expect(ammoBuy.statusCode).toBe(200);
    expect(ammoBuy.json().credited).toBe(20);

    const ship = { id: 'gun-freighter', owner: 'gun', engine: 12, cargo: 18, crewSlots: 2, hull: 9 };
    const { m, fireEvents } = await findMission(
      app,
      h,
      ship,
      (mm) => killAllTrace(mm.id, mm.distance, mm.cargo, ship.engine, 0),
      (r, mm) => r.outcome === 'landed'
        && raiderCount(mm.id, mm.distance, mm.cargo) > 0
        && r.raidersDestroyed === raiderCount(mm.id, mm.distance, mm.cargo),
      [],
      20,
    );
    const kills = raiderCount(m.id, m.distance, m.cargo);
    await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: h, payload: { shipId: 'gun-freighter', crewIds: [] } });
    const balBefore = (await app.inject({ method: 'GET', url: '/balances', headers: h })).json();

    const done = await app.inject({ method: 'POST', url: `/missions/${m.id}/complete`, headers: h, payload: { fireEvents } });
    expect(done.statusCode).toBe(200);
    expect(done.json().rewardGold).toBeGreaterThanOrEqual(BOUNTY_PER_KILL * kills);
    const balAfter = (await app.inject({ method: 'GET', url: '/balances', headers: h })).json();
    // crew is [] → attack 0 → shotsToKill(0) === 2 shells per kill, all cadence-valid
    expect(balBefore.AMMO - balAfter.AMMO).toBe(fireEvents.length);
  });

  it('a fire trace longer than the ammo balance is hard-rejected by the server', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'noshells' };
    await app.inject({ method: 'POST', url: '/login', headers: h });
    await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 50 } });
    const missions = (await app.inject({ method: 'POST', url: '/missions/generate', headers: h, payload: { count: 40 } })).json();
    const m = missions.find((x: any) => x.distance > 120)!;
    expect(m).toBeDefined();
    const acc = await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: h, payload: { shipId: 'noshells-freighter', crewIds: [] } });
    expect(acc.statusCode).toBe(200);
    // noshells never bought extra AMMO beyond the STARTER_AMMO grant (20) —
    // a trace with more events than that (+1 slack) is hard-rejected as
    // longer than the magazine allows, regardless of any claimed kills.
    const overLongTrace = Array.from({ length: 25 }, (_, i) => ({ t: i * 0.001, raider: null as number | null }));
    const done = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: h,
      payload: { fireEvents: overLongTrace },
    });
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toMatch(/magazine/);
  });

  it('aiming at a raider index that does not exist is rejected as a malformed trace', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'cheat' };
    await app.inject({ method: 'POST', url: '/login', headers: h });
    await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 50 } });
    const missions = (await app.inject({ method: 'POST', url: '/missions/generate', headers: h, payload: { count: 40 } })).json();
    const m = missions.find((x: any) => x.distance > 120)!;
    expect(m).toBeDefined();
    const acc = await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: h, payload: { shipId: 'cheat-freighter', crewIds: [] } });
    expect(acc.statusCode).toBe(200);
    const serverRaiderCount = raiderCount(m.id, m.distance, m.cargo);
    const done = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: h,
      payload: { fireEvents: [{ t: 0, raider: serverRaiderCount }] }, // one past the last real raider
    });
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toMatch(/raider index/);
  });

  it('hull persistence seal: raider damage server-resolved, repair costs 4 GOLD/point, full delivery untouched', async () => {
    const app = buildApp();
    const h1 = { 'x-wallet': 'hullseal' };
    const h2 = { 'x-wallet': 'fulldelivery' };

    // PART 1: Mission with raider hits (damaged hull)
    await app.inject({ method: 'POST', url: '/login', headers: h1 });
    await app.inject({ method: 'POST', url: '/fuel/buy', headers: h1, payload: { gold: 50 } });

    const ship1 = { id: 'hullseal-hauler', owner: 'hullseal', engine: 8, cargo: 32, crewSlots: 3, hull: 11 };
    const { m: m1, fireEvents: fe1 } = await findMission(app, h1, ship1, () => [], (r) => r.outcome === 'landed' && r.raiderHits! > 0);

    const acc1 = await app.inject({
      method: 'POST', url: `/missions/${m1.id}/accept`, headers: h1,
      payload: { shipId: 'hullseal-hauler', crewIds: [] },
    });
    expect(acc1.statusCode).toBe(200);

    const done1 = await app.inject({
      method: 'POST', url: `/missions/${m1.id}/complete`, headers: h1,
      payload: { fireEvents: fe1 },
    });
    expect(done1.statusCode).toBe(200);

    // Check that hull was damaged, by the server's own resolver
    const login1 = (await app.inject({ method: 'POST', url: '/login', headers: h1 })).json();
    const damagedShip = login1.ships.find((s: any) => s.id === 'hullseal-hauler');
    expect(damagedShip).toBeDefined();
    const hitsTaken = ship1.hull - damagedShip.currentHull;
    expect(hitsTaken).toBeGreaterThan(0);

    // PART 2: Repair the ship
    const repairCost = hitsTaken * 4; // REPAIR_PER_GOLD_POINT = 4
    const balBefore = (await app.inject({ method: 'GET', url: '/balances', headers: h1 })).json();

    const repair = await app.inject({
      method: 'POST', url: '/ship/repair', headers: h1,
      payload: { shipId: 'hullseal-hauler', toHull: ship1.hull },
    });
    expect(repair.statusCode).toBe(200);
    expect(repair.json().spent).toBe(repairCost);
    expect(repair.json().hull).toBe(ship1.hull);
    expect(repair.json().max).toBe(ship1.hull);

    const balAfter = (await app.inject({ method: 'GET', url: '/balances', headers: h1 })).json();
    expect(balBefore.GOLD - balAfter.GOLD).toBe(repairCost);

    // PART 3: Full-delivery run leaves hull untouched (use fresh wallet to avoid fuel/gold conflicts)
    await app.inject({ method: 'POST', url: '/login', headers: h2 });
    await app.inject({ method: 'POST', url: '/fuel/buy', headers: h2, payload: { gold: 50 } });

    const ship2 = { id: 'fulldelivery-hauler', owner: 'fulldelivery', engine: 8, cargo: 32, crewSlots: 3, hull: 11 };
    const { m: m2, fireEvents: fe2 } = await findMission(app, h2, ship2, () => [], (r) => r.outcome === 'landed' && r.hullDamage === 0);

    const acc2 = await app.inject({
      method: 'POST', url: `/missions/${m2.id}/accept`, headers: h2,
      payload: { shipId: 'fulldelivery-hauler', crewIds: [] },
    });
    expect(acc2.statusCode).toBe(200);

    const done2 = await app.inject({
      method: 'POST', url: `/missions/${m2.id}/complete`, headers: h2,
      payload: { fireEvents: fe2 },
    });
    expect(done2.statusCode).toBe(200);

    // Check that hull remains at max after a hazard-free delivery
    const login2 = (await app.inject({ method: 'POST', url: '/login', headers: h2 })).json();
    const finalShip = login2.ships.find((s: any) => s.id === 'fulldelivery-hauler');
    expect(finalShip).toBeDefined();
    expect(finalShip.currentHull).toBe(ship2.hull); // Should still be at max
  });
});
