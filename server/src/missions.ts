import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Ledger, type Leg } from './ledger.js';
import { Settlement } from './settlement.js';
import { CrewMarket } from './crew.js';
import type { FleetSource, CrewMember } from './fleet.js';
import { TOKENS, type TokenId } from './tokens.js';
import { minFuel } from './validation.js';
import { resolveRun, type FireEvent } from '../../client/flightMath.js';
import type { HullState } from './hull.js';
import { Contributions } from './contributions.js';

export type { FireEvent };

export interface Mission {
  id: string;
  cargo: TokenId;
  amount: number;
  origin: string;
  distance: number;
  rewardGold: number;
  feeGold: number;
  status: 'open' | 'active' | 'done' | 'failed';
  pilot?: string;
  shipId?: string;
  crewIds?: string[];
  /**
   * Crew hire terms snapshotted at accept() time: crewId, owner, and the
   * sharePct in effect at that moment. complete()/fail() MUST use this
   * snapshot rather than re-reading the live CrewMarket listing, since the
   * listing can change (relist at a higher share, or unlist) after accept.
   */
  crewTerms?: { crewId: string; owner: string; sharePct: number }[];
  /**
   * Ship's current hull (server-tracked, from HullState) at accept() time —
   * so the client can render "you launched at N/max hull" without trusting
   * a self-reported value.
   */
  startHull?: number;
}

export interface Payout {
  rewardGold: number;
  crewShares: { owner: string; gold: number }[];
  fuelBurned: number;
  delivered: number;
  stageCompleted: boolean;
  outcome: 'landed' | 'void';
  airdrop?: { total: number; recipients: number }; // set when a stage completed
}

const ORIGINS = ['Isla Verde', 'Ironspire', 'Woodhaven', 'Runefall'];

// --- economy dials (tune these two, then watch a playtest) ---
// Raise HAZARD_DIVISOR to shrink hazard pay across the board; lower it to make
// each completed run pay more (it scales with cargo value). BOUNTY_PER_KILL
// below shell cost makes combat defensive rather than a bounty farm.
export const HAZARD_DIVISOR = 7;
export const BOUNTY_PER_KILL = 1;
// GOLD minted into every stage-completion airdrop, on top of the fees the
// settlement collected — split among builders by value delivered.
export const STAGE_BONUS = 500;

// Hazard pay scales with cargo value: valuable cargo across a long, raider-thick
// route earns a real premium, cheap cargo far earns less — so WHAT you carry
// matters on every route.
export const hazardPay = (distance: number, cargo: TokenId) =>
  Math.ceil((distance * TOKENS[cargo].unitPriceGold) / HAZARD_DIVISOR);

export const missionAmountCap = (stageIndex: number) => 20 + 10 * stageIndex;

