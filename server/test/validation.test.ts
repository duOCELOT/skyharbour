import { describe, it, expect } from 'vitest';
import { minFuel, haulingSkill, effectiveCargo, raiderCount, attackSkill } from '../src/validation.js';
import type { Ship, CrewMember } from '../src/fleet.js';

const fuelCrew: CrewMember = { id: 'c', owner: 'bob', skills: { fuel: 20 } };

describe('minFuel', () => {
  it('applies crew fuel skill', () => {
    expect(minFuel(100, [])).toBe(100);
    expect(minFuel(100, [fuelCrew])).toBe(80);
  });
  it('caps total skill at 50%', () => {
    const maxed: CrewMember[] = [
      { id: 'a', owner: 'x', skills: { fuel: 40 } },
      { id: 'b', owner: 'y', skills: { fuel: 40 } },
    ];
    expect(minFuel(100, maxed)).toBe(50);
  });
});

describe('haulingSkill & effectiveCargo', () => {
  it('caps hauling at 30', () => {
    const crew = [
      { skills: { hauling: 20 } } as any,
      { skills: { hauling: 20 } } as any,
    ];
    expect(haulingSkill(crew)).toBe(30);
  });
  it('adds hauling to ship cargo', () => {
    const ship: Ship = { id: 's', owner: 'alice', engine: 10, cargo: 8, crewSlots: 2, hull: 8 };
    const crew = [
      { skills: { hauling: 20 } } as any,
      { skills: { hauling: 20 } } as any,
    ];
    expect(effectiveCargo(ship, crew)).toBe(38);
  });
});

describe('raider count', () => {
  it('no raiders on short routes', () => {
    expect(raiderCount('m1', 120, 'LOG')).toBe(0);
    expect(raiderCount('m1', 60, 'FIRERUNE')).toBe(0);
  });
  it('1-3 raiders beyond 120, deterministic, FIRERUNE +1, cap 3', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const n = raiderCount(id, 200, 'LOG');
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(2);
      expect(raiderCount(id, 200, 'LOG')).toBe(n); // deterministic
      expect(raiderCount(id, 200, 'FIRERUNE')).toBe(Math.min(3, n + 1));
    }
  });
});

describe('attack skill', () => {
  it('caps at 50', () => {
    expect(attackSkill([{ skills: { attack: 30 } } as any, { skills: { attack: 30 } } as any])).toBe(50);
    expect(attackSkill([])).toBe(0);
  });
});

