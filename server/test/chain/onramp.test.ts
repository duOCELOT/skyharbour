import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../../src/ledger.js';
import { SolOnramp, goldForLamports, extractTransfers } from '../../src/chain/onramp.js';

const TREASURY = 'TREASURYpubkey';
const BUYER = 'BUYERpubkey';
function txWith(lamports: number, src = BUYER, dst = TREASURY, err: unknown = null) {
  return { meta: { err }, transaction: { message: { instructions: [
    { program: 'system', parsed: { type: 'transfer', info: { source: src, destination: dst, lamports } } },
  ] } } };
}

let db: Database.Database; let ledger: Ledger;
beforeEach(() => { db = new Database(':memory:'); ledger = new Ledger(db); });

describe('rate + parsing', () => {
  it('0.1 SOL = 100 GOLD', () => { expect(goldForLamports(100_000_000)).toBe(100); expect(goldForLamports(1_000_000_000)).toBe(1000); });
  it('extractTransfers pulls system transfers', () => {
    expect(extractTransfers(txWith(5))).toEqual([{ source: BUYER, destination: TREASURY, lamports: 5 }]);
    expect(extractTransfers({})).toEqual([]);
  });
});

describe('redeem', () => {
  const ok = async () => txWith(100_000_000);
  it('credits GOLD for a valid transfer', async () => {
    const onramp = new SolOnramp(db, ledger, TREASURY, ok);
    const r = await onramp.redeem(BUYER, 'sigA');
    expect(r.gold).toBe(100);
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100);
  });
  it('rejects a replayed signature', async () => {
    const onramp = new SolOnramp(db, ledger, TREASURY, ok);
    await onramp.redeem(BUYER, 'sigA');
    await expect(onramp.redeem(BUYER, 'sigA')).rejects.toThrow(/already credited/);
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100); // not doubled
  });
  it('rejects a transfer to the wrong destination or from the wrong wallet', async () => {
    const wrongDst = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, BUYER, 'someoneElse'));
    await expect(wrongDst.redeem(BUYER, 's1')).rejects.toThrow(/no SOL sent to the treasury/);
    const wrongSrc = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, 'notBuyer', TREASURY));
    await expect(wrongSrc.redeem(BUYER, 's2')).rejects.toThrow(/no SOL sent/);
  });
  // fast wait opts so the retry loop doesn't actually sleep in tests
  const fast = { retries: 2, delayMs: 0, sleep: async () => {} };

  it('rejects below the minimum and unconfirmed/errored txs', async () => {
    const tiny = new SolOnramp(db, ledger, TREASURY, async () => txWith(9_999_999), fast);
    await expect(tiny.redeem(BUYER, 's3')).rejects.toThrow(/no SOL sent/);
    const missing = new SolOnramp(db, ledger, TREASURY, async () => null, fast);
    await expect(missing.redeem(BUYER, 's4')).rejects.toThrow(/not found or unconfirmed/);
    const failed = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, BUYER, TREASURY, 'InstructionError'), fast);
    await expect(failed.redeem(BUYER, 's5')).rejects.toThrow(/failed on-chain/);
  });

  it('rejects a tx with no meta object at all (missing meta is not "no error")', async () => {
    const noMeta = new SolOnramp(db, ledger, TREASURY, async () => ({
      transaction: { message: { instructions: [
        { program: 'system', parsed: { type: 'transfer', info: { source: BUYER, destination: TREASURY, lamports: 100_000_000 } } },
      ] } },
      // no `meta` key at all
    }), fast);
    await expect(noMeta.redeem(BUYER, 's6')).rejects.toThrow(/not found or unconfirmed/);
  });

  it('rejects with a distinct RPC-failure message when fetchTx throws (not the bad-signature path)', async () => {
    const rpcDown = new SolOnramp(db, ledger, TREASURY, async () => {
      throw new Error('ECONNRESET: socket hang up');
    }, fast);
    await expect(rpcDown.redeem(BUYER, 's7')).rejects.toThrow(/could not reach the chain/);
    await expect(rpcDown.redeem(BUYER, 's7')).rejects.not.toThrow(/not found or unconfirmed/);
  });

  it('rejects the loser of a concurrent double-submit race with "already credited", not a raw SQL error', async () => {
    // Both calls pass the pre-flight SELECT before either has inserted, because
    // fetchTx is async and the pre-check runs synchronously before that await.
    const onramp = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000));
    const results = await Promise.allSettled([
      onramp.redeem(BUYER, 'sigRace'),
      onramp.redeem(BUYER, 'sigRace'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(Error);
    expect((rejected[0].reason as Error).message).toMatch(/already credited/);
    // fund-safe: only credited once despite the race
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100);
  });
});

describe('confirmation retry (the charged-but-error race)', () => {
  const noSleep = async () => {};
  it('retries a null lookup until the tx confirms, then credits', async () => {
    let calls = 0;
    const fetchTx = async () => (++calls < 3 ? null : txWith(100_000_000));
    const onramp = new SolOnramp(db, ledger, TREASURY, fetchTx, { retries: 5, delayMs: 0, sleep: noSleep });
    const r = await onramp.redeem(BUYER, 'sigLate');
    expect(r.gold).toBe(100);
    expect(calls).toBe(3); // two misses, then found
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100);
  });
  it('gives up as "not found or unconfirmed" after exhausting retries', async () => {
    const onramp = new SolOnramp(db, ledger, TREASURY, async () => null, { retries: 2, delayMs: 0, sleep: noSleep });
    await expect(onramp.redeem(BUYER, 'sigGhost')).rejects.toThrow(/not found or unconfirmed/);
  });
  it('does not retry a tx that failed on-chain (meta.err set)', async () => {
    let calls = 0;
    const fetchTx = async () => { calls++; return txWith(100_000_000, BUYER, TREASURY, 'InstructionError'); };
    const onramp = new SolOnramp(db, ledger, TREASURY, fetchTx, { retries: 5, delayMs: 0, sleep: noSleep });
    await expect(onramp.redeem(BUYER, 'sigFailed')).rejects.toThrow(/failed on-chain/);
    expect(calls).toBe(1); // definitive failure, no retry
  });
});

describe('creditFromSignature (reconcile recovery)', () => {
  it('credits an uncredited inbound transfer, deriving the wallet from the source', async () => {
    const onramp = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, BUYER, TREASURY));
    const r = await onramp.creditFromSignature('sigLost');
    expect(r).toEqual({ signature: 'sigLost', wallet: BUYER, gold: 100 });
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100);
  });
  it('is idempotent — returns null for an already-credited signature and never double-credits', async () => {
    const onramp = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, BUYER, TREASURY));
    await onramp.creditFromSignature('sigLost');
    expect(await onramp.creditFromSignature('sigLost')).toBeNull();
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(100);
  });
  it('returns null for a transfer not bound to the treasury or below the minimum', async () => {
    const wrongDst = new SolOnramp(db, ledger, TREASURY, async () => txWith(100_000_000, BUYER, 'elsewhere'));
    expect(await wrongDst.creditFromSignature('s1')).toBeNull();
    const tiny = new SolOnramp(db, ledger, TREASURY, async () => txWith(9_999_999, BUYER, TREASURY));
    expect(await tiny.creditFromSignature('s2')).toBeNull();
    expect(ledger.balance(`wallet:${BUYER}`, 'GOLD')).toBe(0);
  });
});
