import type Database from 'better-sqlite3';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Ledger } from '../ledger.js';
import { isTokenId, type TokenId } from '../tokens.js';

export type MintFn = (wallet: string, token: TokenId, amount: number) => Promise<string>;

export interface ClaimRow {
  id: number;
  wallet: string;
  token: TokenId;
  amount: number;
  status: 'pending' | 'minting' | 'minted' | 'failed' | 'refunded';
  sig: string | null;
  attempts: number;
}

export class Claims {
  constructor(
    private db: Database.Database,
    private ledger: Ledger,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL, token TEXT NOT NULL, amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', sig TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL DEFAULT (datetime('now')), updated TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  request(wallet: string, token: TokenId): { id: number; amount: number } {
    if (!isTokenId(token)) throw new Error('unknown token');
    const amount = this.ledger.balance(`wallet:${wallet}`, token);
    if (amount <= 0) throw new Error('nothing to claim');
    let id = 0;
    this.db.transaction(() => {
      this.ledger.post(`claim ${wallet} ${token}`, [
        { account: `wallet:${wallet}`, token, amount: -amount },
        { account: 'chain', token, amount },
      ]);
      const r = this.db
        .prepare('INSERT INTO claims (wallet, token, amount) VALUES (?, ?, ?)')
        .run(wallet, token, amount);
      id = Number(r.lastInsertRowid);
    })();
    return { id, amount };
  }

  listFor(wallet: string): ClaimRow[] {
    return this.db
      .prepare(
        'SELECT id, wallet, token, amount, status, sig, attempts FROM claims WHERE wallet = ? ORDER BY id DESC',
      )
      .all(wallet) as ClaimRow[];
  }

  async processPending(mint: MintFn): Promise<{ minted: number; failed: number }> {
    const rows = this.db
      .prepare(
        "SELECT id, wallet, token, amount FROM claims WHERE status = 'pending' OR (status = 'failed' AND attempts < 5)",
      )
      .all() as ClaimRow[];
    let minted = 0;
    let failed = 0;
    for (const row of rows) {
      // Compare-and-set claim on the row: interval ticks can overlap when
      // mintTo() latency exceeds the tick period, so a second, concurrent
      // processPending() invocation may walk a snapshot that includes rows
      // this invocation already owns (or has already finished). The WHERE
      // clause re-checks status at claim time instead of trusting the
      // snapshot, so only one invocation can ever win the row and call
      // mint() for it — otherwise the same ledger claim could be minted
      // twice on-chain.
      const claim = this.db
        .prepare(
          "UPDATE claims SET status = 'minting', updated = datetime('now') WHERE id = ? AND (status = 'pending' OR (status = 'failed' AND attempts < 5))",
        )
        .run(row.id);
      if (claim.changes === 0) continue; // another invocation already claimed this row
      try {
        const sig = await mint(row.wallet, row.token as TokenId, row.amount);
        const update = this.db
          .prepare(
            "UPDATE claims SET status = 'minted', sig = ?, updated = datetime('now') WHERE id = ? AND status = 'minting'",
          )
          .run(sig, row.id);
        if (update.changes === 0) {
          console.error(
            `claim ${row.id} resolved externally while minting — on-chain sig ${sig} needs reconciliation`,
          );
        } else {
          minted++;
        }
      } catch {
        this.db
          .prepare(
            "UPDATE claims SET status = 'failed', attempts = attempts + 1, updated = datetime('now') WHERE id = ? AND status = 'minting'",
          )
          .run(row.id);
        failed++;
      }
    }
    return { minted, failed };
  }

  // Targets both 'minting' (crashed mid-mint) and 'failed' (exhausted retries)
  // rows so a claim whose money already left the wallet always has a way
  // out: confirm it minted, mark it failed for a human to chase, or refund
  // the ledger amount back to the wallet.
  //
  // 'refunded' additionally reaches 'pending' rows: dev mode never starts
  // the claim worker (see index.ts — it's only wired up when chain mode
  // boots), so a pending claim there has no way to ever become 'minting' or
  // 'failed' on its own. Without this, request()'s funds — already moved
  // out of the wallet into the 'chain' account — would be permanently
  // stranded with no path back. 'minted'/'failed' outcomes are unaffected
  // and still only target 'minting'/'failed', matching their existing
  // semantics (confirming or giving up on a mint that was actually attempted).
  resolve(id: number, outcome: 'minted' | 'failed' | 'refunded', sig?: string): void {
    if (outcome === 'refunded') {
      const row = this.db
        .prepare(
          "SELECT wallet, token, amount FROM claims WHERE id = ? AND status IN ('minting', 'failed', 'pending')",
        )
        .get(id) as { wallet: string; token: TokenId; amount: number } | undefined;
      if (!row) return;
      this.db.transaction(() => {
        this.ledger.post(`refund claim ${id}`, [
          { account: 'chain', token: row.token, amount: -row.amount },
          { account: `wallet:${row.wallet}`, token: row.token, amount: row.amount },
        ]);
        this.db
          .prepare(
            "UPDATE claims SET status = 'refunded', updated = datetime('now') WHERE id = ? AND status IN ('minting', 'failed', 'pending')",
          )
          .run(id);
      })();
      return;
    }
    this.db
      .prepare(
        "UPDATE claims SET status = ?, sig = COALESCE(?, sig), updated = datetime('now') WHERE id = ? AND status IN ('minting', 'failed')",
      )
      .run(outcome, sig ?? null, id);
  }

  /** @deprecated use resolve(); kept as an alias in case external callers still target it. */
  resolveStuck(id: number, outcome: 'minted' | 'failed', sig?: string): void {
    this.resolve(id, outcome, sig);
  }
}

export function makeSplMint(connection: Connection, payer: Keypair, mints: Record<string, string>): MintFn {
  return async (wallet, token, amount) => {
    const mintPk = new PublicKey(mints[token]);
    const owner = new PublicKey(wallet);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, owner);
    return mintTo(connection, payer, mintPk, ata.address, payer, amount);
  };
}
