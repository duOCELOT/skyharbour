import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChainConfig } from '../src/chain/config.js';

// Seeded FNV-1a hash + Park-Miller LCG — same shape as client/flightMath.js,
// reimplemented locally so this script has no cross-workspace import.
export function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function makeRng(seed: number): () => number {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 16807) >>> 0) % 2147483647; return s / 2147483647; };
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deterministically picks `count` unique "first last" pairs from the cross
 * product of two name pools, shuffled by `rng`. Throws a clear error if the
 * pools can't cover the requested count — this is the "generator throws
 * clearly if pools exhaust" guard.
 */
export function pickUniquePairs(firsts: string[], lasts: string[], count: number, rng: () => number): string[] {
  const capacity = firsts.length * lasts.length;
  if (count > capacity) {
    throw new Error(
      `name pool exhausted: need ${count} unique pairs but ${firsts.length} x ${lasts.length} pools only cover ${capacity} — expand the pools`,
    );
  }
  const pairs: string[] = [];
  for (const f of firsts) for (const l of lasts) pairs.push(`${f} ${l}`);
  return shuffle(pairs, rng).slice(0, count);
}

// ---- Ship name pools ------------------------------------------------------

export const SHIP_PREFIX = [
  'Iron', 'Rust', 'Void', 'Gale', 'Ember', 'Salt', 'Cinder', 'Bruma',
  'Keel', 'Drift', 'Sky', 'Storm', 'Ash', 'Copper', 'Bright', 'Dun',
  'Hollow', 'Long', 'True', 'Wander', 'Last', 'First', 'Grey', 'Bold',
];

export const SHIP_NOUN = [
  'Wager', 'Harrow', 'Pilgrim', 'Mule', 'Heron', 'Lantern', 'Anchor', 'Chariot',
  'Sparrow', 'Whale', 'Otter', 'Crane', 'Badger', 'Comet', 'Furrow', 'Gull',
  'Mantle', 'Porter', 'Runner', 'Saddle', 'Tide', 'Vagrant', 'Wren', 'Bastion',
];

// ---- Crew name pools -------------------------------------------------------

export const CREW_FIRST = [
  'Mara', 'Kaelen', 'Odessa', 'Bram', 'Ilya', 'Tamsin', 'Doran', 'Vesna',
  'Orin', 'Cass', 'Juna', 'Rook', 'Sable', 'Perrin', 'Wren', 'Astra',
  'Halvor', 'Nadia', 'Corvin', 'Liras', 'Beren', 'Sila', 'Torin', 'Mira',
  'Ezren', 'Yara', 'Doreth', 'Kestin', 'Alva', 'Torsten', 'Rennik', 'Sorcha',
  'Baird', 'Ione', 'Cade', 'Delwyn', 'Ashka', 'Rurik', 'Tamsen', 'Verity',
  'Osric', 'Nyla', 'Fenwick', 'Calla', 'Draven', 'Isolde', 'Barric', 'Wrenna',
  'Osmund', 'Talia',
];

export const CREW_LAST = [
  'Voss', 'Kestrel', 'Drexler', 'Harrow', 'Cinderfell', 'Rourke', 'Bastian', 'Wren',
  'Sallow', 'Marchetti', 'Okafor', 'Lindqvist', 'Petrov', 'Alvarez', 'Nakamura', 'Dubois',
  'Ferro', 'Cole', 'Vance', 'Osei', 'Kowalski', 'Brandt', 'Suvari', 'Halloran',
  'Rask', 'Iversen', 'Delacroix', 'Moreau', 'Yun', 'Castellan', 'Rustad', 'Grier',
  'Hollis', 'Vantage', 'Sharrow', 'Corbin', 'Bledsoe', 'Ashgrove', 'Marrow', 'Sedge',
  'Thorne', 'Quill', 'Barrows', 'Ferrous', 'Hale', 'Windham', 'Cusk', 'Larkspur',
];

export const CREW_EPITHET = [
  'the Unburnt', 'Threefinger', 'the Void-Marked', 'Last Light', 'the Long Watch',
  'Ashbound', 'the Steady Hand', 'Nine-Lives', "the Harbour's Ghost", 'Stormcaller',
  'the Quiet Storm', 'Rustwarden', 'the Undrowned', 'Skyburned', 'the Iron Oath',
  'Driftless', 'the Salt-Touched', 'Emberkin', 'the Unyielding', 'Hollowmark',
];

const FLAGSHIP_NAME = 'Void Sovereign';

// ---- Types ------------------------------------------------------------------

export type ShipClass = 'hauler' | 'freighter' | 'courier' | 'relic' | 'flagship';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'relic' | 'flagship';
export type CrewTier = 'common' | 'uncommon' | 'rare' | 'legendary';
export type Skill = 'fuel' | 'defense' | 'attack' | 'hauling';

export interface ShipEntry {
  name: string;
  class: ShipClass;
  engine: number;
  cargo: number;
  bridge: number;
  hull: number;
  rarity: Rarity;
}

export interface CrewEntry {
  name: string;
  tier: CrewTier;
  skills: Partial<Record<Skill, number>>;
}

const SKILL_ORDER: Skill[] = ['fuel', 'defense', 'attack', 'hauling'];

