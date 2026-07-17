import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger, InsufficientFunds, UnbalancedPost, UnknownToken } from '../src/ledger.js';

let ledger: Ledger;
beforeEach(() => {
  ledger = new Ledger(new Database(':memory:'));
});

describe('ledger', () => {
  it('mints and reads balances', () => {
    ledger.post('grant', [
      { account: 'mint', token: 'GOLD', amount: -100 },
      { account: 'wallet:alice', token: 'GOLD', amount: 100 },
    ]);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(100);
    expect(ledger.balance('mint', 'GOLD')).toBe(-100);
  });

  it('rejects unbalanced posts', () => {
    expect(() =>
      ledger.post('bad', [{ account: 'wallet:alice', token: 'GOLD', amount: 5 }]),
    ).toThrow(UnbalancedPost);
  });

  it('rejects overdrafts on non-mint accounts and rolls back atomically', () => {
    ledger.post('grant', [
      { account: 'mint', token: 'GOLD', amount: -10 },
      { account: 'wallet:alice', token: 'GOLD', amount: 10 },
    ]);
    expect(() =>
      ledger.post('overspend', [
        { account: 'wallet:alice', token: 'GOLD', amount: -50 },
        { account: 'wallet:bob', token: 'GOLD', amount: 50 },
      ]),
    ).toThrow(InsufficientFunds);
    // rollback: nothing moved
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(10);
    expect(ledger.balance('wallet:bob', 'GOLD')).toBe(0);
  });

  it('handles multi-token atomic posts', () => {
    ledger.post('setup', [
      { account: 'mint', token: 'FUEL', amount: -60 },
      { account: 'wallet:alice', token: 'FUEL', amount: 60 },
    ]);
    ledger.post('burn fuel', [
      { account: 'wallet:alice', token: 'FUEL', amount: -20 },
      { account: 'burn', token: 'FUEL', amount: 20 },
    ]);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(40);
    expect(ledger.balance('burn', 'FUEL')).toBe(20);
  });

  it('rejects non-integer amounts', () => {
    expect(() =>
      ledger.post('float', [
        { account: 'mint', token: 'GOLD', amount: -0.5 },
        { account: 'wallet:alice', token: 'GOLD', amount: 0.5 },
      ]),
    ).toThrow();
  });

  it('post with unknown token throws UnknownToken and leaves no balance', () => {
    expect(() =>
      ledger.post('bad token', [
        { account: 'mint', token: 'DOGE' as any, amount: -100 },
        { account: 'wallet:alice', token: 'DOGE' as any, amount: 100 },
      ]),
    ).toThrow(UnknownToken);
    // verify no balance was created
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(0);
  });

  it('balance() with unknown token throws UnknownToken', () => {
    expect(() => ledger.balance('wallet:alice', 'DOGE' as any)).toThrow(UnknownToken);
  });

  it('rejects leg amount that is not a safe integer', () => {
    expect(() =>
      ledger.post('unsafe int', [
        { account: 'mint', token: 'GOLD', amount: -(Number.MAX_SAFE_INTEGER + 1) },
        { account: 'wallet:alice', token: 'GOLD', amount: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrow();
  });

  it('rejects when balance would exceed safe integer', () => {
    // First, set up a large balance close to MAX_SAFE_INTEGER
    ledger.post('setup', [
      { account: 'mint', token: 'GOLD', amount: -(Number.MAX_SAFE_INTEGER - 10) },
      { account: 'wallet:alice', token: 'GOLD', amount: Number.MAX_SAFE_INTEGER - 10 },
    ]);
    // Now try to add more that would push it over the safe limit
    expect(() =>
      ledger.post('overflow', [
        { account: 'mint', token: 'GOLD', amount: -100 },
        { account: 'wallet:alice', token: 'GOLD', amount: 100 },
      ]),
    ).toThrow();
    // Verify rollback: balance should still be at the original amount
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(Number.MAX_SAFE_INTEGER - 10);
  });
});
