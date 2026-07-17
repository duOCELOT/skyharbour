import type Database from 'better-sqlite3';
import type { FleetSource } from './fleet.js';

export interface Listing {
  crewId: string;
  owner: string;
  sharePct: number;
  skills: { fuel?: number; attack?: number; defense?: number; hauling?: number };
}

export class CrewMarket {
  constructor(private db: Database.Database, private fleet: FleetSource) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crew_listings (
        crew_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        share_pct INTEGER NOT NULL
      )
    `);
  }

  list(crewId: string, wallet: string, sharePct: number): Listing {
    const member = this.fleet.getCrew(crewId);
    if (!member || member.owner !== wallet) {
      throw new Error(`wallet ${wallet} does not own crew ${crewId}`);
    }
    if (!Number.isInteger(sharePct) || sharePct < 1 || sharePct > 50) {
      throw new Error('share must be an integer 1..50');
    }
    this.db
      .prepare(`
        INSERT INTO crew_listings (crew_id, owner, share_pct) VALUES (?, ?, ?)
        ON CONFLICT(crew_id) DO UPDATE SET share_pct = excluded.share_pct, owner = excluded.owner
      `)
      .run(crewId, wallet, sharePct);
    return { crewId, owner: wallet, sharePct, skills: member.skills };
  }

  unlist(crewId: string, wallet: string): void {
    this.db.prepare('DELETE FROM crew_listings WHERE crew_id = ? AND owner = ?').run(crewId, wallet);
  }

  listings(): Listing[] {
    const rows = this.db
      .prepare('SELECT crew_id, owner, share_pct FROM crew_listings')
      .all() as { crew_id: string; owner: string; share_pct: number }[];
    return rows.map((r) => ({
      crewId: r.crew_id,
      owner: r.owner,
      sharePct: r.share_pct,
      skills: this.fleet.getCrew(r.crew_id)?.skills ?? {},
    }));
  }

  getListing(crewId: string): Listing | undefined {
    return this.listings().find((l) => l.crewId === crewId);
  }
}
