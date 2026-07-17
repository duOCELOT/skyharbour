import * as THREE from 'three';
import { mkWorld, mkRun, stepRun, applyRaiderHit, registerKill, cannonDamage, cannonCooldown, fireShot, WORLD_SCALE } from './flightMath.js';
import { completeMission, failMission, balances } from './api.js';
import { escapeHtml } from './render.js';

const PHOSPHOR = 0x41ff7a;
const overlay = document.getElementById('flight-overlay');

// Combat tuning — see task-4-brief.md's interface block for the source of
// these numbers; kept as named constants instead of inline literals so the
// per-frame combat step reads like a spec, not arithmetic.
const RAIDER_SPEED = 5; // u/s, chasing a point ahead of the player
const RAIDER_AHEAD = 35; // u, how far ahead of the player raiders converge on
const RAIDER_FIRE_INTERVAL = 3.5; // s between raider bolts
const RAIDER_BOLT_SPEED = 45; // u/s
const RAIDER_BOLT_MAXAGE = 4; // s
const RAIDER_ENGAGE_RANGE = 300; // u — raiders idle beyond this, no seek/no fire
const PLAYER_BOLT_SPEED = 120; // u/s
const PLAYER_BOLT_MAXAGE = 4; // s — not spec'd by the brief, but bolts must
// expire eventually or a long, low-attack flight accumulates them forever.
const HIT_RADIUS_RAIDER = 8; // u, player bolt vs raider
const HIT_RADIUS_PLAYER = 6; // u, raider bolt vs player
const HUD_HIT_MS = 150; // ms the HUD hit-flash class stays on
const GUN_DRY_MS = 200; // ms the gun dot flashes dim red on a dry trigger (out of ammo)
const GUN_DRY_COLOR = 'rgba(255, 98, 71, 0.4)'; // dim --danger — distinguishes "out of ammo" from the cooldown dim

// Module-level singleton renderer: WebGL contexts are capped (~16 live per
// browser), so we create one renderer for the page's lifetime and reuse it
// across flights instead of allocating a new one on every launch().
let renderer = null;
function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  }
  return renderer;
}

let flying = false;

function lineMat(opacity = 1) {
  return new THREE.LineBasicMaterial({ color: PHOSPHOR, transparent: opacity < 1, opacity });
}

function wireIsland(r) {
  const g = new THREE.Group();
  const n = 8;
  const top = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    top.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r * 0.8));
  }
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(top), lineMat(0.5)));
  const keel = new THREE.Vector3(0, -r * 1.4, 0);
  for (let i = 0; i < n; i += 2) {
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([top[i], keel]), lineMat(0.35)));
  }
  return g;
}

function wireRock(r) {
  const geo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(r, 0));
  return new THREE.LineSegments(geo, lineMat(0.8));
}

// Raider hull, built the same way as wireIsland: a rim loop plus spokes to
// a belly point. `scale` lets raiders reuse it at 1.2x per the brief.
function wireShip(scale = 1) {
  const g = new THREE.Group();
  const rim = [
    new THREE.Vector3(0, 0, 3),
    new THREE.Vector3(2, 0, -2),
    new THREE.Vector3(0, 1, -1.5),
    new THREE.Vector3(-2, 0, -2),
  ];
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(rim), lineMat(0.9)));
  const belly = new THREE.Vector3(0, -1, -1.5);
  for (const p of rim) {
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, belly]), lineMat(0.5)));
  }
  g.scale.setScalar(scale);
  return g;
}

// Shared disposal for anything removed from the scene, mid-flight or at
// debrief-close: walks the object and its descendants, freeing GPU buffers.
function disposeDeep(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m?.dispose();
  });
}

function wireSettlement() {
  const g = new THREE.Group();
  const plat = [
    new THREE.Vector3(-30, 0, 0), new THREE.Vector3(30, 0, 0),
    new THREE.Vector3(22, 5, 0), new THREE.Vector3(-22, 5, 0),
  ];
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(plat), lineMat()));
  const beam = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 60, 0)];
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(beam), lineMat(0.9)));
  return g;
}

