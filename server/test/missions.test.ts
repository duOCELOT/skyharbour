import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FleetSource, Ship, CrewMember } from '../src/fleet.js';
import { Ledger } from '../src/ledger.js';
import { Settlement, type Stage } from '../src/settlement.js';
import { CrewMarket } from '../src/crew.js';
import { DevFleet, devFixtures } from '../src/fleet.js';
import { MissionEngine, hazardPay, missionAmountCap, BOUNTY_PER_KILL, type FireEvent, type Mission } from '../src/missions.js';
import { raiderCount, shotsToKill } from '../src/validation.js';
import { resolveRun, raiderTimeline, cannonCooldown } from '../../client/flightMath.js';
import { TOKENS } from '../src/tokens.js';
import { HullState } from '../src/hull.js';
import { Contributions } from '../src/contributions.js';

const stages: Stage[] = [{ index: 0, name: 'Dock', needs: { LOG: 100 } }];

// devFixtures' ship-1 / crew-1, mirrored here so tests can dry-run resolveRun
// (a pure function) with the exact same shape complete() will use, without
// reaching into MissionEngine's private fleet field.
const SHIP1: Ship = { id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8 };
const CREW1: CrewMember = { id: 'crew-1', owner: 'bob', skills: { fuel: 20 } };

// Builds a fire trace landing one killing volley on every raider on the
// route, using raiderTimeline for windows. Raiders are processed in
// engageStart order and a single running time cursor threads across all of
// them, so the whole trace stays non-decreasing and cadence-valid even
// though shots target different raiders — the same cannon/cooldown covers
// all targets.
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

// Kills exactly one named raider, leaving the rest of the route untouched.
function killOneTrace(
  missionId: string,
  distance: number,
  cargo: string,
  engine: number,
  atk: number,
  raiderIndex: number,
): FireEvent[] {
  const tl = raiderTimeline(missionId, distance, cargo, engine);
  if (raiderIndex >= tl.length) return []; // no such raider on this route — let the caller's predicate reject the candidate
  const shots = shotsToKill(atk);
  const cooldown = cannonCooldown(atk);
  const w = tl[raiderIndex];
  const events: FireEvent[] = [];
  let t = w.engageStart;
  for (let s = 0; s < shots; s++) {
    events.push({ t, raider: raiderIndex });
    t += cooldown + 0.01;
  }
  return events;
}

// N unaimed (raider: null) cadence-valid shots, spaced just past cannon
// cooldown apart — exercises ammo accounting without touching combat.
function unaimedTrace(n: number, atk: number): FireEvent[] {
  const cooldown = cannonCooldown(atk);
  const events: FireEvent[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    events.push({ t, raider: null });
    t += cooldown + 0.01;
  }
  return events;
}

// Generates missions from `missionEngine` until `buildTrace(m)` produces a
// fire trace whose dry-run resolveRun result (with the same seed/ship/crew
// complete() will use) satisfies `predicate` — then returns that mission and
// trace. resolveRun is pure, so this dry run is byte-identical to what
// complete() computes internally for the same inputs: it lets tests target
// a specific resolver outcome (landed/void, spilled/clean, N kills…)
// without guessing seeds or depending on the random mission id's hash.
function findMissionWithTrace(
  missionEngine: MissionEngine,
  dryShip: Ship,
  buildTrace: (m: Mission) => FireEvent[],
  predicate: (res: ReturnType<typeof resolveRun>, m: Mission) => boolean,
  crew: CrewMember[] = [],
  ammoAvailable = 40,
): { m: Mission; fireEvents: FireEvent[] } {
  for (let i = 0; i < 300; i++) {
    const [m] = missionEngine.generate(1);
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
  throw new Error('could not find a matching mission in time');
}

let db: Database.Database;
let ledger: Ledger;
let engine: MissionEngine;
let market: CrewMarket;
let hull: HullState;
let contributions: Contributions;

beforeEach(() => {
  db = new Database(':memory:');
  ledger = new Ledger(db);
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);
  market = new CrewMarket(db, fleet);
  hull = new HullState(db);
  contributions = new Contributions(db);
  engine = new MissionEngine(db, ledger, new Settlement(db, stages), market, fleet, hull, contributions);
  // fund alice: 100 GOLD, 400 FUEL (enough for distances up to 300), 40 AMMO
  ledger.post('seed', [
    { account: 'mint', token: 'GOLD', amount: -100 },
    { account: 'wallet:alice', token: 'GOLD', amount: 100 },
    { account: 'mint', token: 'FUEL', amount: -400 },
    { account: 'wallet:alice', token: 'FUEL', amount: 400 },
    { account: 'mint', token: 'AMMO', amount: -40 },
    { account: 'wallet:alice', token: 'AMMO', amount: 40 },
  ]);
});

