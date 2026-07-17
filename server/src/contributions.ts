import type Database from 'better-sqlite3';

// A durable, per-wallet record of how much each pilot has delivered to the
// settlement — one row per wallet, updated on every successful (landed) run.
// This is the ledger of "who helped build the city", so that when the
// settlement has resources to give back, airdrops can be split proportionally.
export interface Contribution {
  wallet: string;
  deliveries: number; // successful trips
  value: number; // GOLD-equivalent value of cargo landed (units × unit price)
}

export class Contributions {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contributions (
        wallet TEXT PRIMARY KEY,
        deliveries INTEGER NOT NULL DEFAULT 0,
        value INTEGER NOT NULL DEFAULT 0
      )
    `);
    // `paid` tracks value already covered by a past airdrop, so each delivery
    // is rewarded exactly once across stage payouts. Migrate older tables.
    try { db.exec('ALTER TABLE contributions ADD COLUMN paid INTEGER NOT NULL DEFAULT 0'); } catch { /* column already exists */ }
  }

  // Value delivered but not yet covered by an airdrop, largest first — the
  // basis for splitting the next stage pool.
  unpaid(): { wallet: string; unpaid: number }[] {
    return this.db
      .prepare('SELECT wallet, (value - paid) AS unpaid FROM contributions WHERE value > paid ORDER BY unpaid DESC, wallet')
      .all() as { wallet: string; unpaid: number }[];
  }

  // Mark everything paid up to the current value (called after an airdrop).
  markPaid(): void {
    this.db.prepare('UPDATE contributions SET paid = value').run();
  }

  // Record one successful delivery: +1 trip and + the GOLD-value delivered.
  record(wallet: string, value: number): void {
    const v = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    this.db.prepare(`
      INSERT INTO contributions (wallet, deliveries, value) VALUES (?, 1, ?)
      ON CONFLICT(wallet) DO UPDATE SET deliveries = deliveries + 1, value = value + excluded.value
    `).run(wallet, v);
  }

  // Top contributors, most valuable first (deliveries breaks ties).
  leaderboard(limit = 20): Contribution[] {
    return this.db
      .prepare('SELECT wallet, deliveries, value FROM contributions ORDER BY value DESC, deliveries DESC LIMIT ?')
      .all(limit) as Contribution[];
  }

  valueOf(wallet: string): number {
    const r = this.db.prepare('SELECT value FROM contributions WHERE wallet = ?').get(wallet) as { value: number } | undefined;
    return r ? r.value : 0;
  }

  totalValue(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(value), 0) v FROM contributions').get() as { v: number }).v;
  }
}
