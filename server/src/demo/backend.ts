// The offline demo harbour: the same domain modules buildApp() wires up in
// dev mode (no chain), behind a tiny request router instead of fastify, so a
// static host like GitHub Pages can run the full game in the browser.
//
// Keep this in step with the dev-mode routes in app.ts — test/demo.test.ts
// replays one scenario through both and asserts identical responses.
import type Database from 'better-sqlite3';
import { Ledger } from '../ledger.js';
import { DevFleet, devFixtures, NPC_CREW, HARBOUR } from '../fleet.js';
import { Grants } from '../grants.js';
import { Settlement, DEFAULT_STAGES } from '../settlement.js';
import { CrewMarket } from '../crew.js';
import { MissionEngine, type FireEvent } from '../missions.js';
import { TOKENS, type TokenId } from '../tokens.js';
import { buyFuel, buyProvision } from '../pump.js';
import { HullState } from '../hull.js';
import { Contributions } from '../contributions.js';
import { isReservedWallet } from '../chain/reserved.js';

export interface DemoRequest {
  method: string;
  path: string;
  wallet: string | null;
  body?: any;
}

export interface DemoResponse { status: number; body: unknown }

type Handler = (wallet: string, body: any, params: string[]) => unknown;

export function createDemoBackend(db: Database.Database) {
  const ledger = new Ledger(db);
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);
  const grants = new Grants(db, ledger, fleet);
  const settlement = new Settlement(db, DEFAULT_STAGES);
  const market = new CrewMarket(db, fleet);
  const hull = new HullState(db);
  const contributions = new Contributions(db);
  const missions = new MissionEngine(db, ledger, settlement, market, fleet, hull, contributions);

  for (const { member, sharePct } of NPC_CREW) market.list(member.id, HARBOUR, sharePct);

  const pilotOnly = (id: string, wallet: string) => {
    const m = missions.get(id);
    if (m && m.status === 'active' && m.pilot !== wallet) throw new Error('only the mission pilot can do that');
  };

  const routes: [string, RegExp, Handler][] = [
    ['POST', /^\/login$/, (wallet) => {
      const granted = grants.grantShipOwner(wallet);
      const owned = fleet.shipsOf(wallet).map((s) => ({ ...s, currentHull: hull.current(s.id, s.hull) }));
      return { wallet, ships: owned, crew: fleet.crewOf(wallet), granted, chain: false, treasury: null, demo: true };
    }],
    ['GET', /^\/balances$/, (wallet) => {
      const out: Partial<Record<TokenId, number>> = {};
      for (const id of Object.keys(TOKENS) as TokenId[]) out[id] = ledger.balance(`wallet:${wallet}`, id);
      return out;
    }],
    ['GET', /^\/missions$/, () => missions.open()],
    ['GET', /^\/missions\/mine$/, (wallet) => missions.mine(wallet)],
    ['POST', /^\/missions\/generate$/, (_w, body) => missions.generate(body.count)],
    ['POST', /^\/missions\/([^/]+)\/accept$/, (wallet, body, [id]) =>
      missions.accept(id, wallet, body.shipId, body.crewIds ?? [])],
    ['POST', /^\/missions\/([^/]+)\/complete$/, (wallet, body, [id]) => {
      pilotOnly(id, wallet);
      return missions.complete(id, body.fireEvents as FireEvent[]);
    }],
    ['POST', /^\/missions\/([^/]+)\/fail$/, (wallet, body, [id]) => {
      pilotOnly(id, wallet);
      missions.fail(id, body?.fuelSpent ?? 0, body?.ammoSpent ?? 0);
      return { ok: true };
    }],
    ['GET', /^\/settlement$/, () => ({
      stage: settlement.currentStage() ?? null,
      received: settlement.received(),
      remainingNeeds: settlement.remainingNeeds(),
      completedStages: settlement.completedStages(),
    })],
    ['GET', /^\/leaderboard$/, () => contributions.leaderboard(20)],
    ['GET', /^\/crew\/market$/, () => market.listings()],
    ['POST', /^\/crew\/list$/, (wallet, body) => market.list(body.crewId, wallet, body.sharePct)],
    ['POST', /^\/crew\/unlist$/, (wallet, body) => { market.unlist(body.crewId, wallet); return { ok: true }; }],
    ['POST', /^\/fuel\/buy$/, (wallet, body) => buyFuel(ledger, wallet, body.gold)],
    ['POST', /^\/ammo\/buy$/, (wallet, body) => buyProvision(ledger, wallet, body.gold, 'AMMO')],
    ['POST', /^\/ship\/repair$/, (wallet, body) => {
      const ship = fleet.getShip(body.shipId);
      if (!ship || ship.owner !== wallet) throw new Error(`wallet ${wallet} does not own ship ${body.shipId}`);
      return { ...hull.repair(ledger, wallet, body.shipId, ship.hull, body.toHull), max: ship.hull };
    }],
    // No chain in the demo: nothing to claim to, no SOL treasury, no
    // signature docking (bridge.js falls back to a pilot name).
    ['GET', /^\/claims$/, () => []],
    ['POST', /^\/claim$/, () => { throw new Error('claims need the live harbour — this is the demo'); }],
    ['POST', /^\/gold\/buy$/, () => { throw new Error('chain mode only'); }],
  ];

  function handle(req: DemoRequest): DemoResponse {
    try {
      if (req.path.startsWith('/auth/')) {
        return { status: 400, body: { error: 'wallet docking needs the live harbour — this is the demo' } };
      }
      const wallet = req.wallet ?? '';
      if (wallet.length === 0) return { status: 401, body: { error: 'missing x-wallet header (dev auth)' } };
      if (isReservedWallet(wallet)) return { status: 400, body: { error: 'reserved system name' } };
      for (const [method, re, fn] of routes) {
        const m = req.method === method ? re.exec(req.path) : null;
        if (m) return { status: 200, body: fn(wallet, req.body ?? {}, m.slice(1)) };
      }
      return { status: 404, body: { error: `Route ${req.method}:${req.path} not found` } };
    } catch (e) {
      return { status: 400, body: { error: (e as Error).message } };
    }
  }

  return { handle };
}
