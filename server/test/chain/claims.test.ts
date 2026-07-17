import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../../src/ledger.js';
import { Claims, type MintFn } from '../../src/chain/claims.js';

let db: Database.Database;
let ledger: Ledger;
let claims: Claims;
beforeEach(() => {
  db = new Database(':memory:');
  ledger = new Ledger(db);
  claims = new Claims(db, ledger);
  ledger.post('seed', [
    { account: 'mint', token: 'GOLD', amount: -120 },
    { account: 'wallet:PubKeyX', token: 'GOLD', amount: 120 },
  ]);
});

describe('claim request', () => {
  it('moves the full balance to the chain account and files a pending row', () => {
    const r = claims.request('PubKeyX', 'GOLD');
    expect(r.amount).toBe(120);
    expect(ledger.balance('wallet:PubKeyX', 'GOLD')).toBe(0);
    expect(ledger.balance('chain', 'GOLD')).toBe(120);
    expect(claims.listFor('PubKeyX')[0].status).toBe('pending');
  });
  it('rejects empty claims', () => {
    expect(() => claims.request('PubKeyX', 'FUEL')).toThrow(/nothing to claim/);
  });
});

describe('mint worker', () => {
  it('mints pending rows and records the signature', async () => {
    claims.request('PubKeyX', 'GOLD');
    const calls: any[] = [];
    const res = await claims.processPending(async (w, t, a) => {
      calls.push([w, t, a]);
      return 'SIG1';
    });
    expect(res).toEqual({ minted: 1, failed: 0 });
    expect(calls).toEqual([['PubKeyX', 'GOLD', 120]]);
    const row = claims.listFor('PubKeyX')[0];
    expect(row.status).toBe('minted');
    expect(row.sig).toBe('SIG1');
  });
  it('marks failures and retries them next round, up to 5 attempts', async () => {
    claims.request('PubKeyX', 'GOLD');
    await claims.processPending(async () => {
      throw new Error('rpc down');
    });
    expect(claims.listFor('PubKeyX')[0].status).toBe('failed');
    const res = await claims.processPending(async () => 'SIG2');
    expect(res.minted).toBe(1);
  });
  it('never re-mints a minted row', async () => {
    claims.request('PubKeyX', 'GOLD');
    await claims.processPending(async () => 'SIG1');
    const res = await claims.processPending(async () => {
      throw new Error('should not be called');
    });
    expect(res).toEqual({ minted: 0, failed: 0 });
  });

  it('does not double-mint when a second processPending overlaps a hung mint (CAS row-claiming)', async () => {
    // Claim A (GOLD) will hang mid-mint on its first call; claim B (FUEL) must
    // still get minted exactly once even though a second, overlapping
    // processPending() invocation runs to completion while A is in flight.
    ledger.post('seed-fuel', [
      { account: 'mint', token: 'FUEL', amount: -50 },
      { account: 'wallet:PubKeyX', token: 'FUEL', amount: 50 },
    ]);
    claims.request('PubKeyX', 'GOLD'); // claim A
    claims.request('PubKeyX', 'FUEL'); // claim B

    const callCounts: Record<string, number> = { GOLD: 0, FUEL: 0 };
    let releaseA!: (sig: string) => void;
    const aGate = new Promise<string>((resolve) => {
      releaseA = resolve;
    });

    const mint1: MintFn = async (_wallet, token) => {
      callCounts[token]++;
      if (token === 'GOLD') return aGate; // hangs until released below
      return 'SIG-mint1-' + token;
    };
    const mint2: MintFn = async (_wallet, token) => {
      callCounts[token]++;
      return 'SIG-mint2-' + token;
    };

    // Invocation 1 starts, claims+mints A synchronously up to the hang.
    const p1 = claims.processPending(mint1);

    // Invocation 2 runs fully while A is still hung; it must claim and mint B.
    await claims.processPending(mint2);

    // Release A and let invocation 1 finish its own (now-stale) snapshot.
    releaseA('SIG-A');
    await p1;

    expect(callCounts.FUEL).toBe(1); // B minted exactly once across both invocations
    expect(callCounts.GOLD).toBe(1);

    const rows = claims.listFor('PubKeyX');
    expect(rows.some((r) => r.status === 'minting')).toBe(false);
    expect(rows.every((r) => r.status === 'minted')).toBe(true);
  });
});

