import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';

type App = ReturnType<typeof buildApp>;
let app: App;
beforeEach(() => {
  app = buildApp();
});

const asAlice = { 'x-wallet': 'alice' };
const asBob = { 'x-wallet': 'bob' };

// Shared ed25519 docking flow: mint a keypair, walk /auth/nonce + /auth/verify
// the way Phantom would, and hand back the resulting session token.
async function chainSession(target: App): Promise<{ wallet: string; session: string }> {
  const nacl = (await import('tweetnacl')).default;
  const bs58 = (await import('bs58')).default;
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const { message } = (await target.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet } })).json();
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)).toString('base64');
  const { session } = (await target.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } })).json();
  return { wallet, session };
}

describe('api', () => {
  it('401s without a wallet header', async () => {
    const res = await app.inject({ method: 'GET', url: '/balances' });
    expect(res.statusCode).toBe(401);
  });

  it('login grants the ship owner once', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.granted).toBe(true);
    expect(body.ships[0].id).toBe('ship-1');
    const again = await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    expect(again.json().granted).toBe(false);
  });

  it('full mission round trip over HTTP', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    // distance <= 120 keeps the route raider-free, so an empty fire trace
    // guarantees a full, un-spilled delivery — no combat needed for this test.
    let m: { id: string; distance: number; amount: number; cargo: string } | undefined;
    for (let i = 0; i < 60 && !m; i++) {
      const gen = await app.inject({
        method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 },
      });
      const [candidate] = gen.json();
      if (candidate.distance <= 120) m = candidate;
    }
    if (!m) throw new Error('unreachable');

    const acc = await app.inject({
      method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice,
      payload: { shipId: 'ship-1', crewIds: [] },
    });
    expect(acc.statusCode).toBe(200);

    const done = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: asAlice,
      payload: { fireEvents: [] },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().delivered).toBeGreaterThan(0);

    const bal = await app.inject({ method: 'GET', url: '/balances', headers: asAlice });
    expect(bal.json().GOLD).toBeGreaterThan(0);

    const s = await app.inject({ method: 'GET', url: '/settlement', headers: asAlice });
    expect(s.json().received.LOG ?? s.json().received[m.cargo]).toBeGreaterThan(0);
  });

  it('domain errors come back as 400 with a message', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const res = await app.inject({
      method: 'POST', url: '/missions/nope/accept', headers: asAlice,
      payload: { shipId: 'ship-1', crewIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not open/);
  });

  it('airdrops fuel', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/airdrop', headers: asAlice,
      payload: { wallets: ['alice', 'bob'], amount: 10 },
    });
    expect(res.json().credited).toBe(2);
  });

  it('airdrop rejects negative amount and does not change balance', async () => {
    // Grant alice some fuel so we can verify it doesn't change
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const balanceBefore = await app.inject({ method: 'GET', url: '/balances', headers: asAlice });
    const fuelBefore = balanceBefore.json().FUEL;

    const res = await app.inject({
      method: 'POST', url: '/admin/airdrop', headers: asAlice,
      payload: { wallets: ['alice'], amount: -50 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/airdrop amount must be a positive integer/);

    const balanceAfter = await app.inject({ method: 'GET', url: '/balances', headers: asAlice });
    expect(balanceAfter.json().FUEL).toBe(fuelBefore);
  });

  it('server faults (statusCode >= 500) reply 500 with a generic body, not 400', async () => {
    app.get('/boom', async () => {
      const err = new Error('db exploded') as Error & { statusCode: number };
      err.statusCode = 500;
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/boom', headers: asAlice });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error' });
  });

  it('errors with a sub-500 statusCode use that code and the original message', async () => {
    app.get('/teapot', async () => {
      const err = new Error('short and stout') as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/teapot', headers: asAlice });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: 'short and stout' });
  });

  it('only the mission pilot can complete or fail their active mission', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    await app.inject({ method: 'POST', url: '/login', headers: asBob });
    const gen = await app.inject({
      method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 },
    });
    const [m] = gen.json();
    const acc = await app.inject({
      method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice,
      payload: { shipId: 'ship-1', crewIds: [] },
    });
    expect(acc.statusCode).toBe(200);

    const completeAsBob = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: asBob,
      payload: { fireEvents: [] },
    });
    expect(completeAsBob.statusCode).toBe(400);
    expect(completeAsBob.json().error).toMatch(/only the mission pilot/);

    const failAsBob = await app.inject({
      method: 'POST', url: `/missions/${m.id}/fail`, headers: asBob,
    });
    expect(failAsBob.statusCode).toBe(400);
    expect(failAsBob.json().error).toMatch(/only the mission pilot/);

    const completeAsAlice = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: asAlice,
      payload: { fireEvents: [] },
    });
    expect(completeAsAlice.statusCode).toBe(200);
  });

  it('GET /missions returns generated open missions', async () => {
    const gen = await app.inject({
      method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 2 },
    });
    const generated = gen.json();
    const list = await app.inject({ method: 'GET', url: '/missions', headers: asAlice });
    const open = list.json();
    for (const m of generated) {
      expect(open.some((o: { id: string }) => o.id === m.id)).toBe(true);
    }
  });

  it('crew market list/market/unlist round trip', async () => {
    const listRes = await app.inject({
      method: 'POST', url: '/crew/list', headers: asBob,
      payload: { crewId: 'crew-1', sharePct: 20 },
    });
    expect(listRes.statusCode).toBe(200);

    const marketRes = await app.inject({ method: 'GET', url: '/crew/market', headers: asBob });
    const listings = marketRes.json();
    expect(listings.some((l: { crewId: string; sharePct: number }) => l.crewId === 'crew-1' && l.sharePct === 20)).toBe(true);

    const unlistRes = await app.inject({
      method: 'POST', url: '/crew/unlist', headers: asBob,
      payload: { crewId: 'crew-1' },
    });
    expect(unlistRes.statusCode).toBe(200);

    const marketAfter = await app.inject({ method: 'GET', url: '/crew/market', headers: asBob });
    const afterListings = marketAfter.json();
    expect(afterListings.some((l: { crewId: string }) => l.crewId === 'crew-1')).toBe(false);
  });

  it('failing a mission forfeits the fee and cannot be failed twice', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const gen = await app.inject({
      method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 },
    });
    const [m] = gen.json();
    await app.inject({
      method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice,
      payload: { shipId: 'ship-1', crewIds: [] },
    });

    const fail = await app.inject({ method: 'POST', url: `/missions/${m.id}/fail`, headers: asAlice });
    expect(fail.statusCode).toBe(200);

    const openAfter = await app.inject({ method: 'GET', url: '/missions', headers: asAlice });
    expect(openAfter.json().some((o: { id: string }) => o.id === m.id)).toBe(false);

    const failAgain = await app.inject({ method: 'POST', url: `/missions/${m.id}/fail`, headers: asAlice });
    expect(failAgain.statusCode).toBe(400);
  });

  it('fail accepts a fuelSpent body and burns it', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 } })).json();
    await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice, payload: { shipId: 'ship-1', crewIds: [] } });
    const before = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().FUEL;
    const res = await app.inject({ method: 'POST', url: `/missions/${m.id}/fail`, headers: asAlice, payload: { fuelSpent: 30 } });
    expect(res.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().FUEL;
    expect(before - after).toBe(30);
  });

  it('fail accepts an ammoSpent body and burns both fuel and shells', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    await app.inject({ method: 'POST', url: '/ammo/buy', headers: asAlice, payload: { gold: 5 } }); // 10 AMMO
    const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 } })).json();
    await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice, payload: { shipId: 'ship-1', crewIds: [] } });
    const before = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json();
    const res = await app.inject({ method: 'POST', url: `/missions/${m.id}/fail`, headers: asAlice, payload: { fuelSpent: 5, ammoSpent: 3 } });
    expect(res.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json();
    expect(before.FUEL - after.FUEL).toBe(5);
    expect(before.AMMO - after.AMMO).toBe(3);
  });

  it('sells fuel over HTTP', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const res = await app.inject({ method: 'POST', url: '/fuel/buy', headers: asAlice, payload: { gold: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().fuelCredited).toBe(40);
    const bal = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json();
    expect(bal.GOLD).toBe(90);
    expect(bal.FUEL).toBe(340);
  });

  it('sells ammo over HTTP', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const res = await app.inject({ method: 'POST', url: '/ammo/buy', headers: asAlice, payload: { gold: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().credited).toBe(10);
  });

  it('the harbour lists NPC crew with skills at boot', async () => {
    const res = await app.inject({ method: 'GET', url: '/crew/market', headers: asAlice });
    const listings = res.json();
    const stoker = listings.find((l: any) => l.crewId === 'npc-stoker');
    expect(stoker).toBeDefined();
    expect(stoker.owner).toBe('harbour');
    expect(stoker.sharePct).toBe(10);
    expect(stoker.skills).toEqual({ fuel: 35 });
  });

  it('rejects reserved system names at dev login', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: { 'x-wallet': 'harbour' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reserved/);
  });

  it('rejects reserved system names via the dev x-wallet header', async () => {
    const res = await app.inject({ method: 'GET', url: '/balances', headers: { 'x-wallet': 'settlement' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reserved/);
  });

  it('auth hook accepts a chain session token', async () => {
    const { session } = await chainSession(app);
    const res = await app.inject({ method: 'GET', url: '/balances', headers: { 'x-session': session } });
    expect(res.statusCode).toBe(200);
  });

  it('chain mode rejects the dev x-wallet header — sessions only', async () => {
    const chainApp = buildApp({ chain: { registry: {}, fetchMints: async () => [] } });
    const res = await chainApp.inject({ method: 'GET', url: '/balances', headers: asAlice });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/signature docking/);
  });

  it('chain mode still accepts a session minted via /auth/nonce + /auth/verify', async () => {
    const chainApp = buildApp({ chain: { registry: {}, fetchMints: async () => [] } });
    const { session } = await chainSession(chainApp);
    const res = await chainApp.inject({ method: 'GET', url: '/balances', headers: { 'x-session': session } });
    expect(res.statusCode).toBe(200);
  });

  it('chain mode fails closed on airdrop when no operator key is configured, even with a valid session', async () => {
    const chainApp = buildApp({ chain: { registry: {}, fetchMints: async () => [] } }); // no adminKey
    const { wallet, session } = await chainSession(chainApp);
    const res = await chainApp.inject({
      method: 'POST', url: '/admin/airdrop', headers: { 'x-session': session },
      payload: { wallets: [wallet], amount: 5 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/operator key required/);
  });

  it('chain mode with an operator key configured still allows airdrop through it', async () => {
    const chainApp = buildApp({ chain: { registry: {}, fetchMints: async () => [] }, adminKey: 'sesame' });
    const { wallet, session } = await chainSession(chainApp);
    const res = await chainApp.inject({
      method: 'POST', url: '/admin/airdrop', headers: { 'x-session': session, 'x-admin-key': 'sesame' },
      payload: { wallets: [wallet], amount: 5 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('claims over HTTP: full balance out, row visible', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const res = await app.inject({ method: 'POST', url: '/claim', headers: asAlice, payload: { token: 'GOLD' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe(100);
    const rows = (await app.inject({ method: 'GET', url: '/claims', headers: asAlice })).json();
    expect(rows[0].status).toBe('pending');
    const bal = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json();
    expect(bal.GOLD).toBe(0);
  });

  it('GET /missions/mine returns the callers active missions', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 } })).json();
    await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice, payload: { shipId: 'ship-1', crewIds: [] } });
    const mine = (await app.inject({ method: 'GET', url: '/missions/mine', headers: asAlice })).json();
    expect(mine.map((x: any) => x.id)).toEqual([m.id]);
  });

  it('airdrop requires the operator key when one is configured', async () => {
    const gated = buildApp({ adminKey: 'sesame' });
    const denied = await gated.inject({ method: 'POST', url: '/admin/airdrop', headers: asAlice, payload: { wallets: ['alice'], amount: 5 } });
    expect(denied.statusCode).toBe(403);
    const ok = await gated.inject({
      method: 'POST', url: '/admin/airdrop',
      headers: { ...asAlice, 'x-admin-key': 'sesame' }, payload: { wallets: ['alice'], amount: 5 },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('/login reports chain mode off in the dev app, so the client knows not to enable claiming', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    expect(res.json().chain).toBe(false);
  });

  it('/login reports chain mode on when the app is built with chain opts', async () => {
    const chainApp = buildApp({ chain: { registry: {}, fetchMints: async () => [] } });
    const { session } = await chainSession(chainApp);
    const res = await chainApp.inject({ method: 'POST', url: '/login', headers: { 'x-session': session } });
    expect(res.json().chain).toBe(true);
  });

  it('auth/nonce rejects a missing or malformed wallet with a clean 400, not a TypeError leak', async () => {
    const missing = await app.inject({ method: 'POST', url: '/auth/nonce', payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('wallet must be a string');

    const noBody = await app.inject({ method: 'POST', url: '/auth/nonce' });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().error).toBe('wallet must be a string');

    const wrongType = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 12345 } });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().error).toBe('wallet must be a string');

    const tooLong = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: 'x'.repeat(65) } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toBe('wallet must be a string');
  });

  it('/login reports currentHull on each ship', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const ship1 = res.json().ships.find((s: any) => s.id === 'ship-1');
    expect(ship1.currentHull).toBe(ship1.hull); // untouched ship starts at full hull
  });

  it('/ship/repair pays GOLD and restores hull; a non-owner is rejected', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    await app.inject({ method: 'POST', url: '/login', headers: asBob });

    // Damage ship-1 via a raider route with an empty fire trace — hull
    // damage is server-resolved from the deterministic combat model, never
    // self-reported. distance > 120 guarantees at least one raider, which
    // (crew [] ⇒ defense 0) always lands its hit against an empty trace.
    let m: { id: string; distance: number; amount: number; cargo: string } | undefined;
    for (let i = 0; i < 60 && !m; i++) {
      const [candidate] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 } })).json();
      if (candidate.distance > 120) m = candidate;
    }
    if (!m) throw new Error('unreachable');
    await app.inject({
      method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice,
      payload: { shipId: 'ship-1', crewIds: [] },
    });
    await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: asAlice,
      payload: { fireEvents: [] },
    });

    const login1 = (await app.inject({ method: 'POST', url: '/login', headers: asAlice })).json();
    const ship1 = login1.ships.find((s: any) => s.id === 'ship-1');
    expect(ship1.currentHull).toBeLessThan(ship1.hull);

    // bob cannot repair alice's ship
    const denied = await app.inject({
      method: 'POST', url: '/ship/repair', headers: asBob,
      payload: { shipId: 'ship-1', toHull: ship1.hull },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toMatch(/does not own/);

    const goldBefore = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().GOLD;
    const repair = await app.inject({
      method: 'POST', url: '/ship/repair', headers: asAlice,
      payload: { shipId: 'ship-1', toHull: ship1.hull },
    });
    expect(repair.statusCode).toBe(200);
    const body = repair.json();
    expect(body.hull).toBe(ship1.hull);
    expect(body.spent).toBeGreaterThan(0);

    const goldAfter = (await app.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().GOLD;
    expect(goldBefore - goldAfter).toBe(body.spent);

    const login2 = (await app.inject({ method: 'POST', url: '/login', headers: asAlice })).json();
    expect(login2.ships.find((s: any) => s.id === 'ship-1').currentHull).toBe(ship1.hull);
  });

  it('auth/verify rejects a missing wallet or signature with a clean 400, not a TypeError leak', async () => {
    const noBody = await app.inject({ method: 'POST', url: '/auth/verify' });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().error).toBe('wallet must be a string');

    const missingSig = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'somePubkey' } });
    expect(missingSig.statusCode).toBe(400);
    expect(missingSig.json().error).toBe('signature must be a string');

    const badSigType = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: 'somePubkey', signature: 42 } });
    expect(badSigType.statusCode).toBe(400);
    expect(badSigType.json().error).toBe('signature must be a string');
  });

  it('gold/buy is chain-mode only in dev', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const res = await app.inject({ method: 'POST', url: '/gold/buy', headers: asAlice, payload: { signature: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/chain mode only/);
  });
  it('login reports a null treasury in dev', async () => {
    const r = (await app.inject({ method: 'POST', url: '/login', headers: asAlice })).json();
    expect(r.treasury).toBe(null);
  });

  it('gold/buy round trip over HTTP with an injected onramp double', async () => {
    // Passing `onramp` alone (no `chain`) keeps the dev x-wallet header auth path live —
    // chain-mode session-only auth is gated on opts.chain, not opts.onramp.
    const chainApp = buildApp({
      onramp: {
        treasury: 'T',
        fetchTx: async () => ({
          meta: { err: null },
          transaction: { message: { instructions: [
            { program: 'system', parsed: { type: 'transfer', info: { source: 'alice', destination: 'T', lamports: 100_000_000 } } },
          ] } },
        }),
      },
    });
    await chainApp.inject({ method: 'POST', url: '/login', headers: asAlice });

    const goldBefore = (await chainApp.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().GOLD;

    const buy = await chainApp.inject({ method: 'POST', url: '/gold/buy', headers: asAlice, payload: { signature: 'sigT' } });
    expect(buy.statusCode).toBe(200);
    expect(buy.json()).toEqual({ gold: 100 });

    const goldAfter = (await chainApp.inject({ method: 'GET', url: '/balances', headers: asAlice })).json().GOLD;
    expect(goldAfter - goldBefore).toBe(100);

    const replay = await chainApp.inject({ method: 'POST', url: '/gold/buy', headers: asAlice, payload: { signature: 'sigT' } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toMatch(/already credited/);
  });

  it('gold/buy rejects a missing or non-string signature with a clean 400, not a TypeError leak', async () => {
    const chainApp = buildApp({
      onramp: {
        treasury: 'T',
        fetchTx: async () => ({
          meta: { err: null },
          transaction: { message: { instructions: [
            { program: 'system', parsed: { type: 'transfer', info: { source: 'alice', destination: 'T', lamports: 100_000_000 } } },
          ] } },
        }),
      },
    });
    await chainApp.inject({ method: 'POST', url: '/login', headers: asAlice });

    const noBody = await chainApp.inject({ method: 'POST', url: '/gold/buy', headers: asAlice });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().error).toBe('signature must be a string');

    const badSigType = await chainApp.inject({ method: 'POST', url: '/gold/buy', headers: asAlice, payload: { signature: 42 } });
    expect(badSigType.statusCode).toBe(400);
    expect(badSigType.json().error).toBe('signature must be a string');
  });
});
