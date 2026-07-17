import { describe, it, expect } from 'vitest';
import { DevFleet, devFixtures, HARBOUR, NPC_CREW } from '../src/fleet.js';

describe('dev fleet', () => {
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);

  it('resolves ships by owner and id', () => {
    const alices = fleet.shipsOf('alice');
    expect(alices.length).toBeGreaterThan(0);
    expect(fleet.getShip(alices[0].id)?.owner).toBe('alice');
  });

  it('resolves crew by owner and id', () => {
    const bobs = fleet.crewOf('bob');
    expect(bobs.length).toBeGreaterThan(0);
    expect(fleet.getCrew(bobs[0].id)?.owner).toBe('bob');
  });

  it('returns empty crew for unknown wallets, but provides synthesized trio ships', () => {
    expect(fleet.shipsOf('nobody')).toHaveLength(3);
    expect(fleet.crewOf('nobody')).toEqual([]);
  });
});

describe('test fleets', () => {
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);

  it('synthesizes a deterministic trio for any wallet', () => {
    const mine = fleet.shipsOf('zed');
    const ids = mine.map((s) => s.id).sort();
    expect(ids).toEqual(['zed-courier', 'zed-freighter', 'zed-hauler']);
    const hauler = mine.find((s) => s.id === 'zed-hauler')!;
    expect([hauler.engine, hauler.cargo, hauler.crewSlots, hauler.hull]).toEqual([8, 32, 3, 11]);
    const courier = mine.find((s) => s.id === 'zed-courier')!;
    expect(courier.hull).toBe(5);
    const freighter = mine.find((s) => s.id === 'zed-freighter')!;
    expect(freighter.hull).toBe(9);
  });

  it('known wallets keep fixtures plus the trio', () => {
    const alices = fleet.shipsOf('alice');
    expect(alices.some((s) => s.id === 'ship-1')).toBe(true);
    expect(alices.some((s) => s.id === 'alice-courier')).toBe(true);
    const ship1 = alices.find((s) => s.id === 'ship-1')!;
    expect(ship1.hull).toBe(8);
    const ship2 = fleet.shipsOf('bob').find((s) => s.id === 'ship-2')!;
    expect(ship2.hull).toBe(6);
  });

  it('getShip resolves synthesized ids with correct ownership', () => {
    expect(fleet.getShip('zed-courier')).toEqual({ id: 'zed-courier', owner: 'zed', engine: 18, cargo: 8, crewSlots: 1, hull: 5 });
    expect(fleet.getShip('zed-frigate')).toBeUndefined();
  });

  it('harbour owns the seven NPC crew', () => {
    expect(NPC_CREW).toHaveLength(7);
    for (const { member, sharePct } of NPC_CREW) {
      expect(member.owner).toBe(HARBOUR);
      expect(fleet.getCrew(member.id)?.owner).toBe(HARBOUR);
      expect(sharePct).toBeGreaterThanOrEqual(10);
      expect(sharePct).toBeLessThanOrEqual(25);
    }
    expect(fleet.getCrew('npc-stoker')?.skills.fuel).toBe(35);
    expect(fleet.getCrew('npc-longshoreman')?.skills.hauling).toBe(20);
  });
});
