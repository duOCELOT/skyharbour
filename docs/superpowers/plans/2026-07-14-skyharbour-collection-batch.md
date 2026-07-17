# Skyharbour Collection Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the NFT collection design real: HAULING crew skill (effective cargo) wired through sim + server, mission amounts scale with settlement stage (CARGO > 20 stops being dead weight), BRIDGE display rename, a seeded generator for the owner-approved 101-ship / 2000-crew manifests, and a batch-mint script.

**Architecture:** HAULING mirrors the FUEL pattern (client model + server validator share the formula: `effectiveCargo = ship.cargo + min(Σ hauling, 30)`); mission amount cap becomes a pure function of stage index; manifests are generated deterministically (seeded LCG, curated name lists) into `server/chain/manifest-*.json` for owner review, and `chain:mint-batch` mints ranges of them via the existing umi path.

**Tech Stack:** unchanged.

## Global Constraints

- Owner-locked collection numbers: ships 101 = Hauler 45 (ENGINE 6–9, CARGO 28–40, BRIDGE 3) / Freighter 30 (10–13, 16–24, 2) / Courier 20 (16–20, 6–10, 1) / Relic 5 (14–16, 26–30, 3) / Flagship 1 (20, 40, 4, name "SH-101 Void Sovereign", rarity `flagship`). Crew 2000 = common 1300 (single skill 10–20) / uncommon 500 (single 25–35) / rare 180 (dual: primary 20–30 + secondary 10–20) / legendary 20 (single 40–45 OR dual 30+20).
- Crew skills are exactly `fuel | defense | attack | hauling`. Caps: fuel 50, defense 90, hauling 30 (attack uncapped-dormant). `effectiveCargo(ship, crew) = ship.cargo + haulingSkill(crew)`.
- Mission amount cap = `20 + 10 * stageIndex` (stage 0 → 20 … stage 3 → 50); amounts roll 5..cap (still clamped by remaining need and ≥1).
- BRIDGE is the DISPLAY name for crew capacity; internal field stays `crewSlots` (registry/manifest field `bridge` maps to it at mint time).
- Manifest generation is deterministic for seed string `skyharbour-genesis`; ship and crew names unique within their manifests.
- Suite + typecheck green from `server/` before every commit; client HTML escaped; dev mode byte-compatible.
- Plan-authorized test edits (mechanical): validation/flightMath cargo-clamp tests that assert `min(ship.cargo, amount)` gain the hauling-aware form (with empty crew the value is identical — only tests that add hauling crew change expectations); missions generation amount-bound assertions move from `≤20` to `≤ missionAmountCap(stage)`.

---

### Task 1: HAULING skill — one formula, both sides

**Files:**
- Modify: `server/src/fleet.ts` (skills type + one new NPC), `server/src/validation.ts`, `server/src/missions.ts` (complete clamp), `client/flightMath.js` + `client/flightMath.d.ts`, `client/render.js` (skillLabel HAUL)
- Test: `server/test/client/flightMath.test.ts`, `server/test/missions.test.ts`, `server/test/client/render.test.ts`

**Interfaces:**
- Produces:
  - `CrewMember.skills` gains `hauling?: number` (fleet.ts type).
  - validation.ts: `export const haulingSkill = (crew: Pick<CrewMember,'skills'>[]) => Math.min(crew.reduce((s,c)=>s+(c.skills?.hauling ?? 0),0), 30);` and `export const effectiveCargo = (ship: Ship, crew: Pick<CrewMember,'skills'>[]) => ship.cargo + haulingSkill(crew);` — `validateRun`'s cargo rule becomes `t.cargoDelivered > Math.min(effectiveCargo(ship, crew), params.missionAmount)`.
  - missions.ts `complete()`: delivered clamp already flows through validateRun; ALSO the crew resolved for validation must include hauling (it does — skills come from fleet). No formula change beyond importing nothing new.
  - flightMath.js: `mkRun` stores `hauling: Math.min(Σ crew hauling, 30)`; `telemetry()` returns `cargoDelivered: Math.min(ship.cargo + run.hauling, mission.amount)`.
  - fleet.ts `NPC_CREW` gains `{ member: { id: 'npc-longshoreman', owner: HARBOUR, skills: { hauling: 20 } }, sharePct: 12 }` (7 NPCs total — update the count test).
  - render.js `skillLabel` shows `HAUL n`.

- [ ] **Step 1: Failing tests**