export class MissionEngine {
  constructor(
    private db: Database.Database,
    private ledger: Ledger,
    private settlement: Settlement,
    private market: CrewMarket,
    private fleet: FleetSource,
    private hullState: HullState,
    // Optional so the many existing 6-arg call sites keep working; defaults to
    // a fresh instance on the same db (the table is shared).
    private contributions: Contributions = new Contributions(db),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `);
  }

  private save(m: Mission): void {
    this.db
      .prepare('INSERT INTO missions (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(m.id, JSON.stringify(m));
  }

  get(id: string): Mission | undefined {
    const row = this.db.prepare('SELECT data FROM missions WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Mission) : undefined;
  }

  open(): Mission[] {
    const rows = this.db.prepare('SELECT data FROM missions').all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Mission).filter((m) => m.status === 'open');
  }

  mine(wallet: string): Mission[] {
    const rows = this.db.prepare('SELECT data FROM missions').all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Mission)
      .filter((m) => m.status === 'active' && m.pilot === wallet);
  }

  generate(count: number): Mission[] {
    // Local snapshot of remaining needs, decremented as missions are drafted
    // within this call so a single generate(count) batch cannot issue more
    // than the stage actually needs. Cross-call over-issue (already-open
    // missions aren't reserved against needs) is a known v1 limitation.
    const stageIdx = this.settlement.currentStage()?.index ?? 0;
    const needs = { ...this.settlement.remainingNeeds() } as Partial<Record<TokenId, number>>;
    let cargoTypes = (Object.keys(needs) as TokenId[]).filter((t) => (needs[t] ?? 0) > 0);
    const out: Mission[] = [];
    let i = 0;
    while (out.length < count && cargoTypes.length > 0) {
      const cargo = cargoTypes[i % cargoTypes.length];
      const remaining = needs[cargo]!;
      const cap = missionAmountCap(stageIdx);
      const amount = Math.max(1, Math.min(remaining, 5 + Math.floor(Math.random() * (cap - 4)))); // 5..cap units
      needs[cargo] = remaining - amount;
      const distance = 60 + Math.floor(Math.random() * 241); // 60..300
      const rewardGold = amount * TOKENS[cargo].unitPriceGold + hazardPay(distance, cargo);
      const m: Mission = {
        id: randomUUID(),
        cargo,
        amount,
        origin: ORIGINS[Math.floor(Math.random() * ORIGINS.length)],
        distance,
        rewardGold,
        feeGold: Math.max(1, Math.floor(rewardGold / 10)),
        status: 'open',
      };
      this.save(m);
      out.push(m);
      if (needs[cargo]! <= 0) {
        cargoTypes = cargoTypes.filter((t) => t !== cargo);
        // don't advance i: the array shrank, so i now indexes the next type
      } else {
        i++;
      }
    }
    return out;
  }

  private resolveCrew(
    pilot: string,
    crewIds: string[],
  ): { id: string; member: CrewMember; sharePct: number }[] {
    return crewIds.map((id) => {
      const member = this.fleet.getCrew(id);
      if (!member) throw new Error(`unknown crew ${id}`);
      if (member.owner === pilot) return { id, member, sharePct: 0 }; // own crew fly free
      const listing = this.market.getListing(id);
      if (!listing) throw new Error(`crew ${id} is not listed for hire`);
      return { id, member, sharePct: listing.sharePct };
    });
  }

  accept(id: string, wallet: string, shipId: string, crewIds: string[]): Mission {
    const m = this.get(id);
    if (!m || m.status !== 'open') throw new Error(`mission ${id} is not open`);
    const ship = this.fleet.getShip(shipId);
    if (!ship || ship.owner !== wallet) throw new Error(`wallet ${wallet} does not own ship ${shipId}`);
    if (new Set(crewIds).size !== crewIds.length) {
      throw new Error(`duplicate crew ids in ${JSON.stringify(crewIds)}`);
    }
    if (crewIds.length > ship.crewSlots) {
      throw new Error(`crew exceeds ship slots (${ship.crewSlots})`);
    }
    const crew = this.resolveCrew(wallet, crewIds);
    const totalShare = crew.reduce((s, c) => s + c.sharePct, 0);
    if (totalShare > 50) throw new Error(`total crew share ${totalShare}% exceeds 50%`);
    const fuelNeed = minFuel(m.distance, crew.map((c) => c.member));
    if (this.ledger.balance(`wallet:${wallet}`, 'FUEL') < fuelNeed) {
      throw new Error(`insufficient FUEL: need at least ${fuelNeed}`);
    }
    // Snapshot the hired terms now — complete()/fail() must not re-read the
    // live CrewMarket, since a listing can change (relist, unlist) later.
    const crewTerms = crew.map((c) => ({ crewId: c.id, owner: c.member.owner, sharePct: c.sharePct }));
    const startHull = this.hullState.current(shipId, ship.hull);
    const active: Mission = { ...m, status: 'active', pilot: wallet, shipId, crewIds, crewTerms, startHull };
    this.db.transaction(() => {
      // fee escrow (throws InsufficientFunds if pilot lacks GOLD)
      this.ledger.post(`fee escrow ${m.id}`, [
        { account: `wallet:${wallet}`, token: 'GOLD', amount: -m.feeGold },
        { account: `escrow:${m.id}`, token: 'GOLD', amount: m.feeGold },
      ]);
      this.save(active);
    })();
    return active;
  }

  // Shared fail-settlement legs: fee forfeits from escrow to the
  // settlement, and reported fuel/ammo burn clamped to (a) the pilot's real
  // balance and (b) a sanity cap, so an honest failure or a voided run can
  // never post a negative balance or drain more than a plausible amount.
  // Used by both fail() (client-reported abort) and complete()'s void path
  // (server-resolved hull-to-0).
  private failLegs(m: Mission, fuelSpent: number, ammoSpent: number): Leg[] {
    const burn = Math.min(
      Math.ceil(fuelSpent),
      this.ledger.balance(`wallet:${m.pilot}`, 'FUEL'),
      2 * m.distance, // sanity cap: no honest failure burns more than a double crossing
    );
    const ammoBurn = Math.min(
      Math.ceil(ammoSpent),
      this.ledger.balance(`wallet:${m.pilot}`, 'AMMO'),
      100, // sanity cap: no honest failure burns more than a full magazine's worth
    );
    const legs: Leg[] = [
      { account: `escrow:${m.id}`, token: 'GOLD', amount: -m.feeGold },
      { account: 'settlement', token: 'GOLD', amount: m.feeGold },
    ];
    if (burn > 0) {
      legs.push(
        { account: `wallet:${m.pilot}`, token: 'FUEL', amount: -burn },
        { account: 'burn', token: 'FUEL', amount: burn },
      );
    }
    if (ammoBurn > 0) {
      legs.push(
        { account: `wallet:${m.pilot}`, token: 'AMMO', amount: -ammoBurn },
        { account: 'burn', token: 'AMMO', amount: ammoBurn },
      );
    }
    return legs;
  }

  complete(id: string, fireEvents: FireEvent[]): Payout {
    const m = this.get(id);
    if (!m || m.status !== 'active' || !m.pilot || !m.shipId) {
      throw new Error(`mission ${id} is not active`);
    }
    const ship = this.fleet.getShip(m.shipId);
    if (!ship) throw new Error(`ship ${m.shipId} is no longer held — abandon the mission`);
    // Resolve crew from the terms snapshotted at accept() — never the live
    // CrewMarket listing, which may have changed (relist/unlist) since.
    // Re-reading CrewMember attributes via fleet.getCrew is fine: those are
    // NFT-static and don't change.
    // Known v1 divergence: complete() pays GOLD for full delivered even if settlement.deliver() accepts less (over-issued missions). Tracked for the balancing pass.
    const crew = (m.crewTerms ?? []).map((t) => {
      const member = this.fleet.getCrew(t.crewId);
      if (!member) throw new Error(`unknown crew ${t.crewId}`);
      return { member, owner: t.owner, sharePct: t.sharePct };
    });

    const ammoAvailable = this.ledger.balance(`wallet:${m.pilot}`, 'AMMO');
    const res = resolveRun({
      missionId: m.id,
      distance: m.distance,
      cargo: m.cargo,
      amount: m.amount,
      ship,
      crew: crew.map((c) => c.member),
      startHull: m.startHull ?? ship.hull,
      ammoAvailable,
      fireEvents,
    });
    if (!res.ok) throw new Error(`run rejected: ${res.reason}`);

    if (res.outcome === 'void') {
      // The run is server-resolved as a void (hull reached 0): settle it
      // through the same legs fail() uses, burning the resolver's real
      // fuel/ammo spend rather than anything the client could claim.
      const legs = this.failLegs(m, res.fuelSpent!, res.ammoSpent!);
      this.db.transaction(() => {
        this.ledger.post(`mission failed ${m.id}`, legs);
        this.save({ ...m, status: 'failed' });
      })();
      // Hull is floored at 1 by resolveRun itself (finalHull) — even a void
      // run means the ship limped back, never annihilated.
      try {
        this.hullState.damage(m.shipId, ship.hull, res.hullDamage!);
      } catch (e) {
        console.error(`hull damage write failed for mission ${m.id}: ${(e as Error).message}`);
      }
      return {
        outcome: 'void',
        delivered: 0,
        rewardGold: 0,
        crewShares: [],
        fuelBurned: res.fuelSpent!,
        stageCompleted: false,
      };
    }

    const delivered = Math.floor(res.cargoDelivered!);
    const bounty = BOUNTY_PER_KILL * (res.raidersDestroyed ?? 0);
    const rewardGold = delivered * TOKENS[m.cargo].unitPriceGold
      + Math.floor(hazardPay(m.distance, m.cargo) * delivered / m.amount) + bounty;
    // hazard pays out by delivered fraction — a token delivery cannot farm the full crossing bonus (t-c45ecf)
    const fuelBurned = Math.ceil(res.fuelSpent!);
    // Kills are now server-derived from the resolver, so the old "kills
    // claimed without shells in the magazine" recheck is dead: ammoSpent is
    // already bounded by the pilot's real balance inside resolveRun. This
    // Math.min against the live balance is belt-and-suspenders only.
    const ammoBurned = Math.min(
      Math.ceil(res.ammoSpent ?? 0),
      this.ledger.balance(`wallet:${m.pilot}`, 'AMMO'),
    );
    const crewShares = crew
      .filter((c) => c.sharePct > 0)
      .map((c) => ({ owner: c.owner, gold: Math.floor((rewardGold * c.sharePct) / 100) }));
    const pilotGold = rewardGold - crewShares.reduce((s, c) => s + c.gold, 0);

    const legs: Leg[] = [
      // fee: escrow → settlement
      { account: `escrow:${m.id}`, token: 'GOLD', amount: -m.feeGold },
      { account: 'settlement', token: 'GOLD', amount: m.feeGold },
      // fuel burn
      { account: `wallet:${m.pilot}`, token: 'FUEL', amount: -fuelBurned },
      { account: 'burn', token: 'FUEL', amount: fuelBurned },
      // shell burn — clamped to balance, so a broke pilot never goes negative
      ...(ammoBurned > 0
        ? [
            { account: `wallet:${m.pilot}`, token: 'AMMO' as TokenId, amount: -ammoBurned },
            { account: 'burn', token: 'AMMO' as TokenId, amount: ammoBurned },
          ]
        : []),
      // reward mint, split
      { account: 'mint', token: 'GOLD', amount: -rewardGold },
      { account: `wallet:${m.pilot}`, token: 'GOLD', amount: pilotGold },
      ...crewShares.map((c) => ({
        account: `wallet:${c.owner}`,
        token: 'GOLD' as TokenId,
        amount: c.gold,
      })),
      // cargo mint into the settlement's account
      { account: 'mint', token: m.cargo, amount: -delivered },
      { account: 'settlement', token: m.cargo, amount: delivered },
    ];

    let stageCompleted = false;
    this.db.transaction(() => {
      this.ledger.post(`mission complete ${m.id}`, legs);
      ({ stageCompleted } = this.settlement.deliver(m.cargo, delivered));
      // Durable per-wallet record of who helped build the city, for
      // proportional airdrops later — atomic with the delivery.
      this.contributions.record(m.pilot!, delivered * TOKENS[m.cargo].unitPriceGold);
      this.save({ ...m, status: 'done' });
    })();

    // Hull damage comes straight from the resolver's hullDamage, never
    // self-reported. It's a separate table write from the ledger
    // transaction above — the mission is already successfully completed at
    // this point, so a hull-bookkeeping hiccup must not turn a good run
    // into a thrown error.
    try {
      this.hullState.damage(m.shipId, ship.hull, res.hullDamage!);
    } catch (e) {
      console.error(`hull damage write failed for mission ${m.id}: ${(e as Error).message}`);
    }

    // A completed stage pays the builders back — a separate transaction from
    // the run settlement above; the mission is already done, so an airdrop
    // hiccup must not throw the completed run away.
    let airdrop: { total: number; recipients: number } | undefined;
    if (stageCompleted) {
      try { airdrop = this.airdropStage(); } catch (e) {
        console.error(`stage airdrop failed after ${m.id}: ${(e as Error).message}`);
      }
    }

    return { rewardGold, crewShares, fuelBurned, delivered, stageCompleted, outcome: 'landed', airdrop };
  }

  // When a settlement stage completes, split a pool — the GOLD the settlement
  // collected in fees plus a minted STAGE_BONUS — among builders in proportion
  // to value delivered but not yet paid for. Off-chain: it lands in each
  // wallet's ledger balance, claimable via the normal flow.
  private airdropStage(): { total: number; recipients: number } {
    const unpaid = this.contributions.unpaid();
    const totalUnpaid = unpaid.reduce((s, u) => s + u.unpaid, 0);
    if (totalUnpaid <= 0) return { total: 0, recipients: 0 };
    const fees = this.ledger.balance('settlement', 'GOLD');
    const pool = fees + STAGE_BONUS;
    if (pool <= 0) return { total: 0, recipients: 0 };
    const shares = unpaid.map((u) => ({ wallet: u.wallet, gold: Math.floor((pool * u.unpaid) / totalUnpaid) }));
    // Largest-remainder: the rounding dust goes to the top contributor so the
    // legs sum exactly to the pool (zero-sum).
    shares[0].gold += pool - shares.reduce((s, x) => s + x.gold, 0);
    const legs: Leg[] = [];
    if (STAGE_BONUS > 0) legs.push({ account: 'mint', token: 'GOLD', amount: -STAGE_BONUS });
    if (fees > 0) legs.push({ account: 'settlement', token: 'GOLD', amount: -fees });
    for (const s of shares) if (s.gold > 0) legs.push({ account: `wallet:${s.wallet}`, token: 'GOLD', amount: s.gold });
    this.db.transaction(() => {
      this.ledger.post('settlement airdrop', legs);
      this.contributions.markPaid();
    })();
    return { total: pool, recipients: shares.filter((s) => s.gold > 0).length };
  }

  fail(id: string, fuelSpent = 0, ammoSpent = 0): void {
    const m = this.get(id);
    if (!m || m.status !== 'active') throw new Error(`mission ${id} is not active`);
    if (!Number.isFinite(fuelSpent) || fuelSpent < 0) {
      throw new Error('fuelSpent must be a non-negative number');
    }
    if (!Number.isFinite(ammoSpent) || ammoSpent < 0) {
      throw new Error('ammoSpent must be a non-negative number');
    }
    const legs = this.failLegs(m, fuelSpent, ammoSpent);
    this.db.transaction(() => {
      this.ledger.post(`mission failed ${m.id}`, legs);
      this.save({ ...m, status: 'failed' });
    })();
  }
}
