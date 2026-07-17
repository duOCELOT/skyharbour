import type Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { FleetSource, Ship, CrewMember } from '../fleet.js';

export type RegistryEntry =
  | { type: 'ship'; id: string; engine: number; cargo: number; crewSlots: number; hull: number }
  | { type: 'crew'; id: string; skills: { fuel?: number; attack?: number; defense?: number; hauling?: number } };

export class ChainFleet implements FleetSource {
  constructor(
    private db: Database.Database,
    private registry: Record<string, RegistryEntry>,
    private virtualCrew: CrewMember[] = [],
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS chain_holdings (wallet TEXT NOT NULL, mint TEXT NOT NULL, PRIMARY KEY (wallet, mint))');
  }

  async refreshHoldings(wallet: string, fetchMints: (owner: string) => Promise<string[]>): Promise<void> {
    const mints = (await fetchMints(wallet)).filter((m) => this.registry[m]);
    const txn = this.db.transaction(() => {
      // On-chain fetch is the truth — a fetched mint belongs to this wallet
      // NOW, so any other cached holder (e.g. the seller after a sale) is
      // stale and must be evicted globally before we (re)insert it here.
      // Residual v1 gap: a seller's row for a mint the buyer never refreshes
      // stays cached until either party logs in and triggers a refresh.
      const del = this.db.prepare('DELETE FROM chain_holdings WHERE mint = ?');
      for (const m of mints) del.run(m);
      this.db.prepare('DELETE FROM chain_holdings WHERE wallet = ?').run(wallet);
      const ins = this.db.prepare('INSERT OR IGNORE INTO chain_holdings (wallet, mint) VALUES (?, ?)');
      for (const m of mints) ins.run(wallet, m);
    });
    txn();
  }

  private holdingsOf(wallet: string): RegistryEntry[] {
    const rows = this.db.prepare('SELECT mint FROM chain_holdings WHERE wallet = ?').all(wallet) as { mint: string }[];
    return rows.map((r) => this.registry[r.mint]).filter(Boolean);
  }

  shipsOf(wallet: string): Ship[] {
    return this.holdingsOf(wallet)
      .filter((e): e is Extract<RegistryEntry, { type: 'ship' }> => e.type === 'ship')
      .map((e) => ({ id: e.id, owner: wallet, engine: e.engine, cargo: e.cargo, crewSlots: e.crewSlots, hull: e.hull }));
  }

  crewOf(wallet: string): CrewMember[] {
    const own = this.holdingsOf(wallet)
      .filter((e): e is Extract<RegistryEntry, { type: 'crew' }> => e.type === 'crew')
      .map((e) => ({ id: e.id, owner: wallet, skills: e.skills }));
    return [...own, ...this.virtualCrew.filter((c) => c.owner === wallet)];
  }

  getShip(id: string): Ship | undefined {
    const row = this.db.prepare(`
      SELECT wallet, mint FROM chain_holdings
    `).all() as { wallet: string; mint: string }[];
    for (const r of row) {
      const e = this.registry[r.mint];
      if (e?.type === 'ship' && e.id === id) {
        return { id: e.id, owner: r.wallet, engine: e.engine, cargo: e.cargo, crewSlots: e.crewSlots, hull: e.hull };
      }
    }
    return undefined;
  }

  getCrew(id: string): CrewMember | undefined {
    const virtual = this.virtualCrew.find((c) => c.id === id);
    if (virtual) return virtual;
    const rows = this.db.prepare('SELECT wallet, mint FROM chain_holdings').all() as { wallet: string; mint: string }[];
    for (const r of rows) {
      const e = this.registry[r.mint];
      if (e?.type === 'crew' && e.id === id) return { id: e.id, owner: r.wallet, skills: e.skills };
    }
    return undefined;
  }
}

export async function fetchOwnedMints(connection: Connection, owner: string): Promise<string[]> {
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: TOKEN_PROGRAM_ID });
  return res.value
    .map((a) => a.account.data.parsed.info)
    .filter((i) => i.tokenAmount?.decimals === 0 && i.tokenAmount?.uiAmount === 1)
    .map((i) => i.mint as string);
}
