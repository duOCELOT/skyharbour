import type Database from 'better-sqlite3';
import type { TokenId } from './tokens.js';
import { isTokenId } from './tokens.js';

export interface Leg {
  account: string;
  token: TokenId;
  amount: number; // positive credit, negative debit
}

export class InsufficientFunds extends Error {}
export class UnbalancedPost extends Error {}
export class UnknownToken extends Error {}

export class Ledger {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        memo TEXT NOT NULL,
        legs TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS balances (
        account TEXT NOT NULL,
        token TEXT NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (account, token)
      );
    `);
  }

  post(memo: string, legs: Leg[]): number {
    const perToken = new Map<string, number>();
    for (const leg of legs) {
      if (!isTokenId(leg.token)) {
        throw new UnknownToken(`unknown token: ${leg.token}`);
      }
      if (!Number.isInteger(leg.amount)) {
        throw new UnbalancedPost(`non-integer amount for ${leg.account}`);
      }
      if (!Number.isSafeInteger(leg.amount)) {
        throw new UnbalancedPost(`unsafe integer amount for ${leg.account}`);
      }
      perToken.set(leg.token, (perToken.get(leg.token) ?? 0) + leg.amount);
    }
    for (const [token, sum] of perToken) {
      if (sum !== 0) throw new UnbalancedPost(`legs for ${token} sum to ${sum}, not 0`);
    }

    const upsert = this.db.prepare(`
      INSERT INTO balances (account, token, amount) VALUES (?, ?, ?)
      ON CONFLICT(account, token) DO UPDATE SET amount = amount + excluded.amount
    `);
    const read = this.db.prepare(
      'SELECT amount FROM balances WHERE account = ? AND token = ?',
    );
    const insertEvent = this.db.prepare(
      'INSERT INTO ledger_events (memo, legs) VALUES (?, ?)',
    );

    const txn = this.db.transaction((): number => {
      for (const leg of legs) upsert.run(leg.account, leg.token, leg.amount);
      for (const leg of legs) {
        if (leg.account === 'mint') continue;
        const row = read.get(leg.account, leg.token) as { amount: number };
        if (!Number.isSafeInteger(row.amount)) {
          throw new Error(`balance overflow: ${leg.account} would hold unsafe integer ${row.amount} ${leg.token}`);
        }
        if (row.amount < 0) {
          throw new InsufficientFunds(`${leg.account} would hold ${row.amount} ${leg.token}`);
        }
      }
      const res = insertEvent.run(memo, JSON.stringify(legs));
      return Number(res.lastInsertRowid);
    });
    return txn();
  }

  balance(account: string, token: TokenId): number {
    if (!isTokenId(token)) {
      throw new UnknownToken(`unknown token: ${token}`);
    }
    const row = this.db
      .prepare('SELECT amount FROM balances WHERE account = ? AND token = ?')
      .get(account, token) as { amount: number } | undefined;
    return row?.amount ?? 0;
  }
}
