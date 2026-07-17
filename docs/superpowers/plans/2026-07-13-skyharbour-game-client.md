# Skyharbour Game Client Implementation Plan (plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the bridge console into a live dapp against the plan-1 economy API and add the piloted Battlezone flight — accept a mission, fly it first-person over the void, land, get paid.

**Architecture:** The Fastify server serves the repo's static console at `/app/` (same origin, no CORS; auth hook bypasses static). Client is plain ES modules, no bundler: `client/api.js` (fetch + dev-wallet store), `client/render.js` (pure HTML renderers), `client/bridge.js` (DOM glue), `client/flightMath.js` (pure world-gen/fuel/telemetry — fully unit-tested), `client/flight.js` (three.js scene in a fullscreen overlay). Telemetry from a flown run must satisfy the server's `validateRun` bounds by construction.

**Tech Stack:** TypeScript server (existing), vanilla ES-module JS client, three.js (vendored file, no CDN), Vitest (pure client modules tested from `server/test/client/`).

## Global Constraints

- Dev auth until plan 2: wallet name via `x-wallet` header; client stores it in `localStorage['sh-wallet']`. No Solana/web3 code in this plan.
- Self-contained: no CDN scripts/fonts at runtime (three.js is vendored at `client/vendor/three.module.min.js`; the Google-Fonts link in index.html is pre-existing and out of scope).
- Server validation invariants (from `server/src/validation.ts`, do not change them): `durationS >= distance / ship.engine`; `fuelSpent >= ceil(distance * (1 - min(totalFuelSkill,50)/100))`; `cargoDelivered <= min(ship.cargo, mission.amount)`.
- Flight model constants: cruise speed = `ship.engine` units/s at full throttle; fuel drain per second = `throttle * ship.engine * (1 - fuelSkill/100)` where `fuelSkill = min(sum(crew fuel skills), 50)` — so a straight full-throttle run burns ≈ `distance * (1 - skill/100)` ≥ server minimum (ceil rounds up on submit).
- v1 cut lines: no pitch (fixed altitude band), no shooting/raiders (crew ATTACK dormant), hazards are floating rocks — collision costs hull, 3 hits = destroyed; DEFENSE skill: each point of defense reduces hull damage odds proportionally (`damageChance = 1 - defense/100`).
- Phosphor identity: reuse the CSS tokens already in `styles.css` (`--phosphor`, `--void`, `--gold`); flight HUD inherits them.
- All 68 existing server tests must stay green; run `npm test` and `npm run typecheck` from `server/` before every commit.
- Commit after every green cycle.

---

### Task 1: Server serves the console at /app/

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/package.json` (add dependency `@fastify/static` ^7.0.0)
- Test: `server/test/static.test.ts`

**Interfaces:**
- Consumes: existing `buildApp(opts)`.
- Produces: `buildApp` gains opt `staticRoot?: string` (absolute path; when set, files are served under `/app/`). `GET /` (no auth) redirects 302 → `/app/`. Requests with url starting `/app` or `== '/'` bypass the `x-wallet` auth hook. API behavior unchanged.

- [ ] **Step 1: Install dependency**

Run: `cd ~/skyharbour/server && npm install @fastify/static@^7`

- [ ] **Step 2: Write the failing test**

`server/test/static.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp({ staticRoot: repoRoot });
});