describe('mission generation', () => {
  it('generates missions from settlement needs with priced rewards', () => {
    const [m] = engine.generate(1);
    expect(m.cargo).toBe('LOG');
    expect(m.rewardGold).toBe(m.amount * 1 + hazardPay(m.distance, 'LOG'));
    expect(m.distance).toBeGreaterThanOrEqual(60);
    expect(m.distance).toBeLessThanOrEqual(300);
    expect(m.feeGold).toBe(Math.max(1, Math.floor(m.rewardGold / 10)));
    expect(m.status).toBe('open');
  });
  it('mission amount cap grows with the settlement stage', () => {
    expect(missionAmountCap(0)).toBe(20);
    expect(missionAmountCap(3)).toBe(50);
  });
  it('generated amounts respect the current-stage cap', () => {
    for (let i = 0; i < 30; i++) {
      const [m] = engine.generate(1);
      expect(m.amount).toBeLessThanOrEqual(missionAmountCap(0));
      expect(m.amount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('hazard pay', () => {
  it('scales with distance AND cargo value (÷7)', () => {
    expect(hazardPay(300, 'LOG')).toBe(43); // ceil(300*1/7)
    expect(hazardPay(300, 'MINERAL')).toBe(86); // ceil(300*2/7)
    expect(hazardPay(300, 'FURNITURE')).toBe(129); // ceil(300*3/7)
    expect(hazardPay(300, 'FIRERUNE')).toBe(429); // ceil(300*10/7)
    expect(hazardPay(120, 'MINERAL')).toBe(35); // ceil(120*2/7)
  });
  it('bounty per kill is defensive (1) — a tuning-regression guard', () => {
    expect(BOUNTY_PER_KILL).toBe(1);
  });
});

describe('accept', () => {
  it('escrows the fee and activates the mission', () => {
    market.list('crew-1', 'bob', 15);
    const [m] = engine.generate(1);
    const active = engine.accept(m.id, 'alice', 'ship-1', ['crew-1']);
    expect(active.status).toBe('active');
    expect(ledger.balance(`escrow:${m.id}`, 'GOLD')).toBe(m.feeGold);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(100 - m.feeGold);
  });
  it('rejects a ship the pilot does not own', () => {
    const [m] = engine.generate(1);
    expect(() => engine.accept(m.id, 'alice', 'ship-2', [])).toThrow(/ship/);
  });
  it('rejects unlisted crew belonging to someone else', () => {
    const [m] = engine.generate(1);
    expect(() => engine.accept(m.id, 'alice', 'ship-1', ['crew-2'])).toThrow(/crew/);
  });
  it('rejects crew over the ship slots', () => {
    market.list('crew-2', 'carol', 10);
    market.list('crew-3', 'carol', 10);
    market.list('crew-1', 'bob', 10);
    const [m] = engine.generate(1);
    expect(() =>
      engine.accept(m.id, 'alice', 'ship-1', ['crew-1', 'crew-2', 'crew-3']),
    ).toThrow(/slots/);
  });
  it('rejects duplicate crew ids', () => {
    market.list('crew-1', 'bob', 10);
    const [m] = engine.generate(1);
    expect(() => engine.accept(m.id, 'alice', 'ship-1', ['crew-1', 'crew-1'])).toThrow(
      /duplicate/i,
    );
  });
  it('rejects insufficient fuel', () => {
    // drain to zero: distances are random 60..300, any remainder ≥60 could satisfy accept
    ledger.post('drain fuel', [
      { account: 'wallet:alice', token: 'FUEL', amount: -400 },
      { account: 'burn', token: 'FUEL', amount: 400 },
    ]);
    const [m] = engine.generate(1);
    expect(() => engine.accept(m.id, 'alice', 'ship-1', [])).toThrow(/fuel/i);
  });
});

describe('crew terms snapshot', () => {
  it('a share bump after accept does not change the payout', () => {
    market.list('crew-1', 'bob', 10);
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! === 0,
      [CREW1],
    );
    engine.accept(m.id, 'alice', 'ship-1', ['crew-1']);
    market.list('crew-1', 'bob', 50); // bob relists at a much higher share after acceptance
    const payout = engine.complete(m.id, fireEvents);
    const share = Math.floor((payout.rewardGold * 10) / 100);
    expect(payout.crewShares).toEqual([{ owner: 'bob', gold: share }]);
  });

  it('unlisting after accept does not strand the mission', () => {
    market.list('crew-1', 'bob', 10);
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! === 0,
      [CREW1],
    );
    engine.accept(m.id, 'alice', 'ship-1', ['crew-1']);
    market.unlist('crew-1', 'bob');
    const payout = engine.complete(m.id, fireEvents);
    const share = Math.floor((payout.rewardGold * 10) / 100);
    expect(payout.crewShares).toEqual([{ owner: 'bob', gold: share }]);
    expect(engine.get(m.id)?.status).toBe('done');
  });
});

describe('complete', () => {
  it('pays pilot and crew owners, burns fuel, feeds the settlement — atomically', () => {
    market.list('crew-1', 'bob', 15);
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! === 0,
      [CREW1],
    );
    engine.accept(m.id, 'alice', 'ship-1', ['crew-1']);
    const goldBefore = ledger.balance('wallet:alice', 'GOLD');
    const fuelBefore = ledger.balance('wallet:alice', 'FUEL');

    const payout = engine.complete(m.id, fireEvents);
    const delivered = payout.delivered; // no raider hits ⇒ zero spill, full delivery

    const expectedReward = delivered * 1 + Math.floor(hazardPay(m.distance, m.cargo) * delivered / m.amount);
    const share = Math.floor((payout.rewardGold * 15) / 100);
    expect(delivered).toBe(Math.min(20, m.amount));
    expect(payout.rewardGold).toBe(expectedReward);
    expect(payout.crewShares).toEqual([{ owner: 'bob', gold: share }]);
    expect(ledger.balance('wallet:bob', 'GOLD')).toBe(share);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(goldBefore + payout.rewardGold - share);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(fuelBefore - payout.fuelBurned);
    expect(ledger.balance('settlement', 'GOLD')).toBe(m.feeGold);
    expect(ledger.balance('settlement', 'LOG')).toBe(delivered);
    expect(ledger.balance(`escrow:${m.id}`, 'GOLD')).toBe(0);
    expect(engine.get(m.id)?.status).toBe('done');
  });

  it('reward is proportional to delivered cargo, not mission amount', () => {
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! === 0,
    );
    engine.accept(m.id, 'alice', 'ship-1', []);
    const payout = engine.complete(m.id, fireEvents);
    const delivered = payout.delivered;
    const expectedReward = delivered * 1 + Math.floor(hazardPay(m.distance, m.cargo) * delivered / m.amount);
    expect(payout.rewardGold).toBe(expectedReward);
  });

  it('partial delivery earns only its fraction of hazard pay — no deliver-1 grind', () => {
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! > 0,
    );
    engine.accept(m.id, 'alice', 'ship-1', []);
    const payout = engine.complete(m.id, fireEvents);
    const delivered = payout.delivered;
    expect(delivered).toBeLessThan(Math.min(20, m.amount)); // partial: spill from an unkilled raider
    expect(payout.rewardGold).toBe(delivered * 1 + Math.floor(hazardPay(m.distance, m.cargo) * delivered / m.amount));
    // economics note: hazard pays out by delivered fraction — spill can no
    // longer farm the full crossing bonus (t-c45ecf)
  });

  it('rejects a malformed fire trace and keeps the mission active', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    expect(() => engine.complete(m.id, [{ t: -1, raider: null }])).toThrow(/rejected/);
    expect(engine.get(m.id)?.status).toBe('active');
  });

  it('fails gracefully (not a crash) when the ship vanishes from the fleet before completion', () => {
    const stubShip: Ship = { id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 3, hull: 8 };
    let shipStillHeld = true;
    const stubFleet: FleetSource = {
      shipsOf: () => (shipStillHeld ? [stubShip] : []),
      crewOf: () => [],
      getShip: (id) => (shipStillHeld && id === stubShip.id ? stubShip : undefined),
      getCrew: () => undefined,
    };
    const db2 = new Database(':memory:');
    const ledger2 = new Ledger(db2);
    const market2 = new CrewMarket(db2, stubFleet);
    const engine2 = new MissionEngine(db2, ledger2, new Settlement(db2, stages), market2, stubFleet, new HullState(db2));
    ledger2.post('seed', [
      { account: 'mint', token: 'GOLD', amount: -100 },
      { account: 'wallet:alice', token: 'GOLD', amount: 100 },
      { account: 'mint', token: 'FUEL', amount: -400 },
      { account: 'wallet:alice', token: 'FUEL', amount: 400 },
    ]);
    const [m] = engine2.generate(1);
    engine2.accept(m.id, 'alice', 'ship-1', []);
    shipStillHeld = false; // ship sold / vanished mid-mission
    expect(() => engine2.complete(m.id, [])).toThrow(/no longer held/);
    expect(engine2.get(m.id)?.status).toBe('active');
  });

  it('raider kills pay bounty inside the shared reward', () => {
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      (m) => killAllTrace(m.id, m.distance, m.cargo, SHIP1.engine, 0),
      (r, m) => r.outcome === 'landed'
        && raiderCount(m.id, m.distance, m.cargo) > 0
        && r.raidersDestroyed === raiderCount(m.id, m.distance, m.cargo),
    );
    engine.accept(m.id, 'alice', 'ship-1', []);
    const kills = raiderCount(m.id, m.distance, m.cargo);
    const payout = engine.complete(m.id, fireEvents);
    expect(payout.delivered).toBe(Math.min(20, m.amount)); // all raiders dead ⇒ zero spill
    expect(payout.rewardGold).toBe(payout.delivered * TOKENS[m.cargo].unitPriceGold
      + Math.floor(hazardPay(m.distance, m.cargo) * payout.delivered / m.amount) + BOUNTY_PER_KILL * kills);
    // a landed run records the pilot's contribution = cargo value delivered
    expect(contributions.valueOf('alice')).toBe(payout.delivered * TOKENS[m.cargo].unitPriceGold);
    expect(contributions.leaderboard()[0]).toEqual({ wallet: 'alice', deliveries: 1, value: payout.delivered * TOKENS[m.cargo].unitPriceGold });
  });

  it('spent shells burn on completion', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    const ammoBefore = ledger.balance('wallet:alice', 'AMMO'); // 40, seeded
    engine.complete(m.id, unaimedTrace(4, 0));
    expect(ledger.balance('wallet:alice', 'AMMO')).toBe(ammoBefore - 4);
    expect(ledger.balance('burn', 'AMMO')).toBe(4);
  });
});

