// Pure flight model. No three.js, no DOM — flight.js renders this, and the
// server's resolveRun() (below) is the authority on the outcome. The
// fuel/speed constants are locked to the server's physics floor:
//   speed = throttle * engine (units/s)
//   fuel/s = throttle * engine * (1 - fuelSkill/100)
// so a straight full-throttle run burns ≈ distance * (1 - skill) — the
// exact server minimum; any dodging or throttle-dithering burns more.

// World geometry is 10x the economy distance — longer trips, identical
// fuel/reward math; server floors (duration >= d/engine, fuel >= minFuel)
// remain satisfied since duration grows and total fuel is unchanged.
export const WORLD_SCALE = 10;

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 16807) >>> 0) % 2147483647; return s / 2147483647; };
}

export function mkWorld(seedStr, distance, cargo = 'LOG') {
  const r = rng(hashSeed(seedStr));
  const rocks = [];
  // Hazards exist above 60u. Short crossings (<=80) use a tighter 30u buffer
  // so DEFENSE crew matter there too; long crossings keep the 40u buffer.
  const buffer = distance > 80 ? 40 : 30;
  const span = distance - 2 * buffer;
  const nRocks = distance > 60 ? Math.floor(distance / 12) : 0;
  for (let i = 0; i < nRocks; i++) {
    rocks.push({
      x: (r() - 0.5) * 220,               // corridor |x| < 120 incl. radius
      y: (r() - 0.5) * 30,
      z: (buffer + r() * span) * WORLD_SCALE,
      r: 4 + r() * 8,
    });
  }
  const islands = [];
  const nIslands = Math.max(3, Math.floor(distance / 30));
  for (let i = 0; i < nIslands; i++) {
    const side = r() < 0.5 ? -1 : 1;
    islands.push({
      x: side * (160 + r() * 260),
      y: 20 + r() * 60,
      z: r() * distance * WORLD_SCALE,
      r: 30 + r() * 70,
    });
  }
  // Raiders are drawn AFTER islands so pre-combat seeds' rock/island layouts
  // stay byte-identical — old worlds must not shift when this feature lands.
  const raiders = [];
  const nRaiders = raiderCount(seedStr, distance, cargo);
  const raiderSpan = (distance - 40) - distance * 0.45;
  for (let i = 0; i < nRaiders; i++) {
    raiders.push({
      x: (r() - 0.5) * 200,
      y: (r() - 0.5) * 30,
      z: (distance * 0.45 + r() * raiderSpan) * WORLD_SCALE,
      hp: 2,
    });
  }
  // Target sits at distance*WORLD_SCALE+25 so the 25-unit landing radius
  // (unchanged) starts triggering at scaled pos.z ≈ distance*WORLD_SCALE,
  // keeping honest durations >= distance/engine well clear of the floor.
  return { rocks, islands, raiders, target: { x: 0, y: 0, z: distance * WORLD_SCALE + 25 } };
}

export const fuelSkill = (crew) => Math.min(crew.reduce((s, c) => s + (c.skills?.fuel ?? 0), 0), 50);
export const defenseSkill = (crew) => Math.min(crew.reduce((s, c) => s + (c.skills?.defense ?? 0), 0), 90);
// HAULING cap 30 — mirror of server validation.ts
export const haulingSkill = (crew) => Math.min(crew.reduce((s, c) => s + (c.skills?.hauling ?? 0), 0), 30);

// Raiders ambush long routes. The count is deterministic so the server can
// bound bounty claims without simulating combat.
export function raiderCount(missionId, distance, cargo) {
  if (distance <= 120) return 0;
  return Math.min(3, 1 + (hashSeed(`${missionId}:raiders`) % 2) + (cargo === 'FIRERUNE' ? 1 : 0));
}

export const attackSkill = (crew) => Math.min(crew.reduce((s, c) => s + (c.skills?.attack ?? 0), 0), 50);
export const cannonDamage = (atk) => 1 + Math.floor(atk / 25);
export const cannonCooldown = (atk) => 0.8 * (1 - atk / 100);

// Mirrors server/src/validation.ts minFuel exactly. flightMath is client-side
// and cannot import server code, so this is a local mirror kept in lockstep;
// fuelSkill already caps the crew sum at 50, matching validation.ts's cap.
export const minFuelClient = (distance, crew) => Math.ceil(distance * (1 - fuelSkill(crew) / 100));

// One deterministic draw in [0,1) for a given key, seeded off the mission
// context. `rng` stays module-private; this is the only reachable surface.
function seededChance(key) {
  return rng(hashSeed(key))();
}

