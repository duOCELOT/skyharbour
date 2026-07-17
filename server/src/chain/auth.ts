import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { isReservedWallet } from './config.js';

const NONCE_TTL_MS = 10 * 60 * 1000;

export class ChainAuth {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_nonces (
        pubkey TEXT PRIMARY KEY, nonce TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY, wallet TEXT NOT NULL, created INTEGER NOT NULL
      );
    `);
  }

  issueNonce(pubkey: string): string {
    if (isReservedWallet(pubkey)) throw new Error('reserved system name');
    const nonce = randomBytes(16).toString('hex');
    this.db.prepare(`
      INSERT INTO auth_nonces (pubkey, nonce, created) VALUES (?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET nonce = excluded.nonce, created = excluded.created
    `).run(pubkey, nonce, Date.now());
    return nonce;
  }

  verify(pubkey: string, signatureB64: string): string {
    if (isReservedWallet(pubkey)) throw new Error('signature rejected');
    const row = this.db.prepare('SELECT nonce, created FROM auth_nonces WHERE pubkey = ?').get(pubkey) as
      | { nonce: string; created: number } | undefined;
    if (!row || Date.now() - row.created > NONCE_TTL_MS) throw new Error('signature rejected');
    let ok = false;
    try {
      ok = nacl.sign.detached.verify(
        new TextEncoder().encode(`Skyharbour docking clearance: ${row.nonce}`),
        Uint8Array.from(Buffer.from(signatureB64, 'base64')),
        bs58.decode(pubkey),
      );
    } catch { ok = false; }
    if (!ok) throw new Error('signature rejected');
    this.db.prepare('DELETE FROM auth_nonces WHERE pubkey = ?').run(pubkey);
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_sessions (token, wallet, created) VALUES (?, ?, ?)').run(token, pubkey, Date.now());
    return token;
  }

  walletFor(session: string): string | undefined {
    const row = this.db.prepare('SELECT wallet FROM auth_sessions WHERE token = ?').get(session) as
      | { wallet: string } | undefined;
    return row?.wallet;
  }
}
