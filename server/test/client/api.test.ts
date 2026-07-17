import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { getWallet, setWallet, clearWallet, api, acceptMission } = await import('../../../client/api.js');

beforeEach(() => { store.clear(); });

describe('wallet store', () => {
  it('round-trips the dev wallet', () => {
    expect(getWallet()).toBeNull();
    setWallet('alice');
    expect(getWallet()).toBe('alice');
    clearWallet();
    expect(getWallet()).toBeNull();
  });
});

describe('api()', () => {
  it('sends the x-wallet header and parses JSON', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/balances');
      expect(init.headers['x-wallet']).toBe('alice');
      return { ok: true, json: async () => ({ GOLD: 5 }) };
    });
    expect(await api('/balances')).toEqual({ GOLD: 5 });
  });

  it('throws the server error message on non-2xx', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'mission x is not open' }) }));
    await expect(api('/missions/x/accept', { method: 'POST', body: {} })).rejects.toThrow(/not open/);
  });

  it('recovers from non-JSON error responses with a generic message', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    }));
    await expect(api('/x')).rejects.toThrow(/request failed: \/x/);
  });

  it('acceptMission posts shipId and crewIds', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/missions/m1/accept');
      expect(JSON.parse(init.body)).toEqual({ shipId: 'ship-1', crewIds: ['crew-1'] });
      return { ok: true, json: async () => ({ status: 'active' }) };
    });
    expect((await acceptMission('m1', 'ship-1', ['crew-1'])).status).toBe('active');
  });

  it('buyFuel posts the gold amount', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/fuel/buy');
      expect(JSON.parse(init.body)).toEqual({ gold: 25 });
      return { ok: true, json: async () => ({ fuelCredited: 100 }) };
    });
    const { buyFuel } = await import('../../../client/api.js');
    expect((await buyFuel(25)).fuelCredited).toBe(100);
  });

  it('failMission posts the spent fuel', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/missions/m1/fail');
      expect(JSON.parse(init.body)).toEqual({ fuelSpent: 42, ammoSpent: 0 });
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { failMission } = await import('../../../client/api.js');
    await failMission('m1', 42);
  });

  it('completeMission posts fireEvents', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/missions/m1/complete');
      expect(JSON.parse(init.body)).toEqual({ fireEvents: [{ t: 1.5, raider: 0 }, { t: 2.1, raider: null }] });
      return { ok: true, json: async () => ({ rewardGold: 10, fuelBurned: 5, crewShares: [] }) };
    });
    const { completeMission } = await import('../../../client/api.js');
    const payout = await completeMission('m1', [{ t: 1.5, raider: 0 }, { t: 2.1, raider: null }]);
    expect(payout.rewardGold).toBe(10);
  });

  it('buyAmmo posts the gold amount', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/ammo/buy');
      expect(JSON.parse(init.body)).toEqual({ gold: 7 });
      return { ok: true, json: async () => ({ credited: 50 }) }; // server returns { credited }
    });
    const { buyAmmo } = await import('../../../client/api.js');
    expect((await buyAmmo(7)).credited).toBe(50);
  });

  it('failMission posts fuel and ammo spent', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/missions/m1/fail');
      expect(JSON.parse(init.body)).toEqual({ fuelSpent: 5, ammoSpent: 3 });
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { failMission } = await import('../../../client/api.js');
    await failMission('m1', 5, 3);
  });

  it('prefers the session header over the dev wallet', async () => {
    setWallet('alice');
    const { setSession, clearSession, api } = await import('../../../client/api.js');
    setSession('tok123');
    (globalThis as any).fetch = vi.fn(async (_url: string, init: any) => {
      expect(init.headers['x-session']).toBe('tok123');
      expect(init.headers['x-wallet']).toBeUndefined();
      return { ok: true, json: async () => ({}) };
    });
    await api('/balances');
    clearSession();
  });

  it('repairShip posts shipId and toHull', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/ship/repair');
      expect(JSON.parse(init.body)).toEqual({ shipId: 'ship-1', toHull: 8 });
      return { ok: true, json: async () => ({ spent: 12, hull: 8, max: 8 }) };
    });
    const { repairShip } = await import('../../../client/api.js');
    expect(await repairShip('ship-1', 8)).toEqual({ spent: 12, hull: 8, max: 8 });
  });

  it('claim wrapper posts the token', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/claim');
      expect(JSON.parse(init.body)).toEqual({ token: 'GOLD' });
      return { ok: true, json: async () => ({ id: 1, amount: 5 }) };
    });
    const { claim } = await import('../../../client/api.js');
    expect((await claim('GOLD')).amount).toBe(5);
  });

  it('buyGold posts the signature', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/gold/buy');
      expect(JSON.parse(init.body)).toEqual({ signature: 'sigZ' });
      return { ok: true, json: async () => ({ gold: 100 }) };
    });
    const { buyGold } = await import('../../../client/api.js');
    expect((await buyGold('sigZ')).gold).toBe(100);
  });
});
