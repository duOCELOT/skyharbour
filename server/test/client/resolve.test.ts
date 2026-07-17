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
  // M's raiderCount is only 1 — a single-event trace would "prove" the cap
  // even with no cap logic at all. Use FIRERUNE cargo, which bumps the
  // raider count to >=2 for this seed, so the trace has >=2 cadence-valid
  // shots and the ammoAvailable:1 cap is actually exercised.
  const M2 = { missionId: 'mtest-1', distance: 200, cargo: 'FIRERUNE', amount: 10 };
  const N2 = raiderCount(M2.missionId, M2.distance, M2.cargo);
  expect(N2).toBeGreaterThanOrEqual(2);
  const tl2 = raiderTimeline(M2.missionId, M2.distance, M2.cargo, ship.engine);
  // one in-window shot per raider, in non-decreasing time order, each pair
  // well beyond cannon cooldown apart (engage windows don't overlap here).
  const fe = tl2.map((w, i) => ({ t: w.engageStart + 0.1, raider: i }));

  const capped = resolveRun({ ...M2, ship, crew, startHull: 8, ammoAvailable: 1, fireEvents: fe });
  expect(capped.ok).toBe(true);
  expect(capped.ammoSpent).toBe(1); // capped even though N2 valid shots exist

  const uncapped = resolveRun({ ...M2, ship, crew, startHull: 8, ammoAvailable: 99, fireEvents: fe });
  expect(uncapped.ok).toBe(true);
  expect(uncapped.ammoSpent).toBe(N2); // proves the low cap above was the limiter, not trace length
});

it('rejects a malformed trace', () => {
  expect(resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 5, fireEvents: [{ t: -1, raider: 0 }] }).ok).toBe(false);
  expect(resolveRun({ ...M, ship, crew, startHull: 8, ammoAvailable: 5, fireEvents: [{ t: 2, raider: 0 }, { t: 1, raider: 0 }] }).ok).toBe(false);
});

it('rejects malformed trace elements without throwing', () => {
  const base = { ...M, ship, crew, startHull: 8, ammoAvailable: 5 };
  const malformedTraces: unknown[][] = [[null], [42], ['x'], [{ t: 1, raider: 0 }, null]];
  for (const fireEvents of malformedTraces) {
    let r: ReturnType<typeof resolveRun> | undefined;
    expect(() => { r = resolveRun({ ...base, fireEvents } as Parameters<typeof resolveRun>[0]); }).not.toThrow();
    expect(r?.ok).toBe(false);
  }
});
