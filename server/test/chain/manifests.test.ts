import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { generateManifests, pickUniquePairs, makeRng } from '../../scripts/gen-manifests.js';
import { manifestToRegistryEntry } from '../../scripts/mint-batch.js';
import { loadChainConfig } from '../../src/chain/config.js';

const { ships, crew } = generateManifests();

describe('genesis manifests', () => {
  it('deterministic', () => {
    expect(generateManifests()).toEqual(generateManifests());
  });

  it('ship census matches the locked tiers', () => {
    expect(ships).toHaveLength(101);
    const by = (c: string) => ships.filter((s) => s.class === c).length;
    expect([by('hauler'), by('freighter'), by('courier'), by('relic'), by('flagship')]).toEqual([45, 30, 20, 5, 1]);
  });

  it('stats stay in class ranges', () => {
    for (const s of ships.filter((x) => x.class === 'hauler')) {
      expect(s.engine).toBeGreaterThanOrEqual(6); expect(s.engine).toBeLessThanOrEqual(9);
      expect(s.cargo).toBeGreaterThanOrEqual(28); expect(s.cargo).toBeLessThanOrEqual(40);
      expect(s.bridge).toBe(3);
      expect(s.hull).toBeGreaterThanOrEqual(10); expect(s.hull).toBeLessThanOrEqual(12);
    }
    for (const s of ships.filter((x) => x.class === 'freighter')) {
      expect(s.engine).toBeGreaterThanOrEqual(10); expect(s.engine).toBeLessThanOrEqual(13);
      expect(s.cargo).toBeGreaterThanOrEqual(16); expect(s.cargo).toBeLessThanOrEqual(24);
      expect(s.bridge).toBe(2);
      expect(s.hull).toBeGreaterThanOrEqual(8); expect(s.hull).toBeLessThanOrEqual(9);
    }
    for (const s of ships.filter((x) => x.class === 'courier')) {
      expect(s.engine).toBeGreaterThanOrEqual(16); expect(s.engine).toBeLessThanOrEqual(20);
      expect(s.cargo).toBeGreaterThanOrEqual(6); expect(s.cargo).toBeLessThanOrEqual(10);
      expect(s.bridge).toBe(1);
      expect(s.hull).toBeGreaterThanOrEqual(5); expect(s.hull).toBeLessThanOrEqual(6);
    }
    for (const s of ships.filter((x) => x.class === 'relic')) {
      expect(s.engine).toBeGreaterThanOrEqual(14); expect(s.engine).toBeLessThanOrEqual(16);
      expect(s.cargo).toBeGreaterThanOrEqual(26); expect(s.cargo).toBeLessThanOrEqual(30);
      expect(s.bridge).toBe(3);
      expect(s.hull).toBeGreaterThanOrEqual(9); expect(s.hull).toBeLessThanOrEqual(10);
    }
    const flag = ships.find((x) => x.class === 'flagship')!;
    expect([flag.engine, flag.cargo, flag.bridge, flag.hull, flag.name]).toEqual([20, 40, 4, 14, 'Void Sovereign']);
  });

  it('ship rarity mirrors class per the locked mapping', () => {
    for (const s of ships) {
      const expected = { hauler: 'common', freighter: 'uncommon', courier: 'rare', relic: 'relic', flagship: 'flagship' }[s.class];
      expect(s.rarity).toBe(expected);
    }
  });

  it('crew census and caps', () => {
    expect(crew).toHaveLength(2000);
    const by = (t: string) => crew.filter((c) => c.tier === t).length;
    expect([by('common'), by('uncommon'), by('rare'), by('legendary')]).toEqual([1300, 500, 180, 20]);
    for (const c of crew) for (const v of Object.values(c.skills)) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThanOrEqual(45); }
  });

  it('common crew carry exactly one skill in 10-20', () => {
    for (const c of crew.filter((x) => x.tier === 'common')) {
      const vals = Object.values(c.skills);
      expect(vals).toHaveLength(1);
      expect(vals[0]).toBeGreaterThanOrEqual(10);
      expect(vals[0]).toBeLessThanOrEqual(20);
    }
  });

  it('uncommon crew carry exactly one skill in 25-35', () => {
    for (const c of crew.filter((x) => x.tier === 'uncommon')) {
      const vals = Object.values(c.skills);
      expect(vals).toHaveLength(1);
      expect(vals[0]).toBeGreaterThanOrEqual(25);
      expect(vals[0]).toBeLessThanOrEqual(35);
    }
  });

  it('rare crew carry two distinct skills, 20-30 and 10-20', () => {
    for (const c of crew.filter((x) => x.tier === 'rare')) {
      const entries = Object.entries(c.skills);
      expect(entries).toHaveLength(2);
      const vals = entries.map(([, v]) => v as number).sort((a, b) => b - a);
      expect(vals[0]).toBeGreaterThanOrEqual(20); expect(vals[0]).toBeLessThanOrEqual(30);
      expect(vals[1]).toBeGreaterThanOrEqual(10); expect(vals[1]).toBeLessThanOrEqual(20);
    }
  });

  it('legendary crew are single 40-45 or dual 30+20', () => {
    for (const c of crew.filter((x) => x.tier === 'legendary')) {
      const vals = Object.values(c.skills) as number[];
      if (vals.length === 1) {
        expect(vals[0]).toBeGreaterThanOrEqual(40);
        expect(vals[0]).toBeLessThanOrEqual(45);
      } else {
        expect(vals.length).toBe(2);
        expect(vals.slice().sort((a, b) => b - a)).toEqual([30, 20]);
      }
    }
  });

  it('names unique per manifest', () => {
    expect(new Set(ships.map((s) => s.name)).size).toBe(101);
    expect(new Set(crew.map((c) => c.name)).size).toBe(2000);
  });

  it('throws a clear error when a name pool cannot cover the requested count', () => {
    const rng = makeRng(1);
    expect(() => pickUniquePairs(['a', 'b'], ['x', 'y'], 5, rng)).toThrow(/pool/i);
    // sanity: within capacity it succeeds and returns unique "first last" strings
    const ok = pickUniquePairs(['a', 'b'], ['x', 'y'], 4, rng);
    expect(new Set(ok).size).toBe(4);
  });
});

