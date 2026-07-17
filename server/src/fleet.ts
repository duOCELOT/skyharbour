export interface Ship {
  id: string;
  owner: string;
  engine: number; // distance units per second
  cargo: number; // max cargo units
  crewSlots: number;
  hull: number; // armor rating
}

export interface CrewMember {
  id: string;
  owner: string;
  skills: { fuel?: number; attack?: number; defense?: number; hauling?: number }; // integer % points
}

export interface FleetSource {
  shipsOf(wallet: string): Ship[];
  crewOf(wallet: string): CrewMember[];
  getShip(id: string): Ship | undefined;
  getCrew(id: string): CrewMember | undefined;
}

export const HARBOUR = 'harbour';

// Deterministic per-wallet test fleet — stands in for ship NFTs until the
// chain gateway (plan 2) reads real collections. Ids are wallet-scoped so
// ownership checks hold.
const TRIO: [string, number, number, number, number][] = [
  ['hauler', 8, 32, 3, 11],
  ['courier', 18, 8, 1, 5],
  ['freighter', 12, 18, 2, 9],
];

function trioFor(wallet: string): Ship[] {
  return TRIO.map(([kind, engine, cargo, crewSlots, hull]) => (
    { id: `${wallet}-${kind}`, owner: wallet, engine, cargo, crewSlots, hull }
  ));
}

export const NPC_CREW: { member: CrewMember; sharePct: number }[] = [
  { member: { id: 'npc-stoker', owner: HARBOUR, skills: { fuel: 35 } }, sharePct: 10 },
  { member: { id: 'npc-greaser', owner: HARBOUR, skills: { fuel: 20 } }, sharePct: 12 },
  { member: { id: 'npc-warden', owner: HARBOUR, skills: { defense: 35 } }, sharePct: 15 },
  { member: { id: 'npc-shieldhand', owner: HARBOUR, skills: { defense: 20 } }, sharePct: 18 },
  { member: { id: 'npc-veteran', owner: HARBOUR, skills: { fuel: 15, defense: 15 } }, sharePct: 22 },
  { member: { id: 'npc-magsman', owner: HARBOUR, skills: { attack: 25, defense: 10 } }, sharePct: 25 },
  { member: { id: 'npc-longshoreman', owner: HARBOUR, skills: { hauling: 20 } }, sharePct: 12 },
];

export class DevFleet implements FleetSource {
  constructor(private ships: Ship[], private crew: CrewMember[]) {}
  shipsOf(wallet: string): Ship[] {
    return [...this.ships.filter((s) => s.owner === wallet), ...trioFor(wallet)];
  }
  crewOf(wallet: string): CrewMember[] {
    return this.crew.filter((c) => c.owner === wallet);
  }
  getShip(id: string): Ship | undefined {
    const fixture = this.ships.find((s) => s.id === id);
    if (fixture) return fixture;
    const m = id.match(/^(.+)-(hauler|courier|freighter)$/);
    if (!m) return undefined;
    return trioFor(m[1]).find((s) => s.id === id);
  }
  getCrew(id: string): CrewMember | undefined {
    return this.crew.find((c) => c.id === id);
  }
}

export function devFixtures(): { ships: Ship[]; crew: CrewMember[] } {
  return {
    ships: [
      { id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8 },
      { id: 'ship-2', owner: 'bob', engine: 15, cargo: 10, crewSlots: 1, hull: 6 },
    ],
    crew: [
      { id: 'crew-1', owner: 'bob', skills: { fuel: 20 } },
      { id: 'crew-2', owner: 'carol', skills: { defense: 30 } },
      { id: 'crew-3', owner: 'carol', skills: { fuel: 40, attack: 10 } },
      ...NPC_CREW.map((n) => n.member),
    ],
  };
}