describe('hull damage — server-resolved, never self-reported', () => {
  it('accept() starts a fresh ship at full hull', () => {
    const [m] = engine.generate(1);
    const active = engine.accept(m.id, 'alice', 'ship-1', []);
    expect(active.startHull).toBe(8); // ship-1's armor rating, devFixtures
  });

  it('a hazard-free crossing takes zero hull damage', () => {
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.hullDamage === 0,
    );
    engine.accept(m.id, 'alice', 'ship-1', []);
    engine.complete(m.id, fireEvents);
    expect(hull.current('ship-1', 8)).toBe(8);
  });

  it('a landed run delivering short leaves the ship damaged, visible on the next accept', () => {
    const { m: m1, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! > 0,
    );
    engine.accept(m1.id, 'alice', 'ship-1', []);
    const payout = engine.complete(m1.id, fireEvents);
    expect(payout.delivered).toBeLessThan(Math.min(20, m1.amount)); // sanity: a real hit occurred
    const expectedHull = hull.current('ship-1', 8);
    expect(expectedHull).toBeLessThan(8);

    // Top up FUEL for the second mission (random distance could exhaust the seed)
    ledger.post('top up fuel', [
      { account: 'mint', token: 'FUEL', amount: -400 },
      { account: 'wallet:alice', token: 'FUEL', amount: 400 },
    ]);

    const [m2] = engine.generate(1);
    const active2 = engine.accept(m2.id, 'alice', 'ship-1', []);
    expect(active2.startHull).toBe(expectedHull);
  });
});