// Raiders ambush from ENGAGE_RANGE_WORLD world-units out until they reach the
// player's z (world speed v = engine, matching stepRun's pos.z += throttle*engine*dt).
export const ENGAGE_RANGE_WORLD = 300;

export function raiderTimeline(missionId, distance, cargo, engine) {
  const { raiders } = mkWorld(missionId, distance, cargo);
  return raiders.map((raider) => {
    const attackAt = raider.z / engine;
    const engageStart = Math.max(0, (raider.z - ENGAGE_RANGE_WORLD) / engine);
    return { engageStart, attackAt };
  });
}

// Turns (mission, ship, crew, startHull, ammoAvailable, fireEvents) into the
// authoritative run outcome. The server calls this instead of trusting a
// client-reported outcome — it is the anti-cheat core. Uses ONLY
// integer/time arithmetic and the existing seeded rng: no Math.random, no
// Date.now/wall-clock, no trig. Identical inputs => byte-identical outputs.
export function resolveRun({ missionId, distance, cargo, amount, ship, crew, startHull, ammoAvailable, fireEvents }) {
  const engine = ship.engine;
  const T = (distance * WORLD_SCALE) / engine;
  const atk = attackSkill(crew);
  const N = raiderCount(missionId, distance, cargo);

  // --- 1. Validate the trace ---
  if (!Array.isArray(fireEvents)) return { ok: false, reason: 'fireEvents not an array' };
  if (fireEvents.length > ammoAvailable + 1) return { ok: false, reason: 'trace longer than magazine' };
  let lastT = -Infinity;
  for (const ev of fireEvents) {
    if (ev === null || typeof ev !== 'object') return { ok: false, reason: 'bad shot event' };
    if (typeof ev.t !== 'number' || !Number.isFinite(ev.t) || ev.t < 0 || ev.t > T) {
      return { ok: false, reason: 'bad shot time' };
    }
    if (ev.t < lastT) return { ok: false, reason: 'shot times not non-decreasing' };
    lastT = ev.t;
    if (ev.raider !== null && !(Number.isInteger(ev.raider) && ev.raider >= 0 && ev.raider < N)) {
      return { ok: false, reason: 'bad raider index' };
    }
  }

  // Cadence + ammo cap: walk in order, drop cadence-invalid shots, cap accepted
  // shots at ammoAvailable.
  const cooldown = cannonCooldown(atk);
  const accepted = [];
  lastT = -Infinity;
  for (const ev of fireEvents) {
    if (accepted.length >= ammoAvailable) break;
    if (ev.t - lastT >= cooldown) {
      accepted.push(ev);
      lastT = ev.t;
    }
  }
  const ammoSpent = accepted.length;

  // --- 2. Kills ---
  const timeline = raiderTimeline(missionId, distance, cargo, engine);
  const killedBy = new Array(N).fill(Infinity);
  let raidersDestroyed = 0;
  for (let i = 0; i < N; i++) {
    const { engageStart, attackAt } = timeline[i];
    let dmg = 0;
    for (const ev of accepted) {
      if (ev.raider !== i) continue;
      if (ev.t < engageStart || ev.t > attackAt) continue;
      dmg += cannonDamage(atk);
      if (dmg >= 2) { killedBy[i] = ev.t; break; }
    }
    if (killedBy[i] !== Infinity) raidersDestroyed++;
  }

  // --- 3. Attacks ---
  const def = defenseSkill(crew);
  let hull = startHull;
  let raiderHits = 0;
  for (let i = 0; i < N; i++) {
    const { attackAt } = timeline[i];
    if (killedBy[i] > attackAt) {
      const dodged = seededChance(`${missionId}:hit:${i}`) < def / 100;
      if (!dodged) { hull -= 1; raiderHits++; }
    }
  }

  // --- 4. Rocks ---
  // A rock only threatens hull if a straight run down the flight centerline
  // (x=0 — the resolver has no trusted position trace, only fire-event
  // timing) would pass within its collision radius. This mirrors stepRun's
  // `dx*dx+dz*dz < (r+6)^2` check exactly: the ship flies straight up z at
  // x=0, so at the rock's z-crossing (dz=0) the test reduces to `k.x^2 <
  // (r+6)^2` — a pure cross-corridor gate. y is not in the sim's collision
  // plane (stepRun ignores it), so it must not gate here either, or on-screen
  // rock strikes would diverge from what the server charges. Off-corridor
  // rocks (most of the wide-scattered field) auto-miss and draw no chance.
  const { rocks } = mkWorld(missionId, distance, cargo);
  for (let j = 0; j < rocks.length; j++) {
    const k = rocks[j];
    const threat = k.r + 6;
    if (k.x * k.x >= threat * threat) continue; // off-corridor: auto-miss
    const safe = seededChance(`${missionId}:rock:${j}`) < def / 100;
    if (!safe) hull -= 1;
  }

  // --- 5. Outcome ---
  const hauling = haulingSkill(crew);
  const loaded = Math.min(ship.cargo + hauling, amount);
  const spill = raiderHits * Math.ceil(loaded * 0.1);
  const cargoDelivered = Math.max(0, loaded - spill);
  const outcome = hull <= 0 ? 'void' : 'landed';
  const finalHull = Math.max(1, hull);
  const hullDamage = startHull - finalHull;
  const fuelSpent = minFuelClient(distance, crew);

  return {
    ok: true,
    raidersDestroyed,
    raiderHits,
    ammoSpent,
    fuelSpent,
    loaded,
    cargoDelivered,
    hullDamage,
    finalHull,
    outcome,
  };
}

