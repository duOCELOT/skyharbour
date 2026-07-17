import { describe, it, expect } from 'vitest';
import { hashSeed, mkWorld, fuelSkill, defenseSkill, mkRun, stepRun, resolveRun, raiderCount as clientRaiderCount, cannonDamage, cannonCooldown, applyRaiderHit, registerKill, fireShot } from '../../../client/flightMath.js';
import { minFuel, raiderCount as serverRaiderCount } from '../../src/validation.js';
import type { Ship } from '../../src/fleet.js';

const ship: Ship = { id: 's', owner: 'a', engine: 10, cargo: 20, crewSlots: 2, hull: 8 };
const fuelCrew = [{ id: 'c', skills: { fuel: 20 } }];

describe('world generation', () => {
  it('is deterministic per seed', () => {
    expect(mkWorld('m-1', 100)).toEqual(mkWorld('m-1', 100));
    expect(hashSeed('m-1')).not.toBe(hashSeed('m-2'));
  });
  it('keeps rocks inside the corridor and off the pads', () => {
    const w = mkWorld('m-1', 120);
    for (const r of w.rocks) {
      expect(Math.abs(r.x)).toBeLessThan(120);
      expect(r.z).toBeGreaterThan(400); // (120-80) * WORLD_SCALE
      expect(r.z).toBeLessThan(800); // (120-40) * WORLD_SCALE
    }
    expect(w.target.z).toBe(1225); // distance * WORLD_SCALE + 25
  });
  it('short routes 60<d<=80 carry rocks in the tight corridor', () => {
    const w = mkWorld('short', 70);
    expect(w.rocks.length).toBeGreaterThan(0);
    for (const r of w.rocks) {
      expect(r.z).toBeGreaterThan(300); // 30 * WORLD_SCALE
      expect(r.z).toBeLessThan(400); // (70-30) * WORLD_SCALE
      expect(Math.abs(r.x)).toBeLessThan(120);
    }
  });
  it('no rocks at or below 60', () => {
    expect(mkWorld('hop', 60).rocks).toEqual([]);
    expect(mkWorld('hop2', 50).rocks).toEqual([]);
  });
});

describe('skills', () => {
  it('caps fuel skill at 50 and defense at 90', () => {
    expect(fuelSkill([{ id: 'a', skills: { fuel: 40 } }, { id: 'b', skills: { fuel: 40 } }])).toBe(50);
    expect(defenseSkill([{ id: 'a', skills: { defense: 95 } }])).toBe(90);
    expect(fuelSkill([])).toBe(0);
  });
});

describe('a straight full-throttle run', () => {
  function flyStraight(crew: { id: string; skills: Record<string, number> }[]) {
    const distance = 100;
    const world = mkWorld('no-rocks', distance);
    world.rocks = []; // clear hazards: this test is about the fuel/duration envelope
    const run = mkRun(ship, crew, distance, 1000);
    while (!run.done) stepRun(run, 0.1, { yaw: 0, throttle: 1 }, world);
    return { run, distance };
  }

  it('lands honestly at full throttle', () => {
    const { run } = flyStraight(fuelCrew);
    expect(run.outcome).toBe('landed');
  });

  it('burns at least the server minimum fuel', () => {
    const { run } = flyStraight(fuelCrew);
    expect(Math.ceil(run.fuel)).toBeGreaterThanOrEqual(minFuel(100, [{ id: 'c', owner: 'x', skills: { fuel: 20 } }]));
  });

  it('cannot be faster than ENGINE allows', () => {
    const { run } = flyStraight([]);
    expect(run.t).toBeGreaterThanOrEqual(100 / ship.engine);
  });
});

describe('production dt sweep', () => {
  // Reproduces the reviewer's finding: at a real frame dt (1/60s) float
  // accumulation in run.t vs run.pos.z must not stop an honest full-throttle
  // run from reaching the landing radius. Guards stepRun's own geometry, not
  // the (now-retired) telemetry/validateRun report-then-bound contract.
  const ships = [
    { id: 's1', owner: 'a', engine: 10, cargo: 20, crewSlots: 2, hull: 8 },
    { id: 's2', owner: 'a', engine: 15, cargo: 10, crewSlots: 2, hull: 8 },
  ];

  for (const s of ships) {
    for (let distance = 50; distance <= 150; distance += 5) {
      it(`ship engine=${s.engine} distance=${distance} lands at dt=1/60`, () => {
        const world = mkWorld(`sweep-${s.engine}-${distance}`, distance);
        world.rocks = [];
        const run = mkRun(s, [], distance, distance * 10);
        while (!run.done) stepRun(run, 1 / 60, { yaw: 0, throttle: 1 }, world);
        expect(run.outcome).toBe('landed');
      });
    }
  }
});