describe('bounty adjudication (server-resolved kills, ammo-bounded)', () => {
  it('an ammo-starved pilot cannot buy kills — the resolver caps accepted shots at the real balance', () => {
    let m: Mission | undefined;
    for (let i = 0; i < 60 && !m; i++) {
      const [c] = engine.generate(1);
      if (raiderCount(c.id, c.distance, c.cargo) > 0) m = c;
    }
    if (!m) throw new Error('unreachable');
    engine.accept(m.id, 'alice', 'ship-1', []);
    // drain alice's AMMO to zero: a fire trace can no longer buy any kills
    // once the resolver caps accepted shots at the real balance.
    ledger.post('drain ammo', [
      { account: 'wallet:alice', token: 'AMMO', amount: -40 },
      { account: 'burn', token: 'AMMO', amount: 40 },
    ]);
    // A trace longer than ammoAvailable+1 is hard-rejected outright, so a
    // single shot is the most a 0-balance trace is even allowed to carry —
    // it's capped to zero accepted shots regardless, so it buys no kill.
    const payout = engine.complete(m.id, [{ t: 0, raider: 0 }]);
    expect(payout.rewardGold).toBe(payout.delivered * TOKENS[m.cargo].unitPriceGold
      + Math.floor(hazardPay(m.distance, m.cargo) * payout.delivered / m.amount));
  });

  it('clamps the ammo burn to the real balance in both complete() and fail()', () => {
    // complete(): a 41-shot trace vs a 40-AMMO balance — burns exactly 40
    const [m1] = engine.generate(1);
    engine.accept(m1.id, 'alice', 'ship-1', []);
    const ammoBefore = ledger.balance('wallet:alice', 'AMMO'); // 40, seeded
    engine.complete(m1.id, unaimedTrace(41, 0));
    expect(ledger.balance('wallet:alice', 'AMMO')).toBe(ammoBefore - 40);
    expect(ledger.balance('burn', 'AMMO')).toBe(40);

    // fail(): reported ammoSpent 500 vs a 600-AMMO balance — burns exactly 100, the sanity cap.
    // Top up FUEL too: the first complete() burned up to 300 of the 400-FUEL seed, so the
    // second accept()'s minFuel check would flake without a refill (distances are random 60..300).
    ledger.post('top up provisions', [
      { account: 'mint', token: 'AMMO', amount: -600 },
      { account: 'wallet:alice', token: 'AMMO', amount: 600 },
      { account: 'mint', token: 'FUEL', amount: -400 },
      { account: 'wallet:alice', token: 'FUEL', amount: 400 },
    ]);
    const [m2] = engine.generate(1);
    engine.accept(m2.id, 'alice', 'ship-1', []);
    const ammoBefore2 = ledger.balance('wallet:alice', 'AMMO'); // 0 left + 600 top-up = 600
    engine.fail(m2.id, 0, 500);
    expect(ammoBefore2 - ledger.balance('wallet:alice', 'AMMO')).toBe(100);
    expect(ledger.balance('burn', 'AMMO')).toBe(40 + 100); // cumulative with the complete() burn above
  });
});

