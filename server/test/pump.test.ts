import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../src/ledger.js';
import { buyFuel, buyProvision, RATES } from '../src/pump.js';

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
    expect(r.fuelCredited).toBe(10 * RATES.FUEL);
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

  it('rejects purchases whose fuel would overflow safe integers', () => {
    expect(() => buyFuel(ledger, 'alice', 2251799813685248)).toThrow(/positive integer/);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(50);
  });

  it('sells ammo at 1 GOLD = 2 shells into the same treasury', () => {
    const r = buyProvision(ledger, 'alice', 10, 'AMMO');
    expect(r.credited).toBe(20);
    expect(ledger.balance('wallet:alice', 'AMMO')).toBe(20);
    expect(ledger.balance('settlement', 'GOLD')).toBe(10);
  });

  it('buyFuel alias unchanged', () => {
    expect(buyFuel(ledger, 'alice', 5).fuelCredited).toBe(20);
  });
});