// Ship class table: count, engine/cargo/hull ranges, fixed bridge, rarity mapping.
const SHIP_CLASSES: {
  cls: ShipClass; count: number; engine: [number, number]; cargo: [number, number]; bridge: number; hull: [number, number]; rarity: Rarity;
}[] = [
  { cls: 'hauler', count: 45, engine: [6, 9], cargo: [28, 40], bridge: 3, hull: [10, 12], rarity: 'common' },
  { cls: 'freighter', count: 30, engine: [10, 13], cargo: [16, 24], bridge: 2, hull: [8, 9], rarity: 'uncommon' },
  { cls: 'courier', count: 20, engine: [16, 20], cargo: [6, 10], bridge: 1, hull: [5, 6], rarity: 'rare' },
  { cls: 'relic', count: 5, engine: [14, 16], cargo: [26, 30], bridge: 3, hull: [9, 10], rarity: 'relic' },
];

function buildShips(rng: () => number): ShipEntry[] {
  const totalNamed = SHIP_CLASSES.reduce((s, c) => s + c.count, 0);
  const names = pickUniquePairs(SHIP_PREFIX, SHIP_NOUN, totalNamed, rng);
  const ships: ShipEntry[] = [];
  let i = 0;
  // Pass 1: name/engine/cargo/bridge/rarity, in the original draw order —
  // unchanged from before hull existed, so these values stay byte-identical
  // to the already-committed manifest.
  for (const c of SHIP_CLASSES) {
    for (let n = 0; n < c.count; n++) {
      ships.push({
        name: names[i++],
        class: c.cls,
        engine: randInt(rng, c.engine[0], c.engine[1]),
        cargo: randInt(rng, c.cargo[0], c.cargo[1]),
        bridge: c.bridge,
        hull: 0, // filled in pass 2 below
        rarity: c.rarity,
      });
    }
  }
  // Pass 2 (determinism-critical): hull is drawn LAST — only after every
  // ship's engine/cargo has already been drawn above — so this rng draw is
  // strictly appended to the stream instead of interleaved with the
  // existing per-ship draws. That's what keeps pass 1's values stable
  // across this change; only hull (and everything generated after it,
  // i.e. crew) shifts.
  let idx = 0;
  for (const c of SHIP_CLASSES) {
    for (let n = 0; n < c.count; n++) {
      ships[idx].hull = randInt(rng, c.hull[0], c.hull[1]);
      idx++;
    }
  }
  ships.push({ name: FLAGSHIP_NAME, class: 'flagship', engine: 20, cargo: 40, bridge: 4, hull: 14, rarity: 'flagship' });
  return ships;
}

// Round-robin-weighted skill picker: cycles through fuel/defense/attack/hauling
// (attack included — dormant by design, not used elsewhere in the game) so the
// roster's skill distribution stays even across all 2000 crew instead of
// clumping under pure random draws. Duals take two adjacent skills in the
// cycle, which are always distinct mod 4.
function makeSkillCycle() {
  let i = 0;
  return {
    next(): Skill { const s = SKILL_ORDER[i % 4]; i += 1; return s; },
    nextPair(): [Skill, Skill] { const a = SKILL_ORDER[i % 4]; const b = SKILL_ORDER[(i + 1) % 4]; i += 2; return [a, b]; },
  };
}

function buildCrew(rng: () => number): CrewEntry[] {
  const TOTAL = 2000;
  const LEGENDARY = 20;
  const RARE = 180;
  const UNCOMMON = 500;
  const COMMON = TOTAL - LEGENDARY - RARE - UNCOMMON; // 1300

  const names = pickUniquePairs(CREW_FIRST, CREW_LAST, TOTAL, rng);
  const epithets = shuffle(CREW_EPITHET, rng);
  if (epithets.length < LEGENDARY) {
    throw new Error(`epithet pool exhausted: need ${LEGENDARY} but only ${epithets.length} available — expand CREW_EPITHET`);
  }

  const cycle = makeSkillCycle();
  const crew: CrewEntry[] = [];
  let idx = 0;

  for (let n = 0; n < COMMON; n++) {
    const skill = cycle.next();
    crew.push({ name: names[idx++], tier: 'common', skills: { [skill]: randInt(rng, 10, 20) } });
  }
  for (let n = 0; n < UNCOMMON; n++) {
    const skill = cycle.next();
    crew.push({ name: names[idx++], tier: 'uncommon', skills: { [skill]: randInt(rng, 25, 35) } });
  }
  for (let n = 0; n < RARE; n++) {
    const [a, b] = cycle.nextPair();
    crew.push({
      name: names[idx++],
      tier: 'rare',
      skills: { [a]: randInt(rng, 20, 30), [b]: randInt(rng, 10, 20) },
    });
  }
  for (let n = 0; n < LEGENDARY; n++) {
    const base = names[idx++];
    const name = `${base}, ${epithets[n]}`;
    if (rng() < 0.5) {
      const skill = cycle.next();
      crew.push({ name, tier: 'legendary', skills: { [skill]: randInt(rng, 40, 45) } });
    } else {
      const [a, b] = cycle.nextPair();
      crew.push({ name, tier: 'legendary', skills: { [a]: 30, [b]: 20 } });
    }
  }
  return crew;
}

export function generateManifests(seed = 'skyharbour-genesis'): { ships: ShipEntry[]; crew: CrewEntry[] } {
  const rng = makeRng(hashSeed(seed));
  const ships = buildShips(rng);
  const crew = buildCrew(rng);
  return { ships, crew };
}

async function main() {
  const cfg = loadChainConfig();
  const { ships, crew } = generateManifests();
  fs.mkdirSync(cfg.chainDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.chainDir, 'manifest-ships.json'), JSON.stringify(ships, null, 2));
  fs.writeFileSync(path.join(cfg.chainDir, 'manifest-crew.json'), JSON.stringify(crew, null, 2));
  console.log(`wrote ${ships.length} ships and ${crew.length} crew to ${cfg.chainDir}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
