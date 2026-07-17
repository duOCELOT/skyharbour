import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { FleetSource } from '../src/fleet.js';
import { Ledger } from '../src/ledger.js';
import { DevFleet, devFixtures } from '../src/fleet.js';
import { Grants, STARTER_GOLD, STARTER_FUEL, STARTER_AMMO } from '../src/grants.js';

let db: Database.Database;
let ledger: Ledger;
let grants: Grants;
beforeEach(() => {
  db = new Database(':memory:');
  ledger = new Ledger(db);
  const { ships, crew } = devFixtures();
  grants = new Grants(db, ledger, new DevFleet(ships, crew));
});

describe('ship-owner grant', () => {
  it('grants once to a ship owner', () => {
    expect(grants.grantShipOwner('alice')).toBe(true);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(STARTER_GOLD);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(STARTER_FUEL);
    expect(ledger.balance('wallet:alice', 'AMMO')).toBe(STARTER_AMMO);
  });
  it('is idempotent per wallet', () => {
    grants.grantShipOwner('alice');
    expect(grants.grantShipOwner('alice')).toBe(false);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(STARTER_GOLD);
  });
  it('grants to any wallet (all now own synthesized ships)', () => {
    expect(grants.grantShipOwner('carol')).toBe(true);
    expect(ledger.balance('wallet:carol', 'GOLD')).toBe(STARTER_GOLD);
  });
  it('refuses wallets with no ship (chain-gateway contract)', () => {
    const empty: FleetSource = {
      shipsOf: () => [],
      crewOf: () => [],
      getShip: () => undefined,
      getCrew: () => undefined,
    };
    const db2 = new Database(':memory:');
    const ledger2 = new Ledger(db2);
    const g2 = new Grants(db2, ledger2, empty);
    expect(g2.grantShipOwner('carol')).toBe(false);
    expect(ledger2.balance('wallet:carol', 'GOLD')).toBe(0);
  });
  it('is retry-safe if ledger.post throws (atomic claim + mint)', () => {
    const originalPost = ledger.post.bind(ledger);
    let callCount = 0;
    ledger.post = vi.fn((memo, legs) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('simulated ledger.post failure');
      }
      return originalPost(memo, legs);
    });

    // First call should throw and leave no grants row
    expect(() => grants.grantShipOwner('alice')).toThrow('simulated ledger.post failure');
    const grantsCheck = db.prepare('SELECT 1 FROM grants WHERE wallet = ?').get('alice');
    expect(grantsCheck).toBeUndefined();
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(0);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(0);

    // Second call should succeed and grant normally
    expect(grants.grantShipOwner('alice')).toBe(true);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(STARTER_GOLD);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(STARTER_FUEL);
  });
});

describe('fuel airdrop', () => {
  it('credits FUEL to each wallet', () => {
    expect(grants.airdropFuel(['alice', 'bob'], 25)).toBe(2);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(25);
    expect(ledger.balance('wallet:bob', 'FUEL')).toBe(25);
  });

  it('rejects negative amount and credits nothing', () => {
    expect(() => grants.airdropFuel(['alice'], -50)).toThrow('airdrop amount must be a positive integer');
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(0);
  });

  it('rejects non-integer amount', () => {
    expect(() => grants.airdropFuel(['alice'], 25.5)).toThrow('airdrop amount must be a positive integer');
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(0);
  });

  it('rejects empty wallets array', () => {
    expect(() => grants.airdropFuel([], 25)).toThrow('airdrop wallets must be a non-empty string array');
  });
});