describe('static console', () => {
  it('serves index.html at /app/ without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SKY HARBOUR');
  });

  it('redirects / to /app/ without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/app/');
  });

  it('still guards the API with the wallet header', async () => {
    const res = await app.inject({ method: 'GET', url: '/balances' });
    expect(res.statusCode).toBe(401);
  });

  it('API works unchanged next to static', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: { 'x-wallet': 'alice' } });
    expect(res.statusCode).toBe(200);
  });

  it('without staticRoot the app behaves as before', async () => {
    const bare = buildApp();
    const res = await bare.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(401); // auth hook still owns unknown routes
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npx vitest run test/static.test.ts`
Expected: FAIL — `staticRoot` unknown / 401 on `/app/`.

- [ ] **Step 4: Implement**

In `server/src/app.ts`:

1. Add imports at top:
```ts
import fastifyStatic from '@fastify/static';
```
2. Change the signature:
```ts
export function buildApp(opts: { dbPath?: string; staticRoot?: string } = {}) {
```
3. In the auth hook, add the bypass as the FIRST lines of the handler:
```ts
  app.addHook('onRequest', async (req, reply) => {
    if (opts.staticRoot && (req.url === '/' || req.url.startsWith('/app'))) return;
    const wallet = req.headers['x-wallet'];
    if (typeof wallet !== 'string' || wallet.length === 0) {
      return reply.code(401).send({ error: 'missing x-wallet header (dev auth)' });
    }
    (req as unknown as { wallet: string }).wallet = wallet;
  });
```
4. After the error handler setup, register static + redirect (only when configured):
```ts
  if (opts.staticRoot) {
    app.register(fastifyStatic, { root: opts.staticRoot, prefix: '/app/' });
    app.get('/', async (_req, reply) => reply.redirect('/app/'));
  }
```
5. In `server/src/index.ts`, pass the repo root so the dev server serves the console:
```ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildApp } from './app.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = buildApp({ dbPath: process.env.SKYHARBOUR_DB ?? 'skyharbour.db', staticRoot: repoRoot });
const port = Number(process.env.PORT ?? 8420);

app.listen({ port, host: '0.0.0.0' })
  .then(() => { console.log(`skyharbour bridge on http://localhost:${port}/app/`); })
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 5: Run full suite + typecheck, then commit**

Run: `cd ~/skyharbour/server && npm test && npm run typecheck`
Expected: 73 tests pass (68 + 5 new).

```bash
cd ~/skyharbour && git add server/package.json server/package-lock.json server/src/app.ts server/src/index.ts server/test/static.test.ts && git commit -m "feat(server): serve the bridge console at /app/ (auth-bypassed static)"
```

---

### Task 2: Client API module with dev-wallet store

**Files:**
- Create: `client/api.js`
- Test: `server/test/client/api.test.ts`

**Interfaces:**
- Consumes: the plan-1 HTTP API.
- Produces (ES module `client/api.js`):
  - `getWallet(): string | null` / `setWallet(name: string)` / `clearWallet()` — backed by `localStorage['sh-wallet']`.
  - `api(path, { method?, body? }?): Promise<any>` — fetch against same origin, sends `x-wallet`, JSON in/out; on non-2xx throws `Error` with the server's `{error}` message.
  - `login()`, `balances()`, `missions()`, `generateMissions(count)`, `acceptMission(id, shipId, crewIds)`, `completeMission(id, telemetry)`, `failMission(id)`, `settlement()`, `crewMarket()` — thin typed wrappers returning parsed JSON.

- [ ] **Step 1: Write the failing test**

`server/test/client/api.test.ts` (pure logic — localStorage and fetch stubbed):
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { getWallet, setWallet, clearWallet, api, acceptMission } = await import('../../../client/api.js');

beforeEach(() => { store.clear(); });

describe('wallet store', () => {
  it('round-trips the dev wallet', () => {
    expect(getWallet()).toBeNull();
    setWallet('alice');
    expect(getWallet()).toBe('alice');
    clearWallet();
    expect(getWallet()).toBeNull();
  });
});

describe('api()', () => {
  it('sends the x-wallet header and parses JSON', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/balances');
      expect(init.headers['x-wallet']).toBe('alice');
      return { ok: true, json: async () => ({ GOLD: 5 }) };
    });
    expect(await api('/balances')).toEqual({ GOLD: 5 });
  });

  it('throws the server error message on non-2xx', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'mission x is not open' }) }));
    await expect(api('/missions/x/accept', { method: 'POST', body: {} })).rejects.toThrow(/not open/);
  });

  it('acceptMission posts shipId and crewIds', async () => {
    setWallet('alice');
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/missions/m1/accept');
      expect(JSON.parse(init.body)).toEqual({ shipId: 'ship-1', crewIds: ['crew-1'] });
      return { ok: true, json: async () => ({ status: 'active' }) };
    });
    expect((await acceptMission('m1', 'ship-1', ['crew-1'])).status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npx vitest run test/client/api.test.ts`
Expected: FAIL — cannot find module `client/api.js`.

- [ ] **Step 3: Implement**

`client/api.js`:
```js
// Dev auth until the chain gateway (plan 2): the "wallet" is a name in
// localStorage, sent as the x-wallet header the server expects.
const KEY = 'sh-wallet';

export function getWallet() { return localStorage.getItem(KEY); }
export function setWallet(name) { localStorage.setItem(KEY, name); }
export function clearWallet() { localStorage.removeItem(KEY); }

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-wallet': getWallet() ?? '',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed: ${path}`);
  return data;
}

export const login = () => api('/login', { method: 'POST' });
export const balances = () => api('/balances');
export const missions = () => api('/missions');
export const generateMissions = (count) => api('/missions/generate', { method: 'POST', body: { count } });
export const acceptMission = (id, shipId, crewIds) => api(`/missions/${id}/accept`, { method: 'POST', body: { shipId, crewIds } });
export const completeMission = (id, telemetry) => api(`/missions/${id}/complete`, { method: 'POST', body: { telemetry } });
export const failMission = (id) => api(`/missions/${id}/fail`, { method: 'POST' });
export const settlement = () => api('/settlement');
export const crewMarket = () => api('/crew/market');
```

- [ ] **Step 4: Run test to verify it passes, then full suite**

Run: `cd ~/skyharbour/server && npx vitest run test/client/api.test.ts && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add client/api.js server/test/client/api.test.ts && git commit -m "feat(client): API module with dev-wallet store"
```

---

### Task 3: Pure renderers for live console channels

**Files:**
- Create: `client/render.js`
- Test: `server/test/client/render.test.ts`

**Interfaces:**
- Consumes: JSON shapes returned by the API (`balances`, `settlement`, `missions`, `crew/market`, `login`).
- Produces (each returns an HTML string; no DOM access — callers assign to `innerHTML`):
  - `renderTicker(balances)` → `'FUEL 152 · GOLD 104 · LOG 0 · …'` (only nonzero cargo tokens; GOLD and FUEL always shown).
  - `renderManifest(balances)` → the claim-manifest inner lines (GOLD/FUEL + nonzero cargo).
  - `renderHangar(ships)` → ship cards markup (name, ENGINE/CARGO/CREW, a `data-ship` attribute).
  - `renderBoard(missions)` → mission table rows with an ACCEPT button per open mission (`data-mission` attribute); empty state `'NO CONTRACTS — THE SETTLEMENT WANTS FOR NOTHING'`.
  - `renderSettlement(state)` → meter (percent from received vs stage needs) + stage line; when `state.stage` is null → `'THE CITY STANDS COMPLETE'`.
  - `renderCrewMarket(listings, ownCrew)` → checkbox list (`data-crew` attribute, share % label; own crew labeled `SHARE 0% (YOURS)`).
  - `escapeHtml(s)` — used by every renderer on data strings.

- [ ] **Step 1: Write the failing test**

`server/test/client/render.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  renderTicker, renderManifest, renderHangar, renderBoard,
  renderSettlement, renderCrewMarket, escapeHtml,
} from '../../../client/render.js';

const bal = { GOLD: 104, FUEL: 152, LOG: 0, MINERAL: 3, FURNITURE: 0, FIRERUNE: 0 };

describe('renderTicker', () => {
  it('always shows money and fuel, hides zero cargo', () => {
    const t = renderTicker(bal);
    expect(t).toContain('GOLD 104');
    expect(t).toContain('FUEL 152');
    expect(t).toContain('MINERAL 3');
    expect(t).not.toContain('FURNITURE');
  });
});