describe('server-resolved run (fireEvents)', () => {
  it('lands and pays out when the trace kills the raiders', () => {
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      (m) => killAllTrace(m.id, m.distance, m.cargo, SHIP1.engine, 0),
      (r, m) => r.outcome === 'landed'
        && raiderCount(m.id, m.distance, m.cargo) > 0
        && r.raidersDestroyed === raiderCount(m.id, m.distance, m.cargo),
    );
    engine.accept(m.id, 'alice', 'ship-1', []);
    const payout = engine.complete(m.id, fireEvents);
    expect(engine.get(m.id)?.status).toBe('done');
    expect(payout.outcome).toBe('landed');
    expect(payout.rewardGold).toBeGreaterThan(0);
    expect(payout.delivered).toBe(Math.min(20, m.amount)); // all raiders dead ⇒ no spill
  });

  it('an empty trace on a raider route spills cargo and damages hull, still lands if hull survives', () => {
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! > 0,
    );
    engine.accept(m.id, 'alice', 'ship-1', []);
    const payout = engine.complete(m.id, fireEvents);
    expect(engine.get(m.id)?.status).toBe('done');
    expect(payout.outcome).toBe('landed');
    expect(payout.delivered).toBeLessThan(Math.min(20, m.amount));
    expect(hull.current('ship-1', 8)).toBeLessThan(8);
  });

  it('routes to the fail settlement when the run voids (hull to 0)', () => {
    // A hull-1 ship: a single unkilled raider (defense 0 ⇒ never dodges)
    // is enough to force the void, without depending on rock RNG.
    const fragileShip: Ship = { id: 'fragile-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 1, hull: 1 };
    const db2 = new Database(':memory:');
    const ledger2 = new Ledger(db2);
    const fleet2 = new DevFleet([fragileShip], []);
    const market2 = new CrewMarket(db2, fleet2);
    const engine2 = new MissionEngine(db2, ledger2, new Settlement(db2, stages), market2, fleet2, new HullState(db2));
    ledger2.post('seed', [
      { account: 'mint', token: 'GOLD', amount: -100 },
      { account: 'wallet:alice', token: 'GOLD', amount: 100 },
      { account: 'mint', token: 'FUEL', amount: -400 },
      { account: 'wallet:alice', token: 'FUEL', amount: 400 },
    ]);
    let m: Mission | undefined;
    for (let i = 0; i < 40 && !m; i++) {
      const [c] = engine2.generate(1);
      if (c.distance > 120) m = c; // guarantees at least one raider on the route
    }
    if (!m) throw new Error('unreachable');
    engine2.accept(m.id, 'alice', 'fragile-1', []);
    const payout = engine2.complete(m.id, []);
    expect(payout.outcome).toBe('void');
    expect(payout.rewardGold).toBe(0);
    expect(payout.crewShares).toEqual([]);
    expect(engine2.get(m.id)?.status).toBe('failed');
    expect(ledger2.balance('settlement', 'GOLD')).toBe(m.feeGold); // fee still forfeited
    expect(ledger2.balance(`escrow:${m.id}`, 'GOLD')).toBe(0);
  });

  it('a completed run credits kills the server scored, never a client-claimed count', () => {
    const { m, fireEvents } = findMissionWithTrace(
      engine,
      SHIP1,
      (m) => killOneTrace(m.id, m.distance, m.cargo, SHIP1.engine, 0, 0),
      (r, m) => r.outcome === 'landed'
        && r.raidersDestroyed === 1
        && raiderCount(m.id, m.distance, m.cargo) >= 2, // prove the cap, not a trivial 1-of-1
    );
    engine.accept(m.id, 'alice', 'ship-1', []);
    const goldBefore = ledger.balance('wallet:alice', 'GOLD');
    const payout = engine.complete(m.id, fireEvents);
    const nonBountyReward = payout.delivered * TOKENS[m.cargo].unitPriceGold
      + Math.floor(hazardPay(m.distance, m.cargo) * payout.delivered / m.amount);
    expect(payout.rewardGold - nonBountyReward).toBe(BOUNTY_PER_KILL); // exactly one kill's bounty
    expect(ledger.balance('wallet:alice', 'GOLD') - goldBefore).toBe(payout.rewardGold); // no crew to split with
  });
});

