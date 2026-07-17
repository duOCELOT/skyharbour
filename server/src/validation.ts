import type { Ship, CrewMember } from './fleet.js';

// mirror of client/flightMath.js hashSeed (FNV-1a 32-bit)
function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function minFuel(distance: number, crew: CrewMember[]): number {
  const skill = Math.min(
    crew.reduce((sum, c) => sum + (c.skills.fuel ?? 0), 0),
    50,
  );
  return Math.ceil(distance * (1 - skill / 100));
}

// HAULING cap 30 — mirror of client/flightMath.js
export const haulingSkill = (crew: Pick<CrewMember, 'skills'>[]): number =>
  Math.min(crew.reduce((s, c) => s + (c.skills?.hauling ?? 0), 0), 30);

export const effectiveCargo = (ship: Ship, crew: Pick<CrewMember, 'skills'>[]): number =>
  ship.cargo + haulingSkill(crew);

// Raiders ambush long routes. The count is deterministic so the server can
// bound bounty claims without simulating combat.
export function raiderCount(missionId: string, distance: number, cargo: string): number {
  if (distance <= 120) return 0;
  return Math.min(3, 1 + (hash32(`${missionId}:raiders`) % 2) + (cargo === 'FIRERUNE' ? 1 : 0));
}

export const attackSkill = (crew: Pick<CrewMember, 'skills'>[]): number =>
  Math.min(crew.reduce((s, c) => s + (c.skills?.attack ?? 0), 0), 50);

// mirror of client/flightMath.js
export const cannonDamage = (atk: number) => 1 + Math.floor(atk / 25);
export const shotsToKill = (atk: number) => Math.ceil(2 / cannonDamage(atk));