`server/test/client/flightMath.test.ts` add:
```ts
it('hauling crew raise delivered cargo past the hull cap', () => {
  const world = mkWorld('haul', 100); world.rocks = [];
  const hauler = { id: 'h', skills: { hauling: 20 } };
  const run = mkRun({ id: 's', owner: 'a', engine: 10, cargo: 8, crewSlots: 2 } as any, [hauler], 100, 1000);
  while (!run.done) stepRun(run, 0.1, { yaw: 0, throttle: 1 }, world);
  const t = telemetry(run, { amount: 25, distance: 100 }, { cargo: 8 } as any);
  expect(t.cargoDelivered).toBe(25 > 8 + 20 ? 28 : 25); // = min(8+20, 25) = 25? no: min(28,25)=25
});
```
Write it cleanly: `expect(t.cargoDelivered).toBe(Math.min(8 + 20, 25));` (= 25).
`server/test/missions.test.ts` add (uses the stub-FleetSource pattern already in the file):
```ts
it('hauling crew let a small ship complete a big contract server-side', () => {
  // engine over a stub fleet: ship cargo 8, crew with hauling 20 listed by harbour-style owner
  // accept with that crew, complete with cargoDelivered = min(8+20, m.amount)
  // assert payout.delivered === Math.min(28, m.amount) and no validation rejection
});
```
Write it concretely with the stub fleet (ship `tug-1` cargo 8 owner alice; crew `dock-1` owner alice hauling 20 — own crew, no listing needed; crewIds ['dock-1']; telemetry duration/fuel per formulas; delivered `Math.min(28, m.amount)`).
`server/test/client/render.test.ts`: skillLabel shows `HAUL 20` for `{ hauling: 20 }` listing.
Also update `server/test/fleet.test.ts` NPC count assertion 6 → 7 (authorized) and assert `npc-longshoreman` hauling 20.

- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement** per Interfaces (validation.ts is the single source for the server; flightMath mirrors with the same 30 cap; keep both commented `// HAULING cap 30 — mirror of server validation.ts`).
- [ ] **Step 4: Full suite + typecheck** — green.
- [ ] **Step 5: Commit** — `git add -A server/src client server/test && git commit -m "feat: HAULING crew skill — effective cargo on both sides of the anti-cheat line"`

---

### Task 2: Mission amounts scale with settlement stage

**Files:**
- Modify: `server/src/missions.ts` (generate)
- Test: `server/test/missions.test.ts`

**Interfaces:**
- Produces: `export const missionAmountCap = (stageIndex: number) => 20 + 10 * stageIndex;` — `generate()` computes `const stageIdx = this.settlement.currentStage()?.index ?? 0;` and `const amount = Math.max(1, Math.min(remaining, 5 + Math.floor(Math.random() * (missionAmountCap(stageIdx) - 4))));` (roll 5..cap before remaining/1 clamps).

- [ ] **Step 1: Failing tests**
```ts
it('mission amount cap grows with the settlement stage', () => {
  expect(missionAmountCap(0)).toBe(20);
  expect(missionAmountCap(3)).toBe(50);
});
it('generated amounts respect the current-stage cap', () => {
  for (let i = 0; i < 30; i++) {
    const [m] = engine.generate(1);
    expect(m.amount).toBeLessThanOrEqual(missionAmountCap(0));
    expect(m.amount).toBeGreaterThanOrEqual(1);
  }
});
```
(Existing amount-range assertions, if any pin `5..20`, update per Global Constraints — authorized.)

- [ ] **Steps 2-4:** RED → implement → full suite + typecheck green.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): mission amounts scale with settlement stage — big hulls matter"` (with the two files).

---

### Task 3: BRIDGE display rename

**Files:**
- Modify: `client/render.js` (hangar line), `index.html` (any static 'CREW n' ship copy), `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (§3 ships attribute note)
- Test: `server/test/client/render.test.ts`

**Interfaces:** display-only; internal `crewSlots` unchanged everywhere.

- [ ] **Step 1: Failing test** — renderHangar output contains `BRIDGE 2` (not `CREW 2`) for a crewSlots-2 ship.
- [ ] **Step 2-4:** RED → change `renderHangar`'s stats line to `ENGINE ${…} · CARGO ${…} · BRIDGE ${…}`; update index.html static hangar copy if it hardcodes CREW; spec §3 row: `ENGINE (speed), CARGO (capacity), BRIDGE (crew stations)`. Suite + typecheck green.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): BRIDGE is the ship's crew capacity — display rename"`

---

### Task 4: Seeded manifest generator (101 ships / 2000 crew)