describe('hauling', () => {
  it('owned hauling crew boosts ship cargo', () => {
    const tugShip: Ship = { id: 'tug-1', owner: 'alice', engine: 10, cargo: 3, crewSlots: 2, hull: 8 };
    const haulerCrew: CrewMember = { id: 'dock-1', owner: 'alice', skills: { hauling: 20 } };
    const db2 = new Database(':memory:');
    const ledger2 = new Ledger(db2);
    const fleet2 = new DevFleet([tugShip], [haulerCrew]);
    const market2 = new CrewMarket(db2, fleet2);
    const engine2 = new MissionEngine(db2, ledger2, new Settlement(db2, stages), market2, fleet2, new HullState(db2));
    ledger2.post('seed', [
      { account: 'mint', token: 'GOLD', amount: -100 },
      { account: 'wallet:alice', token: 'GOLD', amount: 100 },
      { account: 'mint', token: 'FUEL', amount: -400 },
      { account: 'wallet:alice', token: 'FUEL', amount: 400 },
    ]);
    // tug-1 owns 3 cargo capacity; own crew dock-1 (hauling 20) needs no listing
    const { m, fireEvents } = findMissionWithTrace(
      engine2,
      tugShip,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! === 0,
      [haulerCrew],
    );
    engine2.accept(m.id, 'alice', 'tug-1', ['dock-1']);
    const payout = engine2.complete(m.id, fireEvents);
    // Since amounts are >= 5 and effective cargo is 23, this always > 3 proving hauling counted
    expect(payout.delivered).toBe(Math.min(23, m.amount));
    expect(Math.min(23, m.amount)).toBeGreaterThan(3);
  });

  it('hired hauling crew boosts cargo when owned by someone else', () => {
    const smallShip: Ship = { id: 'ship-1', owner: 'alice', engine: 10, cargo: 3, crewSlots: 2, hull: 8 };
    const hiredHauler: CrewMember = { id: 'dock-h', owner: 'bob', skills: { hauling: 20 } };
    const db2 = new Database(':memory:');
    const ledger2 = new Ledger(db2);
    const fleet2 = new DevFleet([smallShip], [hiredHauler]);
    const market2 = new CrewMarket(db2, fleet2);
    const engine2 = new MissionEngine(db2, ledger2, new Settlement(db2, stages), market2, fleet2, new HullState(db2));
    ledger2.post('seed', [
      { account: 'mint', token: 'GOLD', amount: -100 },
      { account: 'wallet:alice', token: 'GOLD', amount: 100 },
      { account: 'mint', token: 'FUEL', amount: -400 },
      { account: 'wallet:alice', token: 'FUEL', amount: 400 },
    ]);
    // bob lists his hauler crew member for hire
    market2.list('dock-h', 'bob', 10);
    const { m, fireEvents } = findMissionWithTrace(
      engine2,
      smallShip,
      () => [],
      (r) => r.outcome === 'landed' && r.raiderHits! === 0,
      [hiredHauler],
    );
    // alice accepts with hired crew
    engine2.accept(m.id, 'alice', 'ship-1', ['dock-h']);
    const payout = engine2.complete(m.id, fireEvents);
    // Amounts are >= 5 and cargo boost is 20, so delivered > 3 proves hired hauling counted
    expect(payout.delivered).toBe(Math.min(23, m.amount));
    expect(Math.min(23, m.amount)).toBeGreaterThan(3);
  });
});

