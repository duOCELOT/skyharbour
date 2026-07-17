import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChainFleet } from '../../src/chain/fleet.js';
import { NPC_CREW } from '../../src/fleet.js';

const registry = {
  MintShipA: { type: 'ship', id: 'SH-001 Rustbucket', engine: 8, cargo: 32, crewSlots: 3, hull: 11 },
  MintCrewB: { type: 'crew', id: 'CR-001 Old Stoker', skills: { fuel: 35 } },
  MintShipC: { type: 'ship', id: 'SH-002 Swift', engine: 18, cargo: 8, crewSlots: 1, hull: 5 },
} as const;

let fleet: ChainFleet;
beforeEach(() => {
  fleet = new ChainFleet(new Database(':memory:'), registry as any, NPC_CREW.map((n) => n.member));
});

describe('chain fleet', () => {
  it('is empty before refresh and populated after', async () => {
    expect(fleet.shipsOf('walletX')).toEqual([]);
    await fleet.refreshHoldings('walletX', async () => ['MintShipA', 'MintCrewB', 'UnknownMint']);
    const ships = fleet.shipsOf('walletX');
    expect(ships).toHaveLength(1);
    expect(ships[0]).toEqual({ id: 'SH-001 Rustbucket', owner: 'walletX', engine: 8, cargo: 32, crewSlots: 3, hull: 11 });
    expect(fleet.crewOf('walletX')[0].skills).toEqual({ fuel: 35 });
  });

  it('refresh replaces stale holdings (NFT sold)', async () => {
    await fleet.refreshHoldings('walletX', async () => ['MintShipA']);
    await fleet.refreshHoldings('walletX', async () => ['MintShipC']);
    expect(fleet.shipsOf('walletX').map((s) => s.id)).toEqual(['SH-002 Swift']);
  });

  it('getShip/getCrew resolve by registry id with the holder as owner', async () => {
    await fleet.refreshHoldings('walletX', async () => ['MintShipA']);
    expect(fleet.getShip('SH-001 Rustbucket')?.owner).toBe('walletX');
    expect(fleet.getShip('SH-002 Swift')).toBeUndefined(); // nobody holds it
  });

  it('an NFT sold to another wallet is evicted from the seller everywhere (on-chain truth)', async () => {
    await fleet.refreshHoldings('walletA', async () => ['MintShipA']);
    await fleet.refreshHoldings('walletB', async () => ['MintShipA']);
    expect(fleet.shipsOf('walletA')).toEqual([]);
    expect(fleet.getShip('SH-001 Rustbucket')?.owner).toBe('walletB');
  });

  it('serves the harbour NPC crew virtually', () => {
    expect(fleet.getCrew('npc-stoker')?.owner).toBe('harbour');
    expect(fleet.crewOf('harbour').length).toBeGreaterThanOrEqual(6);
  });
});
