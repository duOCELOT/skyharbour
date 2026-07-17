import type Database from 'better-sqlite3';
import { Ledger } from '../ledger.js';

export const LAMPORTS_PER_GOLD = 1_000_000;
export const MIN_LAMPORTS = 10_000_000;

export interface ParsedXfer {
  source: string;
  destination: string;
  lamports: number;
}

export interface OnrampWaitOpts {
  retries?: number; // how many extra polls after the first miss
  delayMs?: number; // wait between polls
  sleep?: (ms: number) => Promise<void>; // injectable for tests
}

export function goldForLamports(lamports: number): number {
  return Math.floor(lamports / LAMPORTS_PER_GOLD);
}

export function extractTransfers(parsedTx: any): ParsedXfer[] {
  const instructions = parsedTx?.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return [];
  const out: ParsedXfer[] = [];
  for (const ix of instructions) {
    if (ix?.program !== 'system' || ix?.parsed?.type !== 'transfer') continue;
    const info = ix.parsed?.info;
    if (
      typeof info?.source !== 'string' ||
      typeof info?.destination !== 'string' ||
      typeof info?.lamports !== 'number'
    ) {
      continue;
    }
    out.push({ source: info.source, destination: info.destination, lamports: info.lamports });
  }
  return out;
}

export class SolOnramp {
  constructor(
    private db: Database.Database,
    private ledger: Ledger,
    private treasury: string,
    private fetchTx: (sig: string) => Promise<any>,
    private wait: OnrampWaitOpts = {},
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sol_purchases (
        signature TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        lamports INTEGER NOT NULL,
        gold INTEGER NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  private sleep(ms: number): Promise<void> {
    return (this.wait.sleep ?? ((m) => new Promise<void>((r) => setTimeout(r, m))))(ms);
  }

  private isCredited(signature: string): boolean {
    return !!this.db
      .prepare('SELECT signature FROM sol_purchases WHERE signature = ?')
      .get(signature);
  }

  // Poll the chain until the tx is confirmed. Devnet often hasn't propagated
  // the transaction to the RPC node at the instant the client posts, so a
  // single lookup returns null and the payer would be charged with no credit.
  // We retry a null result; a tx present with meta.err is a definitive on-chain
  // failure (no retry); exhausting the retries is "not found or unconfirmed".
  private async confirmTx(signature: string): Promise<any> {
    const retries = this.wait.retries ?? 6;
    const delayMs = this.wait.delayMs ?? 1500;
    let reachErr = false;
    for (let attempt = 0; ; attempt++) {
      let parsedTx: any = null;
      try {
        parsedTx = await this.fetchTx(signature);
        reachErr = false;
      } catch {
        reachErr = true;
      }
      if (parsedTx?.meta?.err) throw new Error('transfer failed on-chain');
      if (parsedTx && parsedTx.meta) return parsedTx;
      if (attempt >= retries) {
        throw new Error(
          reachErr ? 'could not reach the chain to verify — try again' : 'transfer not found or unconfirmed',
        );
      }
      await this.sleep(delayMs);
    }
  }

  // The signature dedup insert and the GOLD ledger post are one db.transaction,
  // so a crash can never credit GOLD without recording the signature.
  private commit(signature: string, wallet: string, lamports: number): { gold: number } {
    const gold = goldForLamports(lamports);
    const insert = this.db.prepare(
      'INSERT INTO sol_purchases (signature, wallet, lamports, gold) VALUES (?, ?, ?, ?)',
    );
    try {
      this.db.transaction(() => {
        insert.run(signature, wallet, lamports, gold);
        this.ledger.post(`sol onramp ${wallet} ${signature}`, [
          { account: 'mint', token: 'GOLD', amount: -gold },
          { account: `wallet:${wallet}`, token: 'GOLD', amount: gold },
        ]);
      })();
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('purchase already credited');
      }
      throw err;
    }
    return { gold };
  }

  // Live path: an authenticated wallet claims a signature it just sent. The
  // credited lamports come only from the on-chain transfer FROM that wallet TO
  // the treasury — never from any client-supplied amount.
  async redeem(wallet: string, signature: string): Promise<{ gold: number }> {
    if (this.isCredited(signature)) throw new Error('purchase already credited');
    const parsedTx = await this.confirmTx(signature);
    const lamports = extractTransfers(parsedTx)
      .filter((t) => t.source === wallet && t.destination === this.treasury)
      .reduce((sum, t) => sum + t.lamports, 0);
    if (lamports < MIN_LAMPORTS) {
      throw new Error('no SOL sent to the treasury');
    }
    return this.commit(signature, wallet, lamports);
  }

  // Recovery path: credit a treasury-inbound transfer whose wallet we derive
  // from the transfer's own source (used by the reconcile script to repay
  // purchases that were charged on-chain but never credited due to the old
  // check-too-early race). Idempotent; returns null when there's nothing to do.
  async creditFromSignature(
    signature: string,
    expectedWallet?: string,
  ): Promise<{ signature: string; wallet: string; gold: number } | null> {
    if (this.isCredited(signature)) return null;
    let parsedTx: any = null;
    try {
      parsedTx = await this.fetchTx(signature);
    } catch {
      return null;
    }
    return this.creditFromParsed(signature, parsedTx, expectedWallet);
  }

  // Credit from an already-fetched parsed tx — lets a reconcile batch-fetch
  // (getParsedTransactions) and avoid one RPC round-trip per signature.
  creditFromParsed(
    signature: string,
    parsedTx: any,
    expectedWallet?: string,
  ): { signature: string; wallet: string; gold: number } | null {
    if (this.isCredited(signature)) return null;
    if (!parsedTx || !parsedTx.meta || parsedTx.meta.err) return null;
    const inbound = extractTransfers(parsedTx).filter((t) => t.destination === this.treasury && t.lamports > 0);
    if (inbound.length === 0) return null;
    const wallet = inbound[0].source;
    // A scan over the treasury's whole history also sees bootstrap/faucet/mint
    // funding; only credit transfers from the wallet we're reconciling for.
    if (expectedWallet && wallet !== expectedWallet) return null;
    const lamports = inbound.filter((t) => t.source === wallet).reduce((sum, t) => sum + t.lamports, 0);
    if (lamports < MIN_LAMPORTS) return null;
    try {
      const { gold } = this.commit(signature, wallet, lamports);
      return { signature, wallet, gold };
    } catch (err: any) {
      if (String(err?.message).includes('already credited')) return null;
      throw err;
    }
  }
}