describe('manifestToRegistryEntry', () => {
  it('maps a ship manifest entry to a registry entry, bridge → crewSlots', () => {
    const entry = { name: 'Iron Wager', class: 'hauler', engine: 7, cargo: 30, bridge: 3, hull: 11, rarity: 'common' } as const;
    expect(manifestToRegistryEntry('ship', entry, 'SH-001 Iron Wager')).toEqual({
      type: 'ship',
      id: 'SH-001 Iron Wager',
      engine: 7,
      cargo: 30,
      crewSlots: 3,
      hull: 11,
    });
  });

  it('maps a crew manifest entry to a registry entry, skills passed through untouched', () => {
    const entry = { name: 'Mara Voss', tier: 'common', skills: { fuel: 16 } } as const;
    expect(manifestToRegistryEntry('crew', entry, 'CR-0001 Mara Voss')).toEqual({
      type: 'crew',
      id: 'CR-0001 Mara Voss',
      skills: { fuel: 16 },
    });
  });
});

describe('manifest drift guard', () => {
  it('committed manifest files match the generator output', () => {
    const cfg = loadChainConfig();
    const generated = generateManifests();

    const shipsPath = path.join(cfg.chainDir, 'manifest-ships.json');
    const crewPath = path.join(cfg.chainDir, 'manifest-crew.json');

    if (fs.existsSync(shipsPath) && fs.existsSync(crewPath)) {
      const committedShips = JSON.parse(fs.readFileSync(shipsPath, 'utf8'));
      const committedCrew = JSON.parse(fs.readFileSync(crewPath, 'utf8'));

      expect(committedShips).toEqual(generated.ships);
      expect(committedCrew).toEqual(generated.crew);
    }
  });
});