**Files:**
- Create: `server/scripts/gen-manifests.ts`
- Create (generated, committed): `server/chain/manifest-ships.json`, `server/chain/manifest-crew.json`
- Modify: `server/package.json` (script `chain:gen-manifests`)
- Test: `server/test/chain/manifests.test.ts`

**Interfaces:**
- Produces:
  - Pure exported generator: `export function generateManifests(seed = 'skyharbour-genesis'): { ships: ShipEntry[]; crew: CrewEntry[] }` where `ShipEntry = { name: string; class: 'hauler'|'freighter'|'courier'|'relic'|'flagship'; engine: number; cargo: number; bridge: number; rarity: 'common'|'uncommon'|'rare'|'relic'|'flagship' }` (hauler→common, freighter→uncommon, courier→rare) and `CrewEntry = { name: string; tier: 'common'|'uncommon'|'rare'|'legendary'; skills: Partial<Record<'fuel'|'defense'|'attack'|'hauling', number>> }`.
  - Deterministic: same seed → identical output (reuse the FNV/LCG pattern from flightMath, reimplemented locally in TS).
  - Names: ships from `SHIP_PREFIX` (~24: Iron, Rust, Void, Gale, Ember, Salt, Cinder, Bruma, Keel, Drift, Sky, Storm, Ash, Copper, Bright, Dun, Hollow, Long, True, Wander, Last, First, Grey, Bold) × `SHIP_NOUN` (~24: Wager, Harrow, Pilgrim, Mule, Heron, Lantern, Anchor, Chariot, Sparrow, Whale, Otter, Crane, Badger, Comet, Furrow, Gull, Mantle, Porter, Runner, Saddle, Tide, Vagrant, Wren, Bastion) — pick unique pairs deterministically; flagship fixed name "Void Sovereign". Crew from `CREW_FIRST` (~50 varied) × `CREW_LAST` (~48 varied) unique pairs; legendaries get epithets appended from a 20-list (e.g. "the Unburnt", "Threefinger", …).
  - Tier skill assignment: skill picked round-robin-weighted among the four (attack included — dormant by design); values uniform in the tier's range; rare duals pick two distinct skills; legendary 50/50 single 40–45 or dual 30+20.
  - CLI (`isMain` guard like mint-nft.ts): writes both JSONs pretty-printed to `chainDir`.

- [ ] **Step 1: Failing tests**
```ts
import { generateManifests } from '../../scripts/gen-manifests.js';
const { ships, crew } = generateManifests();

it('deterministic', () => { expect(generateManifests()).toEqual(generateManifests()); });
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
  }
  const flag = ships.find((x) => x.class === 'flagship')!;
  expect([flag.engine, flag.cargo, flag.bridge, flag.name]).toEqual([20, 40, 4, 'Void Sovereign']);
});
it('crew census and caps', () => {
  expect(crew).toHaveLength(2000);
  const by = (t: string) => crew.filter((c) => c.tier === t).length;
  expect([by('common'), by('uncommon'), by('rare'), by('legendary')]).toEqual([1300, 500, 180, 20]);
  for (const c of crew) for (const v of Object.values(c.skills)) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThanOrEqual(45); }
});
it('names unique per manifest', () => {
  expect(new Set(ships.map((s) => s.name)).size).toBe(101);
  expect(new Set(crew.map((c) => c.name)).size).toBe(2000);
});
```
(Note: 50×48 = 2400 base pairs < 2000 needed? 2400 > 2000 — fine; verify list sizes give ≥2000 unique pairs, expand lists if the generator runs dry — the generator must throw a clear error if name pools exhaust.)

- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement** the generator (pure function + isMain CLI writer). Run `npm run chain:gen-manifests` to produce and commit both JSONs.
- [ ] **Step 4: Full suite + typecheck** — green.
- [ ] **Step 5: Commit** — `git add server/scripts/gen-manifests.ts server/chain/manifest-ships.json server/chain/manifest-crew.json server/package.json server/test/chain/manifests.test.ts && git commit -m "feat(chain): genesis manifests — 101 ships, 2000 crew, seeded and reviewable"`

---

### Task 5: Batch-mint script

**Files:**
- Create: `server/scripts/mint-batch.ts`
- Modify: `server/package.json` (script `chain:mint-batch`), `server/chain/README.md`
- Test: typecheck + a pure-slice test in `server/test/chain/manifests.test.ts` (registry-entry mapping)

