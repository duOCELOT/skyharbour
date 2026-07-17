import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import { Ledger } from './ledger.js';
import { DevFleet, devFixtures, NPC_CREW, HARBOUR } from './fleet.js';
import { Grants } from './grants.js';
import { Settlement, DEFAULT_STAGES } from './settlement.js';
import { CrewMarket } from './crew.js';
import { MissionEngine, type FireEvent } from './missions.js';
import { TOKENS, type TokenId } from './tokens.js';
import { buyFuel, buyProvision } from './pump.js';
import { HullState } from './hull.js';
import { Contributions } from './contributions.js';
import { isReservedWallet } from './chain/config.js';
import { ChainAuth } from './chain/auth.js';
import { ChainFleet, type RegistryEntry } from './chain/fleet.js';
import { Claims } from './chain/claims.js';
import { SolOnramp } from './chain/onramp.js';

export function buildApp(opts: {
  dbPath?: string;
  staticRoot?: string;
  chain?: { registry: Record<string, RegistryEntry>; fetchMints: (owner: string) => Promise<string[]> };
  adminKey?: string;
  onramp?: { treasury: string; fetchTx: (sig: string) => Promise<any> };
} = {}) {
  const db = new Database(opts.dbPath ?? ':memory:');
  const ledger = new Ledger(db);
  const { ships, crew } = devFixtures();
  const fleet = opts.chain
    ? new ChainFleet(db, opts.chain.registry, devFixtures().crew.filter((c) => c.owner === HARBOUR))
    : new DevFleet(ships, crew);
  const grants = new Grants(db, ledger, fleet);
  const settlement = new Settlement(db, DEFAULT_STAGES);
  const market = new CrewMarket(db, fleet);
  const hull = new HullState(db);
  const contributions = new Contributions(db);
  const missions = new MissionEngine(db, ledger, settlement, market, fleet, hull, contributions);
  const chainAuth = new ChainAuth(db);
  const claims = new Claims(db, ledger);
  const onramp = opts.onramp ? new SolOnramp(db, ledger, opts.onramp.treasury, opts.onramp.fetchTx) : null;

  for (const { member, sharePct } of NPC_CREW) {
    market.list(member.id, HARBOUR, sharePct); // idempotent upsert — harbour staffs the market
  }

  const app = Fastify();

  app.addHook('onRequest', async (req, reply) => {
    if (opts.staticRoot && (req.url === '/' || req.url === '/app' || req.url.startsWith('/app/'))) return;
    if (req.url.startsWith('/auth/')) return;
    const session = req.headers['x-session'];
    if (typeof session === 'string') {
      const w = chainAuth.walletFor(session);
      if (w) { (req as unknown as { wallet: string }).wallet = w; return; }
      return reply.code(401).send({ error: 'invalid session' });
    }
    if (opts.chain) {
      // Chain mode is sessions-only: no x-session means no docking, full stop.
      // Falling through to the dev x-wallet header here would let anyone
      // claim any wallet's balance just by naming it.
      return reply.code(401).send({ error: 'signature docking required' });
    }
    const wallet = req.headers['x-wallet'];
    if (typeof wallet !== 'string' || wallet.length === 0) {
      return reply.code(401).send({ error: 'missing x-wallet header (dev auth)' });
    }
    if (isReservedWallet(wallet)) return reply.code(400).send({ error: 'reserved system name' });
    (req as unknown as { wallet: string }).wallet = wallet;
  });

  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode < 500) {
      reply.code(statusCode).send({ error: err.message });
      return;
    }
    if (statusCode !== undefined && statusCode >= 500) {
      reply.code(500).send({ error: 'internal error' });
      return;
    }
    reply.code(400).send({ error: err.message });
  });

  const walletOf = (req: unknown): string => (req as { wallet: string }).wallet;

  const isValidWalletField = (wallet: unknown): wallet is string =>
    typeof wallet === 'string' && wallet.length >= 1 && wallet.length <= 64;

  app.post('/auth/nonce', async (req) => {
    const { wallet } = (req.body ?? {}) as { wallet?: unknown };
    if (!isValidWalletField(wallet)) throw new Error('wallet must be a string');
    const nonce = chainAuth.issueNonce(wallet);
    return { nonce, message: `Skyharbour docking clearance: ${nonce}` };
  });

  app.post('/auth/verify', async (req) => {
    const { wallet, signature } = (req.body ?? {}) as { wallet?: unknown; signature?: unknown };
    if (!isValidWalletField(wallet)) throw new Error('wallet must be a string');
    if (typeof signature !== 'string') throw new Error('signature must be a string');
    return { session: chainAuth.verify(wallet, signature) };
  });

  app.post('/login', async (req) => {
    const wallet = walletOf(req);
    if (isReservedWallet(wallet)) throw new Error('reserved system name');
    if (opts.chain) await (fleet as ChainFleet).refreshHoldings(wallet, opts.chain.fetchMints);
    const granted = grants.grantShipOwner(wallet);
    const ships = fleet.shipsOf(wallet).map((s) => ({ ...s, currentHull: hull.current(s.id, s.hull) }));
    return { wallet, ships, crew: fleet.crewOf(wallet), granted, chain: !!opts.chain, treasury: opts.onramp?.treasury ?? null };
  });

  app.get('/balances', async (req) => {
    const wallet = walletOf(req);
    const out: Partial<Record<TokenId, number>> = {};
    for (const id of Object.keys(TOKENS) as TokenId[]) {
      out[id] = ledger.balance(`wallet:${wallet}`, id);
    }
    return out;
  });

  app.get('/missions', async () => missions.open());

  app.get('/missions/mine', async (req) => missions.mine(walletOf(req)));

  app.post('/missions/generate', async (req) => {
    const { count } = req.body as { count: number };
    return missions.generate(count);
  });

  app.post('/missions/:id/accept', async (req) => {
    const { id } = req.params as { id: string };
    const { shipId, crewIds } = req.body as { shipId: string; crewIds: string[] };
    return missions.accept(id, walletOf(req), shipId, crewIds ?? []);
  });

  app.post('/missions/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const wallet = walletOf(req);
    const mission = missions.get(id);
    if (mission && mission.status === 'active' && mission.pilot !== wallet) {
      throw new Error('only the mission pilot can do that');
    }
    const { fireEvents } = req.body as { fireEvents: FireEvent[] };
    return missions.complete(id, fireEvents);
  });

  app.post('/missions/:id/fail', async (req) => {
    const { id } = req.params as { id: string };
    const wallet = walletOf(req);
    const mission = missions.get(id);
    if (mission && mission.status === 'active' && mission.pilot !== wallet) {
      throw new Error('only the mission pilot can do that');
    }
    const { fuelSpent, ammoSpent } = (req.body ?? {}) as { fuelSpent?: number; ammoSpent?: number };
    missions.fail(id, fuelSpent ?? 0, ammoSpent ?? 0);
    return { ok: true };
  });

  app.get('/settlement', async () => ({
    stage: settlement.currentStage() ?? null,
    received: settlement.received(),
    remainingNeeds: settlement.remainingNeeds(),
    completedStages: settlement.completedStages(),
  }));

  // Who has delivered most to the settlement — the airdrop share ledger.
  app.get('/leaderboard', async () => contributions.leaderboard(20));

  app.get('/crew/market', async () => market.listings());

  app.post('/crew/list', async (req) => {
    const { crewId, sharePct } = req.body as { crewId: string; sharePct: number };
    return market.list(crewId, walletOf(req), sharePct);
  });

  app.post('/crew/unlist', async (req) => {
    const { crewId } = req.body as { crewId: string };
    market.unlist(crewId, walletOf(req));
    return { ok: true };
  });

  app.post('/admin/airdrop', async (req, reply) => {
    if (opts.chain && !opts.adminKey) {
      // Chain mode with no operator key configured must fail closed: an
      // unconfigured adminKey used to mean "no gate at all" (the check below
      // only fires when adminKey is truthy), which would let anyone airdrop
      // real minting weight in chain mode.
      return reply.code(403).send({ error: 'operator key required' });
    }
    if (opts.adminKey && req.headers['x-admin-key'] !== opts.adminKey) {
      return reply.code(403).send({ error: 'operator key required' });
    }
    const { wallets, amount } = req.body as { wallets: string[]; amount: number };
    return { credited: grants.airdropFuel(wallets, amount) };
  });

  app.post('/fuel/buy', async (req) => {
    const { gold } = req.body as { gold: number };
    return buyFuel(ledger, walletOf(req), gold);
  });

  app.post('/ammo/buy', async (req) => {
    const { gold } = req.body as { gold: number };
    return buyProvision(ledger, walletOf(req), gold, 'AMMO');
  });

  app.post('/gold/buy', async (req) => {
    if (!onramp) throw new Error('chain mode only');
    const { signature } = (req.body ?? {}) as { signature?: unknown };
    if (typeof signature !== 'string') throw new Error('signature must be a string');
    return onramp.redeem(walletOf(req), signature);
  });

  app.post('/ship/repair', async (req) => {
    const wallet = walletOf(req);
    const { shipId, toHull } = req.body as { shipId: string; toHull: number };
    const ship = fleet.getShip(shipId);
    if (!ship || ship.owner !== wallet) throw new Error(`wallet ${wallet} does not own ship ${shipId}`);
    const result = hull.repair(ledger, wallet, shipId, ship.hull, toHull);
    return { ...result, max: ship.hull };
  });

  app.post('/claim', async (req) => {
    const { token } = req.body as { token: TokenId };
    return claims.request(walletOf(req), token);
  });

  app.get('/claims', async (req) => claims.listFor(walletOf(req)));

  if (opts.staticRoot) {
    const PUBLIC_PREFIXES = ['/index.html', '/styles.css', '/script.js', '/client/', '/img/', '/ships/', '/buttons/', '/cards/'];
    app.register(fastifyStatic, {
      root: opts.staticRoot,
      prefix: '/app/',
      dotfiles: 'deny',
      allowedPath: (pathName) =>
        pathName === '/' || PUBLIC_PREFIXES.some((p) => pathName === p || (p.endsWith('/') && pathName.startsWith(p))),
    });
    app.get('/', async (_req, reply) => reply.redirect('/app/'));
  }

  // index.ts (outside this module's type surface) needs the Claims instance
  // to drive the 15s claim-worker interval. There's no fastify-decorate
  // typing plumbed through for this yet, so we hang it off the instance
  // directly and cast at the read site in index.ts — narrow, single-purpose
  // escape hatch rather than a module augmentation for one field.
  (app as unknown as { skyharbour: { claims: Claims } }).skyharbour = { claims };

  return app;
}
