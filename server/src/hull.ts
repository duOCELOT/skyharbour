import type Database from 'better-sqlite3';
import { Ledger } from './ledger.js';

// Repairs are bought back with GOLD at the hangar, flat rate per hull point.
export const REPAIR_PER_GOLD_POINT = 4;

// Hull is DERIVED state: current() persists per-ship damage taken across
// missions. It is never self-reported by the client — missions.ts reads
// hullDamage straight off the server's resolveRun() and calls damage()
// itself; repair() is the only way hull goes back up, and it costs real
// GOLD.
export class HullState {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hull_state (
        ship_id TEXT PRIMARY KEY,
        hull INTEGER NOT NULL
      )
    `);
  }

  // Defaults to max (a ship no one has ever damaged is at full hull).
  current(shipId: string, max: number): number {
    const row = this.db
      .prepare('SELECT hull FROM hull_state WHERE ship_id = ?')
      .get(shipId) as { hull: number } | undefined;
    return row ? row.hull : max;
  }

  set(shipId: string, hull: number): void {
    this.db
      .prepare(`
        INSERT INTO hull_state (ship_id, hull) VALUES (?, ?)
        ON CONFLICT(ship_id) DO UPDATE SET hull = excluded.hull
      `)
      .run(shipId, hull);
  }

  // Floored at 1: a landed run means the ship made it back, however
  // battered — it never reaches 0 through combat/hazard damage (a run whose
  // resolved hull hits 0 is a void, settled via the fail path, not here).
  damage(shipId: string, max: number, points: number): number {
    const cur = this.current(shipId, max);
    const next = Math.max(1, cur - Math.max(0, points));
    this.set(shipId, next);
    return next;
  }

  // Raises hull toward min(toPoints, max), charging 4 GOLD per point
  // restored from wallet to the settlement treasury, atomically with the
  // hull write. Throws if there's nothing to repair (already at/above the
  // target) — ownership ("not your ship") is the caller's job, not this
  // class's, since HullState has no notion of who owns what.
  repair(
    ledger: Ledger,
    wallet: string,
    shipId: string,
    max: number,
    toPoints: number,
  ): { spent: number; hull: number } {
    if (!Number.isSafeInteger(toPoints) || toPoints < 0) {
      throw new Error('repair target must be a non-negative integer of hull');
    }
    const cur = this.current(shipId, max);
    const target = Math.min(toPoints, max);
    const pointsRestored = target - cur;
    if (pointsRestored <= 0) throw new Error('nothing to repair');
    const spent = REPAIR_PER_GOLD_POINT * pointsRestored;
    this.db.transaction(() => {
      ledger.post(`hull repair ${shipId}`, [
        { account: `wallet:${wallet}`, token: 'GOLD', amount: -spent },
        { account: 'settlement', token: 'GOLD', amount: spent },
      ]);
      this.set(shipId, target);
    })();
    return { spent, hull: target };
  }
}
