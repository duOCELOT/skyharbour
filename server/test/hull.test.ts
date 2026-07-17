import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../src/ledger.js';
import { HullState, REPAIR_PER_GOLD_POINT } from '../src/hull.js';

describe('HullState', () => {
  let db: Database.Database;
  let ledger: Ledger;
  let hull: HullState;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new Ledger(db);
    hull = new HullState(db);
    ledger.post('seed', [
      { account: 'mint', token: 'GOLD', amount: -100 },
      { account: 'wallet:alice', token: 'GOLD', amount: 100 },
    ]);
  });

  it('current() defaults to max for a ship never touched', () => {
    expect(hull.current('ship-1', 8)).toBe(8);
  });

  it('set() persists and current() reflects it', () => {
    hull.set('ship-1', 5);
    expect(hull.current('ship-1', 8)).toBe(5);
  });

  it('damage() subtracts points and floors at 1, never 0 — the ship landed', () => {
    expect(hull.damage('ship-1', 8, 3)).toBe(5);
    expect(hull.damage('ship-1', 8, 100)).toBe(1);
    expect(hull.current('ship-1', 8)).toBe(1);
  });

  it('damage() ignores negative point counts (no accidental healing)', () => {
    hull.set('ship-1', 5);
    expect(hull.damage('ship-1', 8, -3)).toBe(5);
  });

  it('repair() charges 4 GOLD per point restored, wallet to settlement', () => {
    hull.set('ship-1', 3);
    const r = hull.repair(ledger, 'alice', 'ship-1', 8, 8);
    expect(r.spent).toBe(REPAIR_PER_GOLD_POINT * 5);
    expect(r.hull).toBe(8);
    expect(hull.current('ship-1', 8)).toBe(8);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(100 - REPAIR_PER_GOLD_POINT * 5);
    expect(ledger.balance('settlement', 'GOLD')).toBe(REPAIR_PER_GOLD_POINT * 5);
  });

  it('repair() clamps the target to max even if toPoints overshoots', () => {
    hull.set('ship-1', 3);
    const r = hull.repair(ledger, 'alice', 'ship-1', 8, 999);
    expect(r.hull).toBe(8);
    expect(r.spent).toBe(REPAIR_PER_GOLD_POINT * 5);
  });

  it('repair() throws "nothing to repair" when already at or above target', () => {
    hull.set('ship-1', 8);
    expect(() => hull.repair(ledger, 'alice', 'ship-1', 8, 8)).toThrow(/nothing to repair/);
    expect(() => hull.repair(ledger, 'alice', 'ship-1', 8, 4)).toThrow(/nothing to repair/);
  });

  it('repair() rejects a fractional or negative target — hull stays integral', () => {
    hull.set('ship-1', 3);
    expect(() => hull.repair(ledger, 'alice', 'ship-1', 8, 7.25)).toThrow(/non-negative integer/);
    expect(() => hull.repair(ledger, 'alice', 'ship-1', 8, -1)).toThrow(/non-negative integer/);
    expect(hull.current('ship-1', 8)).toBe(3); // untouched
  });

  it('repair() is atomic: insufficient GOLD leaves hull untouched', () => {
    hull.set('ship-1', 1);
    ledger.post('drain', [
      { account: 'wallet:alice', token: 'GOLD', amount: -100 },
      { account: 'burn', token: 'GOLD', amount: 100 },
    ]);
    expect(() => hull.repair(ledger, 'alice', 'ship-1', 8, 8)).toThrow();
    expect(hull.current('ship-1', 8)).toBe(1);
  });
});
