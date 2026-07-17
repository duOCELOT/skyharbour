import type Database from 'better-sqlite3';
import { Ledger } from './ledger.js';
import type { FleetSource } from './fleet.js';

export const STARTER_GOLD = 100;
// 3 average runs (avg distance 100, minFuel ≈ distance) — spec §6
export const STARTER_FUEL = 300;
export const STARTER_AMMO = 20;

export class Grants {
  constructor(
    private db: Database.Database,
    private ledger: Ledger,
    private fleet: FleetSource,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS grants (wallet TEXT PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  }

  grantShipOwner(wallet: string): boolean {
    // Real chain wallets can own zero ships (plan 2) — DevFleet always grants a test trio, so this guard is exercised via a stub FleetSource in tests.
    if (this.fleet.shipsOf(wallet).length === 0) return false;
    const claimed = this.db.prepare('SELECT 1 FROM grants WHERE wallet = ?').get(wallet);
    if (claimed) return false;
    const txn = this.db.transaction(() => {
      this.db.prepare('INSERT INTO grants (wallet) VALUES (?)').run(wallet);
      this.ledger.post(`starter grant ${wallet}`, [
        { account: 'mint', token: 'GOLD', amount: -STARTER_GOLD },
        { account: `wallet:${wallet}`, token: 'GOLD', amount: STARTER_GOLD },
        { account: 'mint', token: 'FUEL', amount: -STARTER_FUEL },
        { account: `wallet:${wallet}`, token: 'FUEL', amount: STARTER_FUEL },
        { account: 'mint', token: 'AMMO', amount: -STARTER_AMMO },
        { account: `wallet:${wallet}`, token: 'AMMO', amount: STARTER_AMMO },
      ]);
    });
    txn();
    return true;
  }

  airdropFuel(wallets: string[], amount: number): number {
    // Input validation
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('airdrop amount must be a positive integer');
    }
    if (!Array.isArray(wallets) || wallets.length === 0 || !wallets.every(w => typeof w === 'string' && w.length > 0)) {
      throw new Error('airdrop wallets must be a non-empty string array');
    }

    // Atomic batch credit all wallets or fail entirely
    const txn = this.db.transaction(() => {
      for (const w of wallets) {
        this.ledger.post(`fuel airdrop ${w}`, [
          { account: 'mint', token: 'FUEL', amount: -amount },
          { account: `wallet:${w}`, token: 'FUEL', amount },
        ]);
      }
    });
    txn();

    // TODO(plan-2): gate behind operator auth when signature login replaces dev header auth

    return wallets.length;
  }
}