export function launch({ mission, ship, crew }, fuelBudget, ammoBudget = 0) {
  // callers must hold the `flying` latch (see sh:launch listener)
  // Defensive: whatever control (ACCEPT, a previous debrief's RETURN TO
  // BRIDGE button, etc.) still holds keyboard focus when we open must let
  // go of it, or a stray Space keystroke can re-activate it as a click
  // instead of/in addition to firing the cannon.
  (document.activeElement instanceof HTMLElement) && document.activeElement.blur();
  overlay.classList.remove('hud-hit');
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="flight-hud">
      <span>FUEL <b id="hud-fuel">0</b></span>
      <span>HULL <b id="hud-hull">8</b></span>
      <span>DIST <b id="hud-dist">0</b></span>
      <span>THR <b id="hud-thr">100%</b></span>
      <span>RAIDERS <b id="hud-raiders">0</b></span>
      <span>SHELLS <b id="hud-shells">0</b></span>
      <span>GUN <span id="hud-gun">●</span></span>
      <span>${escapeHtml(mission.cargo)} ×${escapeHtml(mission.amount)} → SETTLEMENT</span>
    </div>`;

  const renderer = getRenderer();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  overlay.prepend(renderer.domElement);

  // 2D HUD overlay: compass strip (destination bearing), centre reticle +
  // target brackets, and a radar. Redrawn each frame from the live
  // run/raiders/camera. Purely cosmetic aim aids — the run is server-
  // authoritative — but this is the surface the pilot actually aims on.
  const hudCanvas = document.createElement('canvas');
  hudCanvas.id = 'hud-canvas';
  overlay.appendChild(hudCanvas);
  const hctx = hudCanvas.getContext('2d');
  function sizeHud() {
    const dpr = Math.min(devicePixelRatio, 2);
    hudCanvas.width = innerWidth * dpr;
    hudCanvas.height = innerHeight * dpr;
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeHud();

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x030805, 60, 700);
  scene.background = new THREE.Color(0x030805);
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);

  // stars
  const starGeo = new THREE.BufferGeometry();
  const starPos = [];
  for (let i = 0; i < 400; i++) {
    starPos.push((Math.random() - 0.5) * 3000, 100 + Math.random() * 800, (Math.random() - 0.5) * 3000);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: PHOSPHOR, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.5 })));

  const world = mkWorld(mission.id, mission.distance, mission.cargo);
  for (const k of world.rocks) { const m = wireRock(k.r); m.position.set(k.x, k.y, k.z); scene.add(m); }
  for (const o of world.islands) { const m = wireIsland(o.r); m.position.set(o.x, o.y - 40, o.z); scene.add(m); }
  const settle = wireSettlement(); settle.position.set(world.target.x, -6, world.target.z); scene.add(settle);

  // idx is the raider's position in mkWorld(...).raiders — the STABLE index
  // the server's resolveRun (and raiderTimeline) refer to. `raiders` below
  // gets spliced on death, which shifts array positions, so every fireEvent
  // must carry a bolt-hit raider's `.idx`, never its current array index.
  const raiders = world.raiders.map((rd, k) => {
    const mesh = wireShip(1.2);
    mesh.position.set(rd.x, rd.y, rd.z);
    scene.add(mesh);
    return { idx: k, mesh, hp: rd.hp, pos: new THREE.Vector3(rd.x, rd.y, rd.z), engaged: false, fireAt: performance.now() + RAIDER_FIRE_INTERVAL * 1000 };
  });
  const raiderBolts = [];
  const playerBolts = [];
  // Authoritative trace the server will replay via resolveRun: one entry per
  // fired shell, produced at bolt-resolution time (hit/miss/expiry), not at
  // fire time — see task-3-brief's fire-vs-resolve distinction.
  const fireEvents = [];
  let nextShot = 0;
  let gunDryUntil = 0; // performance.now() timestamp until which the gun dot shows dry-trigger red
  let hudHitTimer = null;
  // Edge-triggered fire request: reading `keys[' ']` once per rAF frame is a
  // level poll, and a quick tap (keydown then keyup inside the same ~16ms
  // inter-frame gap — routine under any frame-rate stutter, which live
  // WebGL play sessions get plenty of) can land entirely between two polls
  // and never be seen. keydown latches this true; stepCombat consumes and
  // clears it the moment the cooldown allows a shot, so a tap of any
  // duration always queues at least one shot instead of silently vanishing.
  let fireRequested = false;

  function makeBolt(origin, dir, speed) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(4)]);
    const mesh = new THREE.Line(geo, lineMat(1));
    mesh.position.copy(origin);
    scene.add(mesh);
    return { mesh, pos: origin.clone(), vel: dir.clone().multiplyScalar(speed), age: 0 };
  }

  // The player's cannon bolt has to be SEEN — a 1px Line spawned at the eye is
  // invisible. This is a bright, thick box tracer oriented along travel (Line
  // width is always 1px in WebGL, so a mesh is the only way to get thickness).
  function makePlayerBolt(origin, dir, speed) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.7, 7),
      new THREE.MeshBasicMaterial({ color: 0xd6ffe4 }),
    );
    mesh.position.copy(origin);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    scene.add(mesh);
    return { mesh, pos: origin.clone(), vel: dir.clone().multiplyScalar(speed), age: 0 };
  }

  function flashHud() {
    overlay.classList.add('hud-hit');
    clearTimeout(hudHitTimer);
    hudHitTimer = setTimeout(() => overlay.classList.remove('hud-hit'), HUD_HIT_MS);
  }

  // ship comes from session.ships (bridge.js), which carries currentHull
  // from /login — a battered ship launches battered instead of resetting
  // to full every run.
  const run = mkRun(ship, crew, mission.distance, fuelBudget, ammoBudget, ship.currentHull ?? ship.hull);
  const keys = {};
  const onKey = (e) => {
    if (e.key === ' ') e.preventDefault(); // block page-scroll; listener only lives during flight
    keys[e.key.toLowerCase()] = e.type === 'keydown';
    if (e.key === ' ' && e.type === 'keydown') fireRequested = true;
    if (e.key === 'Escape' && e.type === 'keydown') { run.done = true; run.outcome = 'aborted'; }
  };
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKey);
  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    sizeHud();
  };
  addEventListener('resize', onResize);

  let throttle = 1;
  let yawVel = 0; // eased steering — the helm has weight, like a ship at sea
  const TURN_EASE = 2.6; // how fast yaw ramps toward the held direction / coasts back
  let last = performance.now();

  function hud(now) {
    document.getElementById('hud-fuel').textContent = `${Math.max(0, Math.floor(fuelBudget - run.fuel))}`;
    document.getElementById('hud-hull').textContent = `${run.hull}`;
    const dx = world.target.x - run.pos.x, dz = world.target.z - run.pos.z;
    document.getElementById('hud-dist').textContent = `${Math.floor(Math.hypot(dx, dz) / WORLD_SCALE)}`;
    document.getElementById('hud-thr').textContent = `${Math.round(throttle * 100)}%`;
    document.getElementById('hud-raiders').textContent = `${raiders.length}`;
    document.getElementById('hud-shells').textContent = `${run.ammoBudget - run.shots}`;
    const gunEl = document.getElementById('hud-gun');
    if (now < gunDryUntil) {
      gunEl.style.color = GUN_DRY_COLOR;
      gunEl.style.opacity = '1';
    } else {
      gunEl.style.color = '';
      gunEl.style.opacity = now >= nextShot ? '1' : '0.3';
    }
  }

  // ---- 2D HUD drawing (compass, reticle, target brackets, radar) ----
  const P = (a = 1) => `rgba(65,255,122,${a})`;
  const GOLD = (a = 1) => `rgba(245,193,75,${a})`;
  const RED = (a = 1) => `rgba(255,98,71,${a})`;
  const normPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const _proj = new THREE.Vector3();

  function corners(x, y, s) {
    const c = 6;
    hctx.beginPath();
    hctx.moveTo(x - s, y - s + c); hctx.lineTo(x - s, y - s); hctx.lineTo(x - s + c, y - s);
    hctx.moveTo(x + s - c, y - s); hctx.lineTo(x + s, y - s); hctx.lineTo(x + s, y - s + c);
    hctx.moveTo(x + s, y + s - c); hctx.lineTo(x + s, y + s); hctx.lineTo(x + s - c, y + s);
    hctx.moveTo(x - s + c, y + s); hctx.lineTo(x - s, y + s); hctx.lineTo(x - s, y + s - c);
    hctx.stroke();
  }

  function drawHud(now) {
    const W = innerWidth, H = innerHeight, cx = W / 2, cy = H / 2;
    hctx.clearRect(0, 0, W, H);
    hctx.textAlign = 'center';
    const sinH = Math.sin(run.heading), cosH = Math.cos(run.heading);

    // reticle — coloured by gun state (ready / cooldown / dry)
    const col = now < gunDryUntil ? RED(0.9) : now >= nextShot ? P(0.95) : P(0.4);
    hctx.strokeStyle = col; hctx.lineWidth = 1.5;
    hctx.beginPath();
    hctx.moveTo(cx - 21, cy); hctx.lineTo(cx - 7, cy);
    hctx.moveTo(cx + 7, cy); hctx.lineTo(cx + 21, cy);
    hctx.moveTo(cx, cy - 21); hctx.lineTo(cx, cy - 7);
    hctx.moveTo(cx, cy + 7); hctx.lineTo(cx, cy + 21);
    hctx.stroke();
    hctx.beginPath(); hctx.arc(cx, cy, 3, 0, Math.PI * 2); hctx.stroke();

    // player cannon tracers — a 3D bolt heading straight away from the camera
    // shows only its tiny end cross-section, so draw each on the HUD where the
    // shot is always visible: a bright dot streaking toward the target.
    for (const b of playerBolts) {
      _proj.copy(b.pos).project(camera);
      if (_proj.z > 1) continue;
      const bx = (_proj.x * 0.5 + 0.5) * W, by = (-_proj.y * 0.5 + 0.5) * H;
      hctx.fillStyle = P(0.95);
      hctx.beginPath(); hctx.arc(bx, by, 4, 0, Math.PI * 2); hctx.fill();
      hctx.strokeStyle = P(0.35); hctx.lineWidth = 2;
      hctx.beginPath(); hctx.arc(bx, by, 9, 0, Math.PI * 2); hctx.stroke();
    }

    // compass strip — destination bearing relative to heading
    const sw = Math.min(560, W * 0.6), sx = cx - sw / 2, sy = 48;
    hctx.strokeStyle = P(0.22); hctx.lineWidth = 1; hctx.strokeRect(sx, sy - 9, sw, 18);
    hctx.fillStyle = P(0.28);
    for (let i = 0; i <= 8; i++) hctx.fillRect(sx + (i / 8) * sw, sy - 5, 1, 10);
    const RANGE_A = 75 * Math.PI / 180;
    const rel = normPi(Math.atan2(world.target.x - run.pos.x, world.target.z - run.pos.z) - run.heading);
    let mx, edge = 0;
    if (rel < -RANGE_A) { mx = sx; edge = -1; } else if (rel > RANGE_A) { mx = sx + sw; edge = 1; } else mx = cx + (rel / RANGE_A) * (sw / 2);
    hctx.fillStyle = GOLD(0.95);
    hctx.beginPath(); hctx.moveTo(mx, sy + 11); hctx.lineTo(mx - 6, sy + 1); hctx.lineTo(mx + 6, sy + 1); hctx.closePath(); hctx.fill();
    const distU = Math.floor(Math.hypot(world.target.x - run.pos.x, world.target.z - run.pos.z) / WORLD_SCALE);
    hctx.font = '11px Tektur, monospace';
    const lx = Math.max(sx + 42, Math.min(sx + sw - 42, mx));
    hctx.fillText(edge < 0 ? '◄ HANGAR' : edge > 0 ? 'HANGAR ►' : `⌂ HANGAR  ${distU}`, lx, sy - 15);

    // target brackets over raiders that are ahead + on screen
    for (const rd of raiders) {
      const dxr = rd.pos.x - run.pos.x, dzr = rd.pos.z - run.pos.z;
      if (dxr * sinH + dzr * cosH <= 0) continue; // behind — the radar covers it
      _proj.copy(rd.pos).project(camera);
      const px = (_proj.x * 0.5 + 0.5) * W, py = (-_proj.y * 0.5 + 0.5) * H;
      if (px < 0 || px > W || py < 0 || py > H) continue;
      const onAim = Math.hypot(px - cx, py - cy) < 42;
      hctx.strokeStyle = onAim ? GOLD(0.95) : RED(0.7); hctx.lineWidth = onAim ? 2 : 1.2;
      corners(px, py, onAim ? 20 : 15);
      if (onAim) { hctx.fillStyle = GOLD(0.9); hctx.font = '10px Tektur, monospace'; hctx.fillText('LOCK', px, py - (onAim ? 20 : 15) - 5); }
    }

    // radar (top-right): forward = up, blips for raiders + destination
    const R = 68, rx = W - R - 22, ry = R + 22, RG = 420;
    hctx.fillStyle = 'rgba(3,8,5,0.55)'; hctx.strokeStyle = P(0.25); hctx.lineWidth = 1;
    hctx.beginPath(); hctx.arc(rx, ry, R, 0, Math.PI * 2); hctx.fill(); hctx.stroke();
    hctx.strokeStyle = P(0.14);
    hctx.beginPath(); hctx.arc(rx, ry, R * 0.5, 0, Math.PI * 2); hctx.stroke();
    hctx.beginPath(); hctx.moveTo(rx, ry); hctx.lineTo(rx, ry - R); hctx.stroke();
    const blip = (wx, wz) => {
      const dx = wx - run.pos.x, dz = wz - run.pos.z;
      let bx = ((dx * cosH - dz * sinH) / RG) * R, by = -((dx * sinH + dz * cosH) / RG) * R;
      const m = Math.hypot(bx, by), clamped = m > R;
      if (clamped) { bx = bx / m * R; by = by / m * R; }
      return [rx + bx, ry + by, clamped];
    };
    const [tx, ty] = blip(world.target.x, world.target.z);
    hctx.fillStyle = GOLD(0.9); hctx.beginPath(); hctx.arc(tx, ty, 3, 0, Math.PI * 2); hctx.fill();
    for (const rd of raiders) {
      const [bx, by, cl] = blip(rd.pos.x, rd.pos.z);
      hctx.fillStyle = RED(cl ? 0.5 : 0.95); hctx.beginPath(); hctx.arc(bx, by, 2.6, 0, Math.PI * 2); hctx.fill();
    }
    hctx.fillStyle = P(0.9); hctx.beginPath(); hctx.moveTo(rx, ry - 5); hctx.lineTo(rx - 4, ry + 4); hctx.lineTo(rx + 4, ry + 4); hctx.closePath(); hctx.fill();
    hctx.fillStyle = P(0.45); hctx.font = '9px Tektur, monospace'; hctx.fillText('RADAR', rx, ry + R + 12);
  }

  // Raider AI + cannon fire + bolt flight/collision, run once per frame while
  // the run is still live. Mirrors stepRun's own `if (run.done) return` guard
  // instead of nesting this inside frame()'s dispatch.
  function stepCombat(now, dt) {
    const aheadX = run.pos.x + Math.sin(run.heading) * RAIDER_AHEAD;
    const aheadZ = run.pos.z + Math.cos(run.heading) * RAIDER_AHEAD;
    for (const rd of raiders) {
      const pdx = run.pos.x - rd.pos.x, pdy = 4 - rd.pos.y, pdz = run.pos.z - rd.pos.z;
      if (Math.hypot(pdx, pdy, pdz) > RAIDER_ENGAGE_RANGE) continue; // out of range — hold position, don't fire

      if (!rd.engaged) {
        rd.engaged = true;
        rd.fireAt = now + RAIDER_FIRE_INTERVAL * 1000;
      }

      const dx = aheadX - rd.pos.x, dy = 4 - rd.pos.y, dz = aheadZ - rd.pos.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      rd.pos.x += (dx / d) * RAIDER_SPEED * dt;
      rd.pos.y += (dy / d) * RAIDER_SPEED * dt;
      rd.pos.z += (dz / d) * RAIDER_SPEED * dt;
      rd.mesh.position.copy(rd.pos);

      if (now >= rd.fireAt) {
        rd.fireAt = now + RAIDER_FIRE_INTERVAL * 1000;
        const bx = run.pos.x - rd.pos.x, by = 4 - rd.pos.y, bz = run.pos.z - rd.pos.z;
        const blen = Math.hypot(bx, by, bz) || 1;
        const dir = new THREE.Vector3(bx / blen, by / blen, bz / blen);
        raiderBolts.push(makeBolt(rd.pos, dir, RAIDER_BOLT_SPEED));
      }
    }

    if ((keys[' '] || fireRequested) && now >= nextShot) {
      fireRequested = false;
      nextShot = now + cannonCooldown(run.attack) * 1000;
      if (fireShot(run)) {
        const dir = new THREE.Vector3(Math.sin(run.heading), 0, Math.cos(run.heading));
        // Fire from a nose muzzle ahead of and below the camera (eye is at
        // y=4), so the bolt visibly leaves the ship instead of spawning inside
        // the eye and vanishing.
        const muzzle = new THREE.Vector3(run.pos.x + dir.x * 9, 2.6, run.pos.z + dir.z * 9);
        const bolt = makePlayerBolt(muzzle, dir, PLAYER_BOLT_SPEED);
        // firedAtT is run.t (stepRun's accumulated seconds-since-launch), the
        // same time base resolveRun/raiderTimeline use server-side — NOT the
        // rAF `now` timestamp, which is wall-clock and means nothing to the
        // server's replay.
        bolt.firedAtT = run.t;
        playerBolts.push(bolt);
      } else {
        gunDryUntil = now + GUN_DRY_MS; // out of ammo — dry trigger, no bolt
      }
    }

    for (let i = raiderBolts.length - 1; i >= 0; i--) {
      const b = raiderBolts[i];
      b.age += dt;
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      const dx = b.pos.x - run.pos.x, dy = b.pos.y - 4, dz = b.pos.z - run.pos.z;
      const hitPlayer = dx * dx + dy * dy + dz * dz < HIT_RADIUS_PLAYER * HIT_RADIUS_PLAYER;
      if (hitPlayer || b.age > RAIDER_BOLT_MAXAGE) {
        if (hitPlayer && applyRaiderHit(run) === 'hit') flashHud();
        disposeDeep(b.mesh); scene.remove(b.mesh); raiderBolts.splice(i, 1);
      }
    }

    for (let i = playerBolts.length - 1; i >= 0; i--) {
      const b = playerBolts[i];
      b.age += dt;
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      let hitIdx = -1;
      for (let j = 0; j < raiders.length; j++) {
        const rd = raiders[j];
        const dx = b.pos.x - rd.pos.x, dy = b.pos.y - rd.pos.y, dz = b.pos.z - rd.pos.z;
        if (dx * dx + dy * dy + dz * dz < HIT_RADIUS_RAIDER * HIT_RADIUS_RAIDER) { hitIdx = j; break; }
      }
      if (hitIdx >= 0) {
        const rd = raiders[hitIdx];
        // rd.idx (assigned at spawn, stable) — NOT hitIdx, which is the
        // raider's current position in the splice-shrinking `raiders` array.
        fireEvents.push({ t: b.firedAtT, raider: rd.idx });
        rd.hp -= cannonDamage(run.attack);
        if (rd.hp <= 0) {
          registerKill(run);
          disposeDeep(rd.mesh); scene.remove(rd.mesh);
          raiders.splice(hitIdx, 1);
        }
        disposeDeep(b.mesh); scene.remove(b.mesh); playerBolts.splice(i, 1);
      } else if (b.age > PLAYER_BOLT_MAXAGE) {
        fireEvents.push({ t: b.firedAtT, raider: null });
        disposeDeep(b.mesh); scene.remove(b.mesh); playerBolts.splice(i, 1);
      }
    }
  }

  async function finish() {
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKey);
    removeEventListener('resize', onResize);
    clearTimeout(hudHitTimer);
    overlay.classList.remove('hud-hit');
    // Any bolt still in flight when the run ends never got to resolve a
    // hit/miss above — it must still be accounted for (fireEvents.length
    // must equal run.shots) so it's logged as a miss right here.
    for (const b of playerBolts) fireEvents.push({ t: b.firedAtT, raider: null });
    // Bolts resolve (hit/miss) in flight-time order, not fire order — a close
    // shot can land before an earlier long shot ages out — so the array is
    // built out of order. resolveRun requires non-decreasing t; sort by fire
    // time before posting (stable per shell; t is the fire instant, not the hit).
    fireEvents.sort((a, b) => a.t - b.t);

    let card;
    try {
      if (run.outcome === 'landed' || run.outcome === 'void') {
        // Both outcomes are resolved server-side by resolveRun(fireEvents) —
        // the server may not agree with the client's own local sim (that sim
        // is cosmetic only now), so branch on the server's payout.outcome,
        // not the client's run.outcome, for what card to show.
        const payout = await completeMission(mission.id, fireEvents);
        if (payout.outcome === 'landed') {
          const shares = payout.crewShares.map((s) => `${escapeHtml(s.owner).toUpperCase()} +${escapeHtml(s.gold)}G`).join(' · ') || 'NO CREW SHARES';
          card = `<p class="gold">CARGO DELIVERED</p>
            <p>+${escapeHtml(payout.rewardGold)} GOLD · FUEL BURNED ${escapeHtml(payout.fuelBurned)}</p>
            <p>${shares}</p>${payout.stageCompleted ? `<p class="gold">STAGE COMPLETE — THE CITY GROWS</p>${payout.airdrop && payout.airdrop.total ? `<p class="gold">AIRDROP: ${escapeHtml(payout.airdrop.total)} GOLD SPLIT AMONG ${escapeHtml(payout.airdrop.recipients)} BUILDER(S)</p>` : ''}` : ''}`;
        } else {
          card = `<p class="bad">HULL BREACH — LOST TO THE VOID</p>
            <p>ENTRY FEE FORFEITED (${escapeHtml(mission.feeGold)} G) · FUEL BURNED ${escapeHtml(payout.fuelBurned)}</p>`;
        }
      } else {
        await failMission(mission.id, Math.ceil(run.fuel), run.shots);
        const failText = run.outcome === 'dry'
          ? 'TANKS DRY — SHIP LOST TO THE VOID'
          : 'RUN ABANDONED — THE VOID KEEPS THE FEE';
        card = `<p class="bad">${failText}</p>
          <p>ENTRY FEE FORFEITED (${escapeHtml(mission.feeGold)} G)</p>`;
      }
    } catch (e) {
      card = `<p class="bad">${escapeHtml(e.message).toUpperCase()}</p>`;
    }
    const div = document.createElement('div');
    div.className = 'debrief';
    div.innerHTML = `${card}<button id="debrief-close">RETURN TO BRIDGE</button>`;
    overlay.appendChild(div);
    document.getElementById('debrief-close').addEventListener('click', () => {
      disposeDeep(scene); // catches surviving raiders/bolts too — they're scene children
      renderer.domElement.remove();
      overlay.hidden = true;
      overlay.innerHTML = '';
      flying = false;
      window.dispatchEvent(new Event('sh:done'));
    });
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Boat-like helm: the key gives a target lean; yaw eases toward it and
    // coasts back, so the ship swings smoothly instead of snapping.
    const yawTarget = (keys['a'] || keys['arrowleft'] ? 1 : 0) + (keys['d'] || keys['arrowright'] ? -1 : 0);
    yawVel += (yawTarget - yawVel) * Math.min(1, dt * TURN_EASE);
    const yaw = yawVel;
    if (keys['w'] || keys['arrowup']) throttle = Math.min(1, throttle + dt);
    if (keys['s'] || keys['arrowdown']) throttle = Math.max(0.1, throttle - dt);
    stepRun(run, dt, { yaw, throttle }, world);
    if (!run.done) stepCombat(now, dt);
    camera.position.set(run.pos.x, 4, run.pos.z);
    // face +z travel direction, banking gently into the turn for weight
    camera.rotation.set(0, Math.PI + run.heading, yawVel * 0.16);
    hud(now);
    renderer.render(scene, camera);
    if (!run.done) { drawHud(now); requestAnimationFrame(frame); }
    else finish();
  }
  requestAnimationFrame(frame);
}

// Bridge hands us the accepted mission; fuel budget = live FUEL balance.
window.addEventListener('sh:launch', async (ev) => {
  if (flying) return;
  flying = true;
  try {
    const bal = await balances();
    launch(ev.detail, bal.FUEL, bal.AMMO ?? 0);
  } catch (e) {
    flying = false;
    overlay.hidden = true;
    const account = document.getElementById('account');
    if (account) account.textContent = `LAUNCH SCRUBBED: ${String(e.message || e).toUpperCase()}`;
    try { await failMission(ev.detail.mission.id); } catch { /* server keeps it recoverable */ }
    window.dispatchEvent(new Event('sh:scrubbed'));
  }
});
