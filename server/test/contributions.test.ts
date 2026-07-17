import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Contributions } from '../src/contributions.js';

let db: Database.Database; let c: Contributions;
beforeEach(() => { db = new Database(':memory:'); c = new Contributions(db); });

describe('contributions', () => {
  it('accumulates deliveries and value per wallet', () => {
    c.record('alice', 30); c.record('alice', 20); c.record('bob', 10);
    expect(c.valueOf('alice')).toBe(50);
    expect(c.leaderboard()).toEqual([
      { wallet: 'alice', deliveries: 2, value: 50 },
      { wallet: 'bob', deliveries: 1, value: 10 },
    ]);
    expect(c.totalValue()).toBe(60);
  });
  it('orders by value desc, deliveries breaks a tie', () => {
    c.record('a', 100); c.record('b', 100); c.record('b', 0);
    expect(c.leaderboard()[0].wallet).toBe('b'); // same value, more trips
  });
  it('floors fractional value and guards negatives', () => {
    c.record('c', 5.9); expect(c.valueOf('c')).toBe(5);
    c.record('c', -10); expect(c.valueOf('c')).toBe(5);
  });
});

describe('unpaid tracking (airdrop basis)', () => {
  it('unpaid = value − paid; markPaid clears it so a delivery is airdropped once', () => {
    c.record('alice', 40); c.record('bob', 10);
    expect(c.unpaid()).toEqual([{ wallet: 'alice', unpaid: 40 }, { wallet: 'bob', unpaid: 10 }]);
    c.markPaid();
    expect(c.unpaid()).toEqual([]);
    c.record('alice', 5); // new delivery after the payout
    expect(c.unpaid()).toEqual([{ wallet: 'alice', unpaid: 5 }]);
  });
});