describe('resolve', () => {
  it('refunds an exhausted (failed x5) claim back to the wallet and excludes it from future processPending', async () => {
    const { id, amount } = claims.request('PubKeyX', 'GOLD');
    const alwaysThrow: MintFn = async () => {
      throw new Error('rpc down');
    };
    for (let i = 0; i < 5; i++) {
      await claims.processPending(alwaysThrow);
    }
    const stuck = claims.listFor('PubKeyX')[0];
    expect(stuck.status).toBe('failed');
    expect(stuck.attempts).toBe(5);

    claims.resolve(id, 'refunded');

    expect(ledger.balance('wallet:PubKeyX', 'GOLD')).toBe(amount);
    expect(ledger.balance('chain', 'GOLD')).toBe(0);
    expect(claims.listFor('PubKeyX')[0].status).toBe('refunded');

    const res = await claims.processPending(async () => 'SIG-never');
    expect(res).toEqual({ minted: 0, failed: 0 });
  });

  it('refunds a still-pending claim directly — dev mode has no worker to advance it past pending', () => {
    const { id, amount } = claims.request('PubKeyX', 'GOLD');
    expect(claims.listFor('PubKeyX')[0].status).toBe('pending');

    claims.resolve(id, 'refunded');

    expect(ledger.balance('wallet:PubKeyX', 'GOLD')).toBe(amount);
    expect(ledger.balance('chain', 'GOLD')).toBe(0);
    expect(claims.listFor('PubKeyX')[0].status).toBe('refunded');
  });

  it('does not refund a minted claim (outcome=refunded only reaches minting/failed/pending)', async () => {
    const { id, amount } = claims.request('PubKeyX', 'GOLD');
    await claims.processPending(async () => 'SIG-done');
    expect(claims.listFor('PubKeyX')[0].status).toBe('minted');

    claims.resolve(id, 'refunded');

    // no-op: minted rows are out of scope for resolve('refunded')
    expect(claims.listFor('PubKeyX')[0].status).toBe('minted');
    expect(ledger.balance('wallet:PubKeyX', 'GOLD')).toBe(0);
    expect(ledger.balance('chain', 'GOLD')).toBe(amount);
  });

  it('keeps resolveStuck working as an alias for minting rows', async () => {
    claims.request('PubKeyX', 'GOLD');
    const hang = new Promise<string>(() => {}); // never resolves within this test
    const p = claims.processPending(async () => hang);
    const row = claims.listFor('PubKeyX')[0];
    expect(row.status).toBe('minting');

    claims.resolveStuck(row.id, 'minted', 'SIG-manual');

    expect(claims.listFor('PubKeyX')[0].status).toBe('minted');
    expect(claims.listFor('PubKeyX')[0].sig).toBe('SIG-manual');
    void p; // intentionally left pending; test ends without awaiting it
  });

  it('prevents double-pay when a minting row is refunded while mint is hung', async () => {
    // Test the scenario: processPending claims a row, calls mint, and hangs.
    // Meanwhile, resolve() refunds the ledger and sets status to refunded.
    // When the hung mint resolves, the success/failure UPDATEs must respect
    // the refunded status and NOT flip it back to minted/failed.
    const { id, amount } = claims.request('PubKeyX', 'GOLD');

    let releaseMint!: (sig: string) => void;
    const mintHang = new Promise<string>((resolve) => {
      releaseMint = resolve;
    });

    // Start processPending; it will claim the row and hang on mint.
    const p = claims.processPending(async () => mintHang);

    // Give it a moment to claim and start the hung mint.
    await new Promise((r) => setTimeout(r, 10));

    // Now refund the row externally (simulating an operator decision).
    claims.resolve(id, 'refunded');

    // Verify the refund took effect.
    expect(claims.listFor('PubKeyX')[0].status).toBe('refunded');
    expect(ledger.balance('wallet:PubKeyX', 'GOLD')).toBe(amount);
    expect(ledger.balance('chain', 'GOLD')).toBe(0);

    // Release the mint and await processPending completion.
    releaseMint('SIG-external');
    const result = await p;

    // The critical check: status must STILL be refunded, not flipped to minted.
    const row = claims.listFor('PubKeyX')[0];
    expect(row.status).toBe('refunded');
    expect(row.sig).toBeNull(); // refunded row has no sig
    expect(result.minted).toBe(0); // processPending must NOT count this as minted
    expect(result.failed).toBe(0);

    // Wallet keeps the refund; chain balance is 0.
    expect(ledger.balance('wallet:PubKeyX', 'GOLD')).toBe(amount);
    expect(ledger.balance('chain', 'GOLD')).toBe(0);
  });
});