describe('generate batch cap', () => {
  it('does not over-issue against the single-call snapshot of remaining needs', () => {
    const smallStages: Stage[] = [{ index: 0, name: 'Small Dock', needs: { LOG: 8 } }];
    const db2 = new Database(':memory:');
    const ledger2 = new Ledger(db2);
    const { ships, crew } = devFixtures();
    const fleet2 = new DevFleet(ships, crew);
    const market2 = new CrewMarket(db2, fleet2);
    const engine2 = new MissionEngine(db2, ledger2, new Settlement(db2, smallStages), market2, fleet2, new HullState(db2));

    const missions = engine2.generate(3);
    const total = missions.reduce((sum, m) => sum + m.amount, 0);
    expect(total).toBeLessThanOrEqual(8);
  });
});

describe('mine', () => {
  it('mine() lists only the callers active missions', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    expect(engine.mine('alice').map((x) => x.id)).toEqual([m.id]);
    expect(engine.mine('bob')).toEqual([]);
    engine.fail(m.id);
    expect(engine.mine('alice')).toEqual([]);
  });
});

describe('fail', () => {
  it('forfeits the fee to the settlement', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    engine.fail(m.id);
    expect(ledger.balance('settlement', 'GOLD')).toBe(m.feeGold);
    expect(ledger.balance(`escrow:${m.id}`, 'GOLD')).toBe(0);
    expect(engine.get(m.id)?.status).toBe('failed');
  });

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

  it('fail burns reported shells too, capped', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    const ammoBefore = ledger.balance('wallet:alice', 'AMMO'); // 40, seeded
    engine.fail(m.id, 10, 6);
    expect(ledger.balance('wallet:alice', 'AMMO')).toBe(ammoBefore - 6);
    expect(ledger.balance('burn', 'AMMO')).toBe(6);
  });

  it('rejects negative or non-finite ammo reports', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    expect(() => engine.fail(m.id, 0, -1)).toThrow(/non-negative/);
    expect(() => engine.fail(m.id, 0, NaN)).toThrow(/non-negative/);
  });
});