describe('renderBoard', () => {
  it('renders an ACCEPT button per open mission', () => {
    const html = renderBoard([{ id: 'm1', cargo: 'LOG', amount: 5, origin: 'RUNEFALL', distance: 148, rewardGold: 5, feeGold: 1, status: 'open' }]);
    expect(html).toContain('data-mission="m1"');
    expect(html).toContain('LOG');
    expect(html).toContain('148');
  });
  it('has an empty state', () => {
    expect(renderBoard([])).toContain('NO CONTRACTS');
  });
  it('escapes data strings', () => {
    const html = renderBoard([{ id: 'x', cargo: 'LOG', amount: 1, origin: '<img>', distance: 1, rewardGold: 1, feeGold: 1, status: 'open' }]);
    expect(html).not.toContain('<img>');
  });
});

describe('renderSettlement', () => {
  it('computes the meter percent from received vs needs', () => {
    const html = renderSettlement({
      stage: { index: 0, name: 'Landing Dock', needs: { LOG: 100 } },
      received: { LOG: 5 }, remainingNeeds: { LOG: 95 }, completedStages: 0,
    });
    expect(html).toContain('5%');
    expect(html).toContain('LANDING DOCK');
  });
  it('handles the finished city', () => {
    expect(renderSettlement({ stage: null, received: {}, remainingNeeds: {}, completedStages: 4 }))
      .toContain('COMPLETE');
  });
});

describe('renderCrewMarket', () => {
  it('lists hireable crew with shares and marks own crew free', () => {
    const html = renderCrewMarket(
      [{ crewId: 'crew-1', owner: 'bob', sharePct: 15 }],
      [{ id: 'crew-9', owner: 'alice', skills: { fuel: 10 } }],
    );
    expect(html).toContain('data-crew="crew-1"');
    expect(html).toContain('15%');
    expect(html).toContain('YOURS');
  });
});