// startHull defaults to the ship's full armor rating (a fresh mission
// starts undamaged); flight.js passes the ship's persisted currentHull so a
// battered ship launches battered instead of resetting to full every run.
// Clamped to ship.hull so a stale/inflated currentHull (e.g. a hull upgrade
// that shrank max) can never launch a run above the ship's real cap.
export function mkRun(ship, crew, distance, fuelBudget, ammoBudget = 0, startHull = ship.hull) {
  return {
    pos: { x: 0, z: 0 }, heading: 0, throttle: 1,
    fuel: 0, fuelBudget, ammoBudget, shots: 0, hull: Math.min(startHull, ship.hull), t: 0, distance,
    engine: ship.engine,
    fuelSkill: fuelSkill(crew), defense: defenseSkill(crew), hauling: haulingSkill(crew),
    attack: attackSkill(crew), kills: 0, raiderHits: 0,
    struck: new Set(), done: false, outcome: null,
  };
}

export function fireShot(run) {
  if (run.done || run.shots >= run.ammoBudget) return false;
  run.shots += 1;
  return true;
}

// Applies one raider attack against the run's cosmetic three.js sim. Dodge
// odds scale with DEFENSE crew, mirroring the rock-strike check in stepRun.
// Purely local flavor now — the server never reads run.hull/raiderHits, it
// derives its own via resolveRun from the posted fireEvents. On a hit, hull
// drops; if that breaches the hull we set done/outcome='void' immediately
// (stepRun's own dry/void checks would reach the same conclusion next tick,
// but combat hits happen out of band from stepRun's per-frame loop, so we
// resolve it here to match).
export function applyRaiderHit(run, rand = Math.random) {
  if (run.done) return 'dodged'; // the void already has this one — no post-mortem hits
  if (rand() < run.defense / 100) return 'dodged';
  run.hull -= 1;
  run.raiderHits += 1;
  if (run.hull <= 0) { run.done = true; run.outcome = 'void'; }
  return 'hit';
}

export function registerKill(run) {
  run.kills += 1;
}

const YAW_RATE = 1.6; // rad/s

export function stepRun(run, dt, input, world, rand = Math.random) {
  if (run.done) return run;
  run.heading += (input.yaw ?? 0) * YAW_RATE * dt;
  run.throttle = Math.max(0, Math.min(1, input.throttle ?? 1));
  const v = run.throttle * run.engine;
  run.pos.x += Math.sin(run.heading) * v * dt;
  run.pos.z += Math.cos(run.heading) * v * dt;
  // Total over a straight scaled run = economy distance * (1 - skill), same
  // as before WORLD_SCALE: the world is 10x longer but this rate is 10x
  // slower, so the time-integral is unchanged.
  run.fuel += run.throttle * run.engine * (1 - run.fuelSkill / 100) / WORLD_SCALE * dt;
  run.t += dt;

  for (let i = 0; i < world.rocks.length; i++) {
    if (run.struck.has(i)) continue;
    const k = world.rocks[i];
    const dx = run.pos.x - k.x, dz = run.pos.z - k.z;
    if (dx * dx + dz * dz < (k.r + 6) * (k.r + 6)) {
      run.struck.add(i);
      if (rand() >= run.defense / 100) run.hull -= 1;
    }
  }

  const tx = run.pos.x - world.target.x, tz = run.pos.z - world.target.z;
  if (tx * tx + tz * tz < 25 * 25) { run.done = true; run.outcome = 'landed'; }
  else if (run.hull <= 0) { run.done = true; run.outcome = 'void'; }
  else if (run.fuel >= run.fuelBudget) { run.done = true; run.outcome = 'dry'; }
  return run;
}

