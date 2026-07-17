import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DevFleet, devFixtures } from '../src/fleet.js';
import { CrewMarket } from '../src/crew.js';

let market: CrewMarket;
beforeEach(() => {
  const { ships, crew } = devFixtures();
  market = new CrewMarket(new Database(':memory:'), new DevFleet(ships, crew));
});

describe('crew market', () => {
  it('lists owned crew with a share', () => {
    market.list('crew-1', 'bob', 15);
    expect(market.listings()).toEqual([{ crewId: 'crew-1', owner: 'bob', sharePct: 15, skills: { fuel: 20 } }]);
  });
  it('rejects listing crew you do not own', () => {
    expect(() => market.list('crew-1', 'alice', 15)).toThrow(/own/);
  });
  it('bounds share to 1..50', () => {
    expect(() => market.list('crew-1', 'bob', 0)).toThrow(/share/);
    expect(() => market.list('crew-1', 'bob', 51)).toThrow(/share/);
  });
  it('re-listing updates the share; unlist removes', () => {
    market.list('crew-1', 'bob', 15);
    market.list('crew-1', 'bob', 20);
    expect(market.getListing('crew-1')?.sharePct).toBe(20);
    market.unlist('crew-1', 'bob');
    expect(market.getListing('crew-1')).toBeUndefined();
  });
  it('listings carry the crew skills', () => {
    market.list('crew-1', 'bob', 15);
    expect(market.listings()[0].skills).toEqual({ fuel: 20 });
    expect(market.getListing('crew-1')?.skills.fuel).toBe(20);
  });
  it('re-listing after an ownership transfer updates the recorded owner', () => {
    // simulate an NFT transfer: same crew id, new owner in the fleet source
    let crewOwner = 'bob';
    const moved = new CrewMarket(new Database(':memory:'), {
      shipsOf: () => [],
      crewOf: () => [],
      getShip: () => undefined,
      getCrew: (id: string) =>
        id === 'crew-1' ? { id: 'crew-1', owner: crewOwner, skills: { fuel: 20 } } : undefined,
    });
    // Initial listing by bob
    moved.list('crew-1', 'bob', 30);
    expect(moved.getListing('crew-1')).toEqual({ crewId: 'crew-1', owner: 'bob', sharePct: 30, skills: { fuel: 20 } });
    // Simulate ownership transfer: crew-1 now owned by dana in the fleet
    crewOwner = 'dana';
    // Re-list as the new owner
    moved.list('crew-1', 'dana', 30);
    // Assert owner is updated in the listing
    expect(moved.getListing('crew-1')).toEqual({ crewId: 'crew-1', owner: 'dana', sharePct: 30, skills: { fuel: 20 } });
  });
  it('upsert refreshes owner along with share', () => {
    market.list('crew-1', 'bob', 15);
    market.list('crew-1', 'bob', 20);
    expect(market.getListing('crew-1')?.owner).toBe('bob');
  });
});