describe('renderHangar/renderManifest/escapeHtml', () => {
  it('hangar carries data-ship', () => {
    expect(renderHangar([{ id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2 }]))
      .toContain('data-ship="ship-1"');
  });
  it('manifest shows balances', () => {
    expect(renderManifest(bal)).toContain('104');
  });
  it('escapeHtml neutralizes angle brackets and quotes', () => {
    expect(escapeHtml('<a b="c">&')).toBe('&lt;a b=&quot;c&quot;&gt;&amp;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npx vitest run test/client/render.test.ts`
Expected: FAIL — cannot find module `client/render.js`.

- [ ] **Step 3: Implement**

`client/render.js`:
```js
// Pure HTML-string renderers for the console channels. No DOM access here —
// bridge.js owns the document. Every data string passes through escapeHtml.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const CARGO = ['LOG', 'MINERAL', 'FURNITURE', 'FIRERUNE'];

export function renderTicker(bal) {
  const parts = [`FUEL ${bal.FUEL ?? 0}`, `GOLD ${bal.GOLD ?? 0}`];
  for (const t of CARGO) if (bal[t]) parts.push(`${t} ${bal[t]}`);
  return parts.join(' · ');
}

export function renderManifest(bal) {
  const rows = [['GOLD', bal.GOLD ?? 0], ['FUEL', bal.FUEL ?? 0]];
  for (const t of CARGO) if (bal[t]) rows.push([t, bal[t]]);
  return rows.map(([t, v]) =>
    `<p class="manifest-line">${t} <span class="dots"></span> <b>${v}</b></p>`).join('');
}

export function renderHangar(ships) {
  if (!ships.length) return '<p class="card-description">NO SHIP NFT ON THIS WALLET — THE HARBOUR HAS NOTHING TO GRANT.</p>';
  return ships.map((s) => `
    <div class="frame-part" data-ship="${escapeHtml(s.id)}">
      <div class="card-details">
        <p class="card-name">${escapeHtml(s.id).toUpperCase()}</p>
        <p class="card-description">ENGINE ${s.engine} · CARGO ${s.cargo} · CREW ${s.crewSlots}</p>
      </div>
    </div>`).join('');
}

export function renderBoard(missions) {
  const open = missions.filter((m) => m.status === 'open');
  if (!open.length) {
    return '<p class="card-description">NO CONTRACTS — THE SETTLEMENT WANTS FOR NOTHING. GENERATE A POSTING.</p>';
  }
  const rows = open.map((m) => `
    <tr${m.cargo === 'FIRERUNE' ? ' class="rare"' : ''}>
      <td>${escapeHtml(m.cargo)} ×${m.amount}</td>
      <td>${escapeHtml(m.origin).toUpperCase()}</td>
      <td class="n">${m.distance}</td>
      <td class="n gold">${m.rewardGold} G</td>
      <td class="n">${m.feeGold} G</td>
      <td><button class="accept-btn" data-mission="${escapeHtml(m.id)}">ACCEPT</button></td>
    </tr>`).join('');
  return `<table class="board-table">
    <thead><tr><th>CARGO</th><th>FROM</th><th>DIST</th><th>REWARD</th><th>FEE</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderSettlement(state) {
  if (!state.stage) return '<p class="card-name">THE CITY STANDS COMPLETE</p>';
  const needs = state.stage.needs;
  let need = 0, got = 0;
  for (const [t, n] of Object.entries(needs)) { need += n; got += Math.min(state.received[t] ?? 0, n); }
  const pct = need ? Math.floor((got / need) * 100) : 0;
  const needLabel = Object.entries(needs).map(([t, n]) => `${state.received[t] ?? 0}/${n} ${t}`).join(' · ');
  return `
    <p class="card-name">SETTLEMENT — STAGE ${state.stage.index}</p>
    <div class="meter"><div class="meter-fill" style="width:${pct}%"></div>
      <span class="meter-label">${escapeHtml(state.stage.name).toUpperCase()} — ${needLabel} (${pct}%)</span></div>`;
}

export function renderCrewMarket(listings, ownCrew) {
  const rows = [
    ...ownCrew.map((c) => `
      <label class="crew-pick"><input type="checkbox" data-crew="${escapeHtml(c.id)}">
        ${escapeHtml(c.id).toUpperCase()} — SHARE 0% (YOURS)</label>`),
    ...listings.map((l) => `
      <label class="crew-pick"><input type="checkbox" data-crew="${escapeHtml(l.crewId)}">
        ${escapeHtml(l.crewId).toUpperCase()} — SHARE ${l.sharePct}% (OWNER ${escapeHtml(l.owner).toUpperCase()})</label>`),
  ];
  return rows.length ? rows.join('') : '<p class="card-description">NO HANDS FOR HIRE AT THE HARBOUR.</p>';
}
```

- [ ] **Step 4: Run test to verify it passes, then full suite**

Run: `cd ~/skyharbour/server && npx vitest run test/client/render.test.ts && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add client/render.js server/test/client/render.test.ts && git commit -m "feat(client): pure channel renderers"
```

---

### Task 4: Bridge glue — live console

**Files:**
- Modify: `index.html`
- Create: `client/bridge.js`
- Modify: `styles.css` (append flight/board control styles)
- Test: headless screenshot smoke (no unit tests — glue only; logic lives in tasks 2-3)

**Interfaces:**
- Consumes: `client/api.js`, `client/render.js`, existing DOM ids (`account`, `sign-in-button`, `sign-out-button`, `ticker`, `mint`, and the frames).
- Produces: DOM ids the flight task hooks into: `#missions-live` (board container), `#hangar-live`, `#crew-live`, `#settlement-live`, and a global custom event: accepting a mission dispatches `window` event `'sh:launch'` with `detail = { mission, ship, crew }` (crew = `{ id, skills }[]` of the hired crew). Exports `refreshEconomy()` (re-pulls balances + settlement into ticker/manifest/channel).

- [ ] **Step 1: Wire the HTML**

In `index.html`:
1. Replace the static content of the four live channels with mount points, keeping each frame's outer div and id:
   - In `#hangar-frame`: replace the three `frame-part` divs with `<div class="frame-part board" id="hangar-live"><div class="card-details"><p class="card-name">HANGAR</p><div class="live-mount" id="hangar-mount"></div></div></div>`
   - In `#missions-frame`, inside `card-details`, replace the `<table>…</table>` and the small print with `<div class="live-mount" id="missions-mount"></div><button id="generate-btn" class="console-btn">REQUEST NEW POSTINGS</button>`
   - In `#settlement-frame`, replace meter + stage list with `<div class="live-mount" id="settlement-mount"></div>` (keep the small-print paragraph).
   - In `#crew-frame`, keep the crew image `frame-part`; add after it: `<div class="frame-part board"><div class="card-details"><p class="card-name">HIRE FOR NEXT RUN</p><div class="live-mount" id="crew-mount"></div></div></div>`
2. Replace the manifest's three hardcoded `manifest-line` paragraphs with `<div id="manifest-mount"></div>` (keep title, button, stamp).
3. Before `</body>`, after the script.js tag, add: `<script type="module" src="./client/bridge.js"></script>`
4. Add the flight overlay mount just after `<body>`: `<div id="flight-overlay" hidden></div>`

- [ ] **Step 2: Implement bridge.js**

`client/bridge.js`:
```js
import { getWallet, setWallet, clearWallet, login, balances, missions, generateMissions, acceptMission, settlement, crewMarket } from './api.js';
import { renderTicker, renderManifest, renderHangar, renderBoard, renderSettlement, renderCrewMarket } from './render.js';

const $ = (id) => document.getElementById(id);
let session = null; // { wallet, ships, crew, granted }

function say(text) { $('account').textContent = text; }

export async function refreshEconomy() {
  if (!getWallet()) return;
  const [bal, st] = await Promise.all([balances(), settlement()]);
  $('ticker').textContent = renderTicker(bal);
  $('manifest-mount').innerHTML = renderManifest(bal);
  $('settlement-mount').innerHTML = renderSettlement(st);
}

async function refreshBoard() {
  if (!getWallet()) return;
  $('missions-mount').innerHTML = renderBoard(await missions());
}

async function refreshCrew() {
  if (!session) return;
  $('crew-mount').innerHTML = renderCrewMarket(await crewMarket(), session.crew);
}

async function doLogin() {
  const name = getWallet() ?? prompt('Pilot name (dev wallet — Phantom arrives with the chain gateway):', 'alice');
  if (!name) return;
  setWallet(name.trim());
  try {
    session = await login();
    say(`DOCKED: ${session.wallet.toUpperCase()}${session.granted ? ' — STARTER GRANT ISSUED' : ''}`);
    $('hangar-mount').innerHTML = renderHangar(session.ships);
    await Promise.all([refreshEconomy(), refreshBoard(), refreshCrew()]);
  } catch (e) {
    say(`DOCKING REFUSED: ${e.message.toUpperCase()}`);
    clearWallet();
  }
}

$('sign-in-button').addEventListener('click', doLogin);
$('sign-out-button').addEventListener('click', () => {
  clearWallet(); session = null;
  say('SKY HARBOUR BRIDGE — DOCK IN, PILOT');
});

$('generate-btn')?.addEventListener('click', async () => {
  try { await generateMissions(3); await refreshBoard(); }
  catch (e) { say(e.message.toUpperCase()); }
});

// Accept → gather ship + hired crew → hand off to the flight overlay.
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest?.('.accept-btn');
  if (!btn || !session) return;
  const ship = session.ships[0];
  if (!ship) { say('NO SHIP NFT — NOTHING TO FLY'); return; }
  const crewIds = [...document.querySelectorAll('#crew-mount input:checked')]
    .map((el) => el.dataset.crew).slice(0, ship.crewSlots);
  try {
    const mission = await acceptMission(btn.dataset.mission, ship.id, crewIds);
    const crew = (mission.crewTerms ?? []).map((t) => ({ id: t.crewId, skills: {} }));
    // skills for own + hired crew come from the session when known
    for (const c of crew) {
      const own = session.crew.find((k) => k.id === c.id);
      if (own) c.skills = own.skills;
    }
    await refreshEconomy();
    window.dispatchEvent(new CustomEvent('sh:launch', { detail: { mission, ship, crew } }));
  } catch (e) { say(e.message.toUpperCase()); }
});

// Auto-dock if a dev wallet is already stored.
if (getWallet()) doLogin();
```

- [ ] **Step 3: Append control styles**

Append to `styles.css`:
```css
/* ---------- live console controls ---------- */
.console-btn,
.accept-btn {
    font-family: var(--font);
    color: var(--phosphor);
    background: transparent;
    border: 1px solid var(--phosphor-dim);
    padding: 4px 10px;
    font-size: 0.85em;
    letter-spacing: 0.14em;
    cursor: pointer;
}

.console-btn:hover,
.accept-btn:hover {
    background: var(--phosphor);
    color: var(--void);
}

.console-btn {
    margin-top: 10px;
}

.live-mount {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
}

.crew-pick {
    display: block;
    font-size: 0.72em;
    letter-spacing: 0.1em;
    color: var(--phosphor-mid);
    padding: 4px 0;
    cursor: pointer;
}

.crew-pick input {
    accent-color: #41ff7a;
    margin-right: 8px;
}
```

- [ ] **Step 4: Smoke over HTTP**

Run:
```bash
cd ~/skyharbour/server && (SKYHARBOUR_DB=':memory:' PORT=8422 npx tsx src/index.ts &) && sleep 3 \
  && curl -s localhost:8422/app/ | grep -c 'bridge.js' \
  && curl -s localhost:8422/app/client/api.js | head -1; pkill -f 'tsx src/index.ts'
```
Expected: `1` and the first line of api.js.

Also run the server test suite: `cd ~/skyharbour/server && npm test && npm run typecheck` — all green.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add index.html styles.css client/bridge.js && git commit -m "feat(client): live console — login, balances, board, crew, settlement"
```

---

### Task 5: flightMath — pure world/fuel/telemetry model

**Files:**
- Create: `client/flightMath.js`
- Test: `server/test/client/flightMath.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `hashSeed(str): number` — deterministic 32-bit seed from a mission id.
  - `mkWorld(seedStr, distance)` → `{ rocks: {x,y,z,r}[], islands: {x,y,z,r}[], target: {x:0,y:0,z:distance} }`. Deterministic for a seed. Rocks sit inside the corridor `|x| < 120`, `z ∈ (40, distance-40)`; roughly one rock per 12 distance units; island count `max(3, floor(distance/30))` outside the corridor.
  - `fuelSkill(crew)` → `min(Σ skills.fuel, 50)`; `defenseSkill(crew)` → `min(Σ skills.defense, 90)`.
  - `mkRun(ship, crew, distance)` → run state `{ pos:{x:0,z:0}, heading:0, throttle:1, fuel:0, hull:3, t:0, distance, done:false, outcome:null }`.
  - `stepRun(run, dt, input, world)` — advances the run: `input = { yaw: -1|0|1, throttle: 0..1 }`. Speed = `throttle * engine`; position integrates heading; `run.fuel += throttle * engine * (1 - fuelSkill/100) * dt`; `run.t += dt`. Rock collision (distance < rock.r + 6, once per rock): `run.hull -= 1` unless `rand() < defense/100` (injectable rng). Sets `done/outcome`: `'landed'` when within 25 units of target; `'void'` when hull ≤ 0; `'dry'` when fuel budget exhausted (`run.fuel >= fuelCapacity` passed at mkRun as ship-independent budget = caller passes pilot FUEL balance).
  - `telemetry(run, mission, ship)` → `{ durationS, fuelSpent, cargoDelivered }` with `durationS = run.t`, `fuelSpent = ceil(run.fuel)`, `cargoDelivered = min(ship.cargo, mission.amount)` — guaranteed to satisfy the server bounds for a landed run (assert in tests).

- [ ] **Step 1: Write the failing test**

`server/test/client/flightMath.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { hashSeed, mkWorld, fuelSkill, defenseSkill, mkRun, stepRun, telemetry } from '../../../client/flightMath.js';
import { minFuel, validateRun } from '../../src/validation.js';
import type { Ship } from '../../src/fleet.js';

const ship: Ship = { id: 's', owner: 'a', engine: 10, cargo: 20, crewSlots: 2 };
const fuelCrew = [{ id: 'c', skills: { fuel: 20 } }];

describe('world generation', () => {
  it('is deterministic per seed', () => {
    expect(mkWorld('m-1', 100)).toEqual(mkWorld('m-1', 100));
    expect(hashSeed('m-1')).not.toBe(hashSeed('m-2'));
  });
  it('keeps rocks inside the corridor and off the pads', () => {
    const w = mkWorld('m-1', 120);
    for (const r of w.rocks) {
      expect(Math.abs(r.x)).toBeLessThan(120);
      expect(r.z).toBeGreaterThan(40);
      expect(r.z).toBeLessThan(80); // 120-40
    }
    expect(w.target.z).toBe(120);
  });
});

describe('skills', () => {
  it('caps fuel skill at 50 and defense at 90', () => {
    expect(fuelSkill([{ id: 'a', skills: { fuel: 40 } }, { id: 'b', skills: { fuel: 40 } }])).toBe(50);
    expect(defenseSkill([{ id: 'a', skills: { defense: 95 } }])).toBe(90);
    expect(fuelSkill([])).toBe(0);
  });
});

describe('a straight full-throttle run', () => {
  function flyStraight(crew: { id: string; skills: Record<string, number> }[]) {
    const distance = 100;
    const world = mkWorld('no-rocks', distance);
    world.rocks = []; // clear hazards: this test is about the fuel/duration envelope
    const run = mkRun(ship, crew, distance, 1000);
    while (!run.done) stepRun(run, 0.1, { yaw: 0, throttle: 1 }, world);
    return { run, distance };
  }

  it('lands and its telemetry passes the server validator', () => {
    const { run } = flyStraight(fuelCrew);
    expect(run.outcome).toBe('landed');
    const t = telemetry(run, { amount: 5, distance: 100 }, ship);
    const verdict = validateRun({ distance: 100, missionAmount: 5 }, ship, [{ id: 'c', owner: 'x', skills: { fuel: 20 } }], t);
    expect(verdict).toEqual({ ok: true });
  });

  it('burns at least the server minimum fuel', () => {
    const { run } = flyStraight(fuelCrew);
    expect(Math.ceil(run.fuel)).toBeGreaterThanOrEqual(minFuel(100, [{ id: 'c', owner: 'x', skills: { fuel: 20 } }]));
  });

  it('cannot be faster than ENGINE allows', () => {
    const { run } = flyStraight([]);
    expect(run.t).toBeGreaterThanOrEqual(100 / ship.engine);
  });
});

describe('failure outcomes', () => {
  it('runs dry when the fuel budget is exhausted', () => {
    const world = mkWorld('x', 500); world.rocks = [];
    const run = mkRun(ship, [], 500, 50); // only 50 FUEL for a 500 crossing
    while (!run.done) stepRun(run, 0.1, { yaw: 0, throttle: 1 }, world);
    expect(run.outcome).toBe('dry');
  });

  it('a rock strike with zero defense costs hull', () => {
    const world = { rocks: [{ x: 0, y: 0, z: 10, r: 8 }], islands: [], target: { x: 0, y: 0, z: 100 } };
    const run = mkRun(ship, [], 100, 1000);
    let struck = false;
    while (!run.done && run.t < 5) {
      stepRun(run, 0.05, { yaw: 0, throttle: 1 }, world, () => 1); // rng=1 → never dodged
      if (run.hull < 3) { struck = true; break; }
    }
    expect(struck).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npx vitest run test/client/flightMath.test.ts`
Expected: FAIL — cannot find module `client/flightMath.js`.

- [ ] **Step 3: Implement**

`client/flightMath.js`:
```js
// Pure flight model. No three.js, no DOM — flight.js renders this, the
// server's validateRun() judges its telemetry. The fuel/speed constants
// are locked to the server's physics floor:
//   speed = throttle * engine (units/s)
//   fuel/s = throttle * engine * (1 - fuelSkill/100)
// so a straight full-throttle run burns ≈ distance * (1 - skill) — the
// exact server minimum; any dodging or throttle-dithering burns more.

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 16807) >>> 0) % 2147483647; return s / 2147483647; };
}

export function mkWorld(seedStr, distance) {
  const r = rng(hashSeed(seedStr));
  const rocks = [];
  const nRocks = Math.floor(distance / 12);
  for (let i = 0; i < nRocks; i++) {
    rocks.push({
      x: (r() - 0.5) * 220,               // corridor |x| < 120 incl. radius
      y: (r() - 0.5) * 30,
      z: 40 + r() * (distance - 80),
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
      z: r() * distance,
      r: 30 + r() * 70,
    });
  }
  return { rocks, islands, target: { x: 0, y: 0, z: distance } };
}

export const fuelSkill = (crew) => Math.min(crew.reduce((s, c) => s + (c.skills?.fuel ?? 0), 0), 50);
export const defenseSkill = (crew) => Math.min(crew.reduce((s, c) => s + (c.skills?.defense ?? 0), 0), 90);

export function mkRun(ship, crew, distance, fuelBudget) {
  return {
    pos: { x: 0, z: 0 }, heading: 0, throttle: 1,
    fuel: 0, fuelBudget, hull: 3, t: 0, distance,
    engine: ship.engine,
    fuelSkill: fuelSkill(crew), defense: defenseSkill(crew),
    struck: new Set(), done: false, outcome: null,
  };
}

const YAW_RATE = 1.6; // rad/s

export function stepRun(run, dt, input, world, rand = Math.random) {
  if (run.done) return run;
  run.heading += (input.yaw ?? 0) * YAW_RATE * dt;
  run.throttle = Math.max(0, Math.min(1, input.throttle ?? 1));
  const v = run.throttle * run.engine;
  run.pos.x += Math.sin(run.heading) * v * dt;
  run.pos.z += Math.cos(run.heading) * v * dt;
  run.fuel += run.throttle * run.engine * (1 - run.fuelSkill / 100) * dt;
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

export function telemetry(run, mission, ship) {
  return {
    durationS: run.t,
    fuelSpent: Math.ceil(run.fuel),
    cargoDelivered: Math.min(ship.cargo, mission.amount),
  };
}
```

- [ ] **Step 4: Run test to verify it passes, then full suite**

Run: `cd ~/skyharbour/server && npx vitest run test/client/flightMath.test.ts && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add client/flightMath.js server/test/client/flightMath.test.ts && git commit -m "feat(client): pure flight model locked to server physics"
```

---

### Task 6: Vendor three.js

**Files:**
- Create: `client/vendor/three.module.min.js` (copied from npm)
- Modify: `index.html` (importmap)
- Modify: `.gitignore` — ensure `client/vendor/` is NOT ignored (it isn't; just verify)

**Interfaces:**
- Produces: ES import `three` resolvable in the browser via importmap.

- [ ] **Step 1: Fetch and vendor**

Run:
```bash
cd ~/skyharbour/server && npm install --no-save three@^0.170.0 \
  && mkdir -p ../client/vendor \
  && cp node_modules/three/build/three.module.min.js ../client/vendor/three.module.min.js \
  && ls -la ../client/vendor/
```
Expected: file ~700KB. (`--no-save`: three is a client vendor file, not a server dependency.)

- [ ] **Step 2: Importmap**

In `index.html` `<head>`, before the stylesheet links, add:
```html
    <script type="importmap">
      { "imports": { "three": "./client/vendor/three.module.min.js" } }
    </script>
```

- [ ] **Step 3: Smoke**

Run:
```bash
cd ~/skyharbour/server && (SKYHARBOUR_DB=':memory:' PORT=8422 npx tsx src/index.ts &) && sleep 3 \
  && curl -s -o /dev/null -w '%{http_code}\n' localhost:8422/app/client/vendor/three.module.min.js; pkill -f 'tsx src/index.ts'
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
cd ~/skyharbour && git add client/vendor/three.module.min.js index.html && git commit -m "chore(client): vendor three.js (no CDN)"
```

---

### Task 7: The flight — three.js Battlezone scene

**Files:**
- Create: `client/flight.js`
- Modify: `index.html` (load flight.js as module)
- Modify: `styles.css` (flight overlay + HUD styles)
- Test: headless screenshot smoke; logic already covered by flightMath tests

**Interfaces:**
- Consumes: `'sh:launch'` window event with `detail = { mission, ship, crew }` (from Task 4); `flightMath.js`; `three`; `completeMission`/`failMission`/`balances` from `api.js`; `refreshEconomy` is NOT imported (bridge listens for `'sh:done'`).
- Produces: fullscreen overlay flight; on run end POSTs complete (landed) or fail (void/dry), shows the payout/debrief card, then dispatches window event `'sh:done'`. Controls: A/D or ←/→ yaw; W/S or ↑/↓ throttle; ESC aborts (= fail).

- [ ] **Step 1: Overlay + HUD styles**

Append to `styles.css`:
```css
/* ---------- flight overlay ---------- */
#flight-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: var(--void);
}

#flight-overlay canvas {
    display: block;
    width: 100%;
    height: 100%;
}

.flight-hud {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    display: flex;
    gap: 14px;
    font-family: var(--font);
    font-size: 12px;
    letter-spacing: 0.16em;
    color: var(--phosphor);
    text-shadow: 0 0 8px rgba(65, 255, 122, 0.5);
}

.flight-hud b {
    color: var(--gold);
    font-variant-numeric: tabular-nums;
}

.debrief {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    border: 1px solid var(--phosphor-dim);
    background: rgba(3, 8, 5, 0.92);
    color: var(--phosphor);
    font-family: var(--font);
    padding: 24px 34px;
    text-align: center;
    letter-spacing: 0.14em;
}

.debrief .gold { color: var(--gold); }
.debrief .bad { color: var(--danger); }

.debrief button {
    margin-top: 16px;
    font-family: var(--font);
    color: var(--phosphor);
    background: transparent;
    border: 1px solid var(--phosphor-dim);
    padding: 8px 22px;
    letter-spacing: 0.14em;
    cursor: pointer;
}

.debrief button:hover {
    background: var(--phosphor);
    color: var(--void);
}
```

- [ ] **Step 2: Implement flight.js**

`client/flight.js`:
```js
import * as THREE from 'three';
import { mkWorld, mkRun, stepRun, telemetry } from './flightMath.js';
import { completeMission, failMission, balances } from './api.js';

const PHOSPHOR = 0x41ff7a;
const overlay = document.getElementById('flight-overlay');

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

export function launch({ mission, ship, crew }, fuelBudget) {
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="flight-hud">
      <span>FUEL <b id="hud-fuel">0</b></span>
      <span>HULL <b id="hud-hull">3</b></span>
      <span>DIST <b id="hud-dist">0</b></span>
      <span>THR <b id="hud-thr">100%</b></span>
      <span>${mission.cargo} ×${mission.amount} → SETTLEMENT</span>
    </div>`;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  overlay.prepend(renderer.domElement);

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

  const world = mkWorld(mission.id, mission.distance);
  for (const k of world.rocks) { const m = wireRock(k.r); m.position.set(k.x, k.y, k.z); scene.add(m); }
  for (const o of world.islands) { const m = wireIsland(o.r); m.position.set(o.x, o.y - 40, o.z); scene.add(m); }
  const settle = wireSettlement(); settle.position.set(world.target.x, -6, world.target.z); scene.add(settle);

  const run = mkRun(ship, crew, mission.distance, fuelBudget);
  const keys = {};
  const onKey = (e) => {
    keys[e.key.toLowerCase()] = e.type === 'keydown';
    if (e.key === 'Escape' && e.type === 'keydown') { run.done = true; run.outcome = 'void'; }
  };
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKey);
  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', onResize);

  let throttle = 1;
  let last = performance.now();

  function hud() {
    document.getElementById('hud-fuel').textContent = `${Math.max(0, Math.floor(fuelBudget - run.fuel))}`;
    document.getElementById('hud-hull').textContent = `${run.hull}`;
    const dx = world.target.x - run.pos.x, dz = world.target.z - run.pos.z;
    document.getElementById('hud-dist').textContent = `${Math.floor(Math.hypot(dx, dz))}`;
    document.getElementById('hud-thr').textContent = `${Math.round(throttle * 100)}%`;
  }

  async function finish() {
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKey);
    removeEventListener('resize', onResize);
    let card;
    try {
      if (run.outcome === 'landed') {
        const payout = await completeMission(mission.id, telemetry(run, mission, ship));
        const shares = payout.crewShares.map((s) => `${s.owner.toUpperCase()} +${s.gold}G`).join(' · ') || 'NO CREW SHARES';
        card = `<p class="gold">CARGO DELIVERED</p>
          <p>+${payout.rewardGold} GOLD · FUEL BURNED ${payout.fuelBurned}</p>
          <p>${shares}</p>${payout.stageCompleted ? '<p class="gold">STAGE COMPLETE — THE CITY GROWS</p>' : ''}`;
      } else {
        await failMission(mission.id);
        card = `<p class="bad">${run.outcome === 'dry' ? 'TANKS DRY — SHIP LOST TO THE VOID' : 'HULL BREACH — LOST TO THE VOID'}</p>
          <p>ENTRY FEE FORFEITED (${mission.feeGold} G)</p>`;
      }
    } catch (e) {
      card = `<p class="bad">${e.message.toUpperCase()}</p>`;
    }
    const div = document.createElement('div');
    div.className = 'debrief';
    div.innerHTML = `${card}<button id="debrief-close">RETURN TO BRIDGE</button>`;
    overlay.appendChild(div);
    document.getElementById('debrief-close').addEventListener('click', () => {
      overlay.hidden = true;
      overlay.innerHTML = '';
      renderer.dispose();
      window.dispatchEvent(new Event('sh:done'));
    });
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const yaw = (keys['a'] || keys['arrowleft'] ? 1 : 0) + (keys['d'] || keys['arrowright'] ? -1 : 0);
    if (keys['w'] || keys['arrowup']) throttle = Math.min(1, throttle + dt);
    if (keys['s'] || keys['arrowdown']) throttle = Math.max(0.1, throttle - dt);
    stepRun(run, dt, { yaw, throttle }, world);
    camera.position.set(run.pos.x, 4, run.pos.z);
    camera.rotation.set(0, Math.PI + run.heading, 0); // face +z travel direction
    hud();
    renderer.render(scene, camera);
    if (!run.done) requestAnimationFrame(frame);
    else finish();
  }
  requestAnimationFrame(frame);
}

// Bridge hands us the accepted mission; fuel budget = live FUEL balance.
window.addEventListener('sh:launch', async (ev) => {
  const bal = await balances();
  launch(ev.detail, bal.FUEL);
});
```

- [ ] **Step 3: Load it**

In `index.html`, after the bridge.js script tag:
```html
    <script type="module" src="./client/flight.js"></script>
```

- [ ] **Step 4: Verify**

Run server suite (`cd ~/skyharbour/server && npm test && npm run typecheck`) — green, then boot and screenshot:
```bash
cd ~/skyharbour/server && (SKYHARBOUR_DB=':memory:' PORT=8422 npx tsx src/index.ts &) && sleep 3 \
  && firefox --headless --profile /tmp/ffprof-fly --screenshot /tmp/fly-smoke.png --window-size=1600,900 "http://localhost:8422/app/" 2>/dev/null; pkill -f 'tsx src/index.ts'
```
Read `/tmp/fly-smoke.png` — the console must render with no JS errors (channels present). Then a MANUAL playtest note in the commit message is required: run the server, dock as alice, generate, accept, fly, land or die, confirm the debrief and refreshed balances.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add client/flight.js index.html styles.css && git commit -m "feat(client): the flight — Battlezone run over the void"
```

---

### Task 8: Debrief refresh + full-loop verification

**Files:**
- Modify: `client/bridge.js` (listen for `sh:done`)
- Test: `server/test/client/loop.test.ts` (API-level full loop with flightMath-generated telemetry — the exact contract the browser exercises)

**Interfaces:**
- Consumes: everything above.
- Produces: after a flight ends, the console refreshes economy + board automatically.

- [ ] **Step 1: Bridge refresh hook**

Append to `client/bridge.js`:
```js
window.addEventListener('sh:done', async () => {
  await Promise.all([refreshEconomy(), refreshBoard(), refreshCrew()]);
});
```
(`refreshBoard`/`refreshCrew` are module-scope functions — no export change needed.)

- [ ] **Step 2: Write the failing loop test**

`server/test/client/loop.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { mkWorld, mkRun, stepRun, telemetry } from '../../../client/flightMath.js';

describe('full loop: fly the mission exactly as the browser would', () => {
  it('accept → simulated flight → complete pays out', async () => {
    const app = buildApp();
    const h = { 'x-wallet': 'alice' };
    await app.inject({ method: 'POST', url: '/login', headers: h });
    const [m] = (await app.inject({ method: 'POST', url: '/missions/generate', headers: h, payload: { count: 1 } })).json();
    const acc = await app.inject({ method: 'POST', url: `/missions/${m.id}/accept`, headers: h, payload: { shipId: 'ship-1', crewIds: [] } });
    expect(acc.statusCode).toBe(200);

    const ship = { id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2 };
    const world = mkWorld(m.id, m.distance);
    world.rocks = []; // deterministic pass — hazard outcomes are flightMath-tested
    const run = mkRun(ship, [], m.distance, 300);
    while (!run.done) stepRun(run, 0.1, { yaw: 0, throttle: 1 }, world);
    expect(run.outcome).toBe('landed');

    const done = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: h,
      payload: { telemetry: telemetry(run, m, ship) },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().delivered).toBeGreaterThan(0);

    const bal = (await app.inject({ method: 'GET', url: '/balances', headers: h })).json();
    expect(bal.GOLD).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it passes (it must — this is the integration seal)**

Run: `cd ~/skyharbour/server && npx vitest run test/client/loop.test.ts && npm test && npm run typecheck`
Expected: all green. If `complete` 400s here, flightMath and validation have drifted — fix flightMath, never the server.

- [ ] **Step 4: Commit**

```bash
cd ~/skyharbour && git add client/bridge.js server/test/client/loop.test.ts && git commit -m "feat(client): post-flight refresh + browser-contract loop test"
```

---

## Self-review notes

- **Spec coverage (§4-5, client side):** wallet login stub (§5.1 — dev header until plan 2) T2/T4; hangar from NFT-seam ships (§5.2) T3/T4; crew market + hire (§5.3) T3/T4; mission board from settlement needs (§5.4) T3/T4; accept with fee/fuel checks (§5.5 — server-enforced) T4; piloted run with fuel drain, ENGINE speed, crew modifiers, void/dry/hull failure (§5.6) T5/T7; atomic payout + stage events surfaced in debrief (§5.7) T7/T8; claim stays a manifest stub (§5.8 — plan 2). Settlement view + balances (§4 dapp UI) T3/T4.
- **Type consistency:** `stepRun(run, dt, input, world, rand?)` used identically in T5 tests, T7 scene, T8 loop; `telemetry(run, mission, ship)` consistent; `sh:launch` detail `{ mission, ship, crew }` produced in T4 and consumed in T7; `buildApp({ staticRoot })` in T1 only.
- **Known simplifications (documented, not hidden):** crew skills for hired (non-own) crew arrive as `{}` in T4's launch detail — fuel/defense bonuses of *hired* crew apply server-side (minFuel check at accept) but not in the client model until the market exposes skills (needs a `GET /crew/market` shape change — deferred to balancing; the server never trusts client skill claims anyway, it recomputes from its own fleet data). ESC aborts count as hull loss ('void'). Rocks don't move.