describe('stage airdrop', () => {
  it('splits fees + STAGE_BONUS among builders by value when a stage completes', () => {
    const smallStages: Stage[] = [
      { index: 0, name: 'Small Dock', needs: { LOG: 5 } },
      { index: 1, name: 'Rise', needs: { LOG: 100 } },
    ];
    const db2 = new Database(':memory:');
    const ledger2 = new Ledger(db2);
    const { ships, crew } = devFixtures();
    const fleet2 = new DevFleet(ships, crew);
    const market2 = new CrewMarket(db2, fleet2);
    const contrib2 = new Contributions(db2);
    const engine2 = new MissionEngine(db2, ledger2, new Settlement(db2, smallStages), market2, fleet2, new HullState(db2), contrib2);
    ledger2.post('seed', [
      { account: 'mint', token: 'GOLD', amount: -100 }, { account: 'wallet:alice', token: 'GOLD', amount: 100 },
      { account: 'mint', token: 'FUEL', amount: -400 }, { account: 'wallet:alice', token: 'FUEL', amount: 400 },
      { account: 'mint', token: 'AMMO', amount: -40 }, { account: 'wallet:alice', token: 'AMMO', amount: 40 },
    ]);
    const { m, fireEvents } = findMissionWithTrace(
      engine2, SHIP1,
      (mm) => killAllTrace(mm.id, mm.distance, mm.cargo, SHIP1.engine, 0),
      (r) => r.outcome === 'landed',
    );
    engine2.accept(m.id, 'alice', 'ship-1', []);
    const goldBefore = ledger2.balance('wallet:alice', 'GOLD');
    const payout = engine2.complete(m.id, fireEvents);
    expect(payout.stageCompleted).toBe(true);
    expect(payout.airdrop!.total).toBeGreaterThanOrEqual(500); // STAGE_BONUS + fees
    expect(payout.airdrop!.recipients).toBe(1); // alice is the sole builder
    // fees drained; alice (sole builder) gets the whole pool on top of her reward
    expect(ledger2.balance('settlement', 'GOLD')).toBe(0);
    expect(ledger2.balance('wallet:alice', 'GOLD')).toBe(goldBefore + payout.rewardGold + payout.airdrop!.total);
    expect(contrib2.unpaid()).toEqual([]); // marked paid — no double airdrop next stage
  });
});