**Interfaces:**
- Produces: `npm run chain:mint-batch -- --manifest ships --from 1 --to 10 [--to-wallet <pubkey>]` — loads `manifest-<ships|crew>.json`, takes 1-indexed inclusive range, and for each entry mints exactly like mint-nft.ts (createNft into the right collection, verifyCollectionV1, optional transfer) with `uri` from an optional per-entry `image` field (reuse `buildMetadata`/`slugify`/`imageUrl`/`metadataUrl` imports from `./mint-nft.js` — they are exported) writing metadata files only when `image` present; appends registry entries after EACH mint (crash-resumable: skip entries whose derived id already exists in registry). Registry mapping (pure, exported, tested): `export function manifestToRegistryEntry(kind: 'ship'|'crew', entry, id: string)` → ship `{ type:'ship', id, engine, cargo, crewSlots: entry.bridge }` / crew `{ type:'crew', id, skills }`. Ids: `SH-<index padded 3> <name>` / `CR-<index padded 4> <name>` where index = manifest position (stable across runs).

- [ ] **Step 1: Failing test** — `manifestToRegistryEntry('ship', { name:'Iron Wager', class:'hauler', engine:7, cargo:30, bridge:3, rarity:'common' }, 'SH-001 Iron Wager')` → `{ type:'ship', id:'SH-001 Iron Wager', engine:7, cargo:30, crewSlots:3 }`; crew variant maps skills through untouched.
- [ ] **Step 2-4:** RED → implement script (retry helper like bootstrap; log each mint; stop on first hard failure with resume instructions) → suite + typecheck green. Operator smoke deferred until bootstrap (faucet).
- [ ] **Step 5: Commit** — `git commit -m "feat(chain): batch mint — genesis collection in resumable ranges"` (script, package.json, README, test).

---

### Task 6: Seal — hauling loop + docs

**Files:**
- Test: `server/test/client/loop.test.ts` (extend)
- Modify: `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md` (§3 crew skills line gains hauling; §5 note on stage-scaled contracts)

**Interfaces:** consumes everything above.

- [ ] **Step 1: The seal test (must pass as written — integration seal):**
```ts
it('a courier with a longshoreman out-hauls its hull through the full API loop', async () => {
  const app = buildApp();
  const h = { 'x-wallet': 'kai' };
  await app.inject({ method: 'POST', url: '/login', headers: h });
  await app.inject({ method: 'POST', url: '/fuel/buy', headers: h, payload: { gold: 25 } });
  const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: h, payload: { count: 1 } })).json();
  const acc = await app.inject({
    method: 'POST', url: `/missions/${m.id}/accept`, headers: h,
    payload: { shipId: 'kai-courier', crewIds: ['npc-longshoreman'] },
  });
  expect(acc.statusCode).toBe(200);
  const ship = { id: 'kai-courier', owner: 'kai', engine: 18, cargo: 8, crewSlots: 1 };
  const longshoreman = { id: 'npc-longshoreman', skills: { hauling: 20 } };
  const world = mkWorld(m.id, m.distance); world.rocks = [];
  const run = mkRun(ship, [longshoreman], m.distance, 5000);
  while (!run.done) stepRun(run, 1 / 60, { yaw: 0, throttle: 1 }, world);
  expect(run.outcome).toBe('landed');
  const t = telemetry(run, m, ship);
  expect(t.cargoDelivered).toBe(Math.min(8 + 20, m.amount));
  const done = await app.inject({ method: 'POST', url: `/missions/${m.id}/complete`, headers: h, payload: { telemetry: t } });
  expect(done.statusCode).toBe(200);
  expect(done.json().delivered).toBe(Math.min(28, m.amount));
});
```
- [ ] **Step 2:** Run (must pass; if the server rejects, the hauling formulas drifted — fix client side or T1 wiring, never weaken). Full suite + typecheck.
- [ ] **Step 3: Spec notes** (one line each: crew skills = fuel/defense/attack/hauling with caps; contracts scale `20+10×stage`).
- [ ] **Step 4: Commit** — `git commit -m "test: hauling seal + collection design notes in spec"`

---

## Self-review notes

- Owner decisions → tasks: HAULING (T1, hooked both sides + NPC + label), stat impact (T2 makes CARGO real; ENGINE/BRIDGE already real), BRIDGE name (T3), 101/2000 manifests per tiers (T4), mintable (T5), sealed (T6).
- Type consistency: `haulingSkill/effectiveCargo` (T1) used by T6's expectations; `missionAmountCap` (T2) used in T2 tests; `ShipEntry.bridge → crewSlots` mapping pinned in T5's pure test; telemetry signature unchanged (hauling rides in `run`).
- Deliberate: attack stays dormant; manifest `image` fields empty until the owner's art lands (mint-batch + --image single-mints coexist); actual minting waits on the faucet.