describe('hauling', () => {
  it('hauling crew raise delivered cargo past the hull cap', () => {
    // Same formula resolveRun uses for `loaded`/`cargoDelivered` (flightMath.js
    // resolveRun step 5): ship.cargo + haulingSkill(crew), capped by amount.
    const hauler = { id: 'h', skills: { hauling: 20 } };
    const r = resolveRun({
      missionId: 'haul', distance: 100, cargo: 'LOG', amount: 25,
      ship: { cargo: 8, hull: 8, engine: 10 }, crew: [hauler],
      startHull: 8, ammoAvailable: 0, fireEvents: [],
    });
    expect(r.ok).toBe(true);
    expect(r.cargoDelivered).toBe(Math.min(8 + 20, 25));
  });
});

describe('failure outcomes', () => {
  it('runs dry when the fuel budget is exhausted', () => {
    const world = mkWorld('x', 500); world.rocks = [];
    const run = mkRun(ship, [], 500, 50); // only 50 FUEL for a 500 crossing
    while (!run.done) stepRun(run, 0.1, { yaw: 0, throttle: 1 }, world);
    expect(run.outcome).toBe('dry');
  });

  it('a rock strike with zero defense costs hull', () => {
    const world = { rocks: [{ x: 0, y: 0, z: 10, r: 8 }], islands: [], target: { x: 0, y: 0, z: 100 } };
    const run = mkRun(ship, [], 100, 1000);
    let struck = false;
    while (!run.done && run.t < 5) {
      stepRun(run, 0.05, { yaw: 0, throttle: 1 }, world, () => 1); // rng=1 → never dodged
      if (run.hull < 8) { struck = true; break; }
    }
    expect(struck).toBe(true);
  });
});

describe('mkRun starting hull', () => {
  it('defaults to the ship\'s full hull when no startHull is given', () => {
    expect(mkRun(ship, [], 100, 1000).hull).toBe(8);
  });
  it('starts battered when a lower startHull is passed (persisted damage)', () => {
    expect(mkRun(ship, [], 100, 1000, 0, 3).hull).toBe(3);
  });
  it('clamps a startHull above the ship\'s max down to ship.hull', () => {
    expect(mkRun(ship, [], 100, 1000, 0, 99).hull).toBe(8);
  });
  it('a battered run breaches sooner: fewer rock strikes needed to hit hull<=0', () => {
    const world = { rocks: [{ x: 0, y: 0, z: 10, r: 8 }], islands: [], target: { x: 0, y: 0, z: 100 } };
    const run = mkRun(ship, [], 100, 1000, 0, 1); // one hit from breach
    stepRun(run, 0.05, { yaw: 0, throttle: 1 }, world, () => 1); // rng=1 → never dodged
    expect(run.hull).toBeLessThanOrEqual(0);
    expect(run.done).toBe(true);
    expect(run.outcome).toBe('void');
  });
});

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
    expect(cannonDamage(0)).toBe(1);
    expect(cannonDamage(25)).toBe(2);
    expect(cannonDamage(50)).toBe(3);
    expect(cannonCooldown(0)).toBeCloseTo(0.8);
    expect(cannonCooldown(50)).toBeCloseTo(0.4);
  });
});

describe('combat model', () => {
  it('raiders spawn only beyond 120 and deterministically', () => {
    expect(mkWorld('m1', 100, 'LOG').raiders).toEqual([]);
    const w = mkWorld('m1', 200, 'LOG');
    expect(w.raiders.length).toBe(clientRaiderCount('m1', 200, 'LOG'));
    expect(mkWorld('m1', 200, 'LOG')).toEqual(w);
    for (const r of w.raiders) {
      expect(r.z).toBeGreaterThan(200 * 0.45 * 10); expect(r.z).toBeLessThan(1600); expect(r.hp).toBe(2);
    }
  });
  it('old worlds unchanged by the raider draw', () => {
    const w = mkWorld('short', 70); // pre-combat test world
    expect(w.raiders).toEqual([]);
    expect(w.rocks.length).toBeGreaterThan(0); // still rocky as before
  });
  it('a raider hit costs hull and is tallied; dodge protects', () => {
    const ship = { id: 's', owner: 'a', engine: 10, cargo: 20, crewSlots: 2, hull: 8 };
    const run = mkRun(ship, [], 200, 1000);
    expect(applyRaiderHit(run, () => 0.99)).toBe('hit');
    expect(run.raiderHits).toBe(1); expect(run.hull).toBe(7);
    const guarded = mkRun(ship, [{ id: 'w', skills: { defense: 90 } }], 200, 1000);
    expect(applyRaiderHit(guarded, () => 0.5)).toBe('dodged');
  });
  it('registerKill tallies a kill on the run', () => {
    const ship = { id: 's', owner: 'a', engine: 10, cargo: 20, crewSlots: 2, hull: 8 };
    const run = mkRun(ship, [], 200, 1000);
    registerKill(run);
    expect(run.kills).toBe(1);
  });
});

describe('ammo budget', () => {
  it('the trigger obeys the shell budget', () => {
    const run = mkRun(ship, [], 200, 1000, 2);
    expect(fireShot(run)).toBe(true);
    expect(fireShot(run)).toBe(true);
    expect(fireShot(run)).toBe(false); // dry
    expect(run.shots).toBe(2);
  });
});
