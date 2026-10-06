import { describe, it, expect, beforeEach, vi } from 'vitest';
import initSqlJs from 'sql.js';
import type Database from 'better-sqlite3';
import { buildApp } from '../src/app.js';
import { SqlJsFacade } from '../src/demo/sqljs.js';
import { createDemoBackend } from '../src/demo/backend.js';

// Mission ids and rolls come from randomUUID + Math.random; pin both so the
// live server and the demo backend generate the identical contract board.
let uuidCounter = 0;
vi.mock('node:crypto', async (orig) => ({
  ...(await orig<typeof import('node:crypto')>()),
  randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
}));
function reseed() {
  uuidCounter = 0;
  let s = 42;
  vi.spyOn(Math, 'random').mockImplementation(() => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; });
}

const SQL = await initSqlJs();
const demoBackend = () => createDemoBackend(new SqlJsFacade(new SQL.Database()) as unknown as Database.Database);

type Call = (method: string, path: string, wallet: string | null, body?: unknown) => Promise<{ status: number; body: any }>;

// One pilot career touching every dev-mode route the client uses: docking,
// provisions, crew hire, a delivered run, a voided run, repair, the board.
async function career(call: Call) {
  const log: { status: number; body: any }[] = [];
  const rec = async (...a: Parameters<Call>) => { const r = await call(...a); log.push(r); return r; };

  await rec('GET', '/balances', null);
  await rec('POST', '/login', 'harbour');
  await rec('POST', '/login', 'alice');
  await rec('POST', '/login', 'alice');
  await rec('POST', '/login', 'bob');
  reseed(); // right before the rolls — fastify draws from Math.random too
  const gen = await rec('POST', '/missions/generate', 'alice', { count: 4 });
  await rec('GET', '/missions', 'alice');
  const market = await rec('GET', '/crew/market', 'alice');
  await rec('POST', '/fuel/buy', 'alice', { gold: 10 });
  await rec('POST', '/ammo/buy', 'alice', { gold: 5 });
  const [m1, m2] = gen.body as { id: string }[];
  const hire = (market.body as { crewId: string }[]).slice(0, 1).map((c) => c.crewId);
  await rec('POST', `/missions/${m1.id}/accept`, 'alice', { shipId: 'ship-1', crewIds: hire });
  await rec('POST', `/missions/${m1.id}/complete`, 'bob', { fireEvents: [] });
  await rec('POST', `/missions/${m1.id}/complete`, 'alice', { fireEvents: [{ t: 1, raider: null }] });
  await rec('POST', `/missions/${m2.id}/accept`, 'alice', { shipId: 'ship-1', crewIds: [] });
  await rec('POST', `/missions/${m2.id}/fail`, 'alice', { fuelSpent: 5, ammoSpent: 1 });
  await rec('POST', '/ship/repair', 'alice', { shipId: 'ship-1', toHull: 11 });
  await rec('POST', '/ship/repair', 'alice', { shipId: 'bob-ship-1', toHull: 11 });
  await rec('POST', '/crew/list', 'alice', { crewId: 'nope', sharePct: 10 });
  await rec('POST', '/crew/unlist', 'alice', { crewId: 'nope' });
  await rec('GET', '/missions/mine', 'alice');
  await rec('GET', '/balances', 'alice');
  await rec('GET', '/settlement', 'alice');
  await rec('GET', '/leaderboard', 'alice');
  await rec('GET', '/claims', 'alice');
  return log;
}

describe('offline demo backend', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('answers a whole career exactly like the dev-mode server', async () => {
    const app = buildApp();
    const live = await career(async (method, url, wallet, payload) => {
      const res = await app.inject({
        method: method as 'GET' | 'POST', url,
        headers: wallet === null ? {} : { 'x-wallet': wallet },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
      return { status: res.statusCode, body: res.json() };
    });

    const demo = demoBackend();
    const offline = await career(async (method, path, wallet, body) => {
      const res = demo.handle({ method, path, wallet, body });
      // the demo's only intended difference: /login flags the session as demo
      if (path === '/login' && res.status === 200) {
        expect((res.body as any).demo).toBe(true);
        const { demo: _flag, ...rest } = res.body as any;
        return { status: res.status, body: rest };
      }
      return res;
    });

    expect(offline).toEqual(live);
    // sanity: the scenario actually exercised a paid delivery
    expect(live.some((r) => r.status === 200 && typeof r.body?.delivered === 'number')).toBe(true);
  });

  it('refuses chain-only routes with a readable message', () => {
    const demo = demoBackend();
    demo.handle({ method: 'POST', path: '/login', wallet: 'alice' });
    expect(demo.handle({ method: 'POST', path: '/auth/nonce', wallet: null, body: { wallet: 'x' } }).status).toBe(400);
    expect(demo.handle({ method: 'POST', path: '/claim', wallet: 'alice', body: { token: 'GOLD' } }).body).toEqual({ error: expect.stringMatching(/demo/) });
    expect(demo.handle({ method: 'POST', path: '/gold/buy', wallet: 'alice', body: { signature: 's' } }).status).toBe(400);
    expect(demo.handle({ method: 'GET', path: '/nowhere', wallet: 'alice' }).status).toBe(404);
  });

  it('login marks the session as demo, with no chain', () => {
    const body = demoBackend().handle({ method: 'POST', path: '/login', wallet: 'alice' }).body as any;
    expect(body).toMatchObject({ demo: true, chain: false, treasury: null, granted: true });
  });

  it('survives an export/reload round trip (localStorage persistence)', () => {
    const raw = new SQL.Database();
    const a = createDemoBackend(new SqlJsFacade(raw) as unknown as Database.Database);
    a.handle({ method: 'POST', path: '/login', wallet: 'alice' });
    a.handle({ method: 'POST', path: '/fuel/buy', wallet: 'alice', body: { gold: 10 } });
    const before = a.handle({ method: 'GET', path: '/balances', wallet: 'alice' }).body;

    const b = createDemoBackend(new SqlJsFacade(new SQL.Database(raw.export())) as unknown as Database.Database);
    expect(b.handle({ method: 'GET', path: '/balances', wallet: 'alice' }).body).toEqual(before);
    expect((b.handle({ method: 'POST', path: '/login', wallet: 'alice' }).body as any).granted).toBe(false);
  });
});

describe('SqlJsFacade', () => {
  const fresh = () => {
    const db = new SqlJsFacade(new SQL.Database());
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    return db;
  };

  it('run returns lastInsertRowid and changes; get/all read rows', () => {
    const db = fresh();
    expect(db.prepare('INSERT INTO t (v) VALUES (?)').run('a')).toEqual({ changes: 1, lastInsertRowid: 1 });
    db.prepare('INSERT INTO t (v) VALUES (?)').run('b');
    expect(db.prepare('SELECT v FROM t WHERE id = ?').get(2)).toEqual({ v: 'b' });
    expect(db.prepare('SELECT v FROM t WHERE id = ?').get(9)).toBeUndefined();
    expect(db.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([{ v: 'a' }, { v: 'b' }]);
  });

  it('transaction commits, returns, and rolls back everything on throw', () => {
    const db = fresh();
    expect(db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('ok'); return 7; })()).toBe(7);
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('gone');
      throw new Error('boom');
    })()).toThrow('boom');
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'ok' }]);
  });

  it('nested transactions use savepoints: inner failure caught leaves outer work intact', () => {
    const db = fresh();
    db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
      try {
        db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('inner'); throw new Error('x'); })();
      } catch { /* swallowed */ }
    })();
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'outer' }]);
  });
});
