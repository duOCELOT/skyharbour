// Headless playthrough: drives the dev-mode server via app.inject the way a
// pilot would — dock, hire, accept, fly (fire events the server resolves),
// complete — and raises tokens. Also a live end-to-end check of the
// server-authoritative run + the economy balancing. Run: npm run play
import { buildApp } from '../src/app.js';
import { raiderTimeline, cannonCooldown, attackSkill } from '../../client/flightMath.js';
import { minFuel } from '../src/validation.js';
import type { CrewMember } from '../src/fleet.js';

const app = buildApp({ dbPath: ':memory:' }); // dev mode: x-wallet auth, DevFleet
const H = { 'x-wallet': 'alice' };
const j = async (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  (await app.inject({ method, url, headers: H, payload: payload as any })).json();

const money = (b: any) => `GOLD ${b.GOLD} · FUEL ${b.FUEL} · AMMO ${b.AMMO ?? 0}` +
  ['LOG', 'MINERAL', 'FURNITURE', 'FIRERUNE'].filter((t) => b[t]).map((t) => ` · ${t} ${b[t]}`).join('');

async function main() {
  const login = await j('POST', '/login');
  console.log(`docked as ${login.wallet} — ships: ${login.ships.map((s: any) => `${s.id}(cargo ${s.cargo},eng ${s.engine},slots ${s.crewSlots})`).join(', ')}`);
  console.log(`own crew: ${login.crew.map((c: any) => `${c.id}[${JSON.stringify(c.skills)}]`).join(', ') || 'none'}`);
  const market = await j('GET', '/crew/market');
  console.log(`market: ${market.map((l: any) => `${l.crewId} ${l.sharePct}% ${JSON.stringify(l.member?.skills ?? l.skills)}`).join(' | ') || 'empty'}`);
  console.log(`start:  ${money(await j('GET', '/balances'))}\n`);

  // Pick the biggest-cargo ship and fill its crew slots with the best hands we
  // can: own crew fly free; else hire market crew, preferring fuel then attack.
  const ship = [...login.ships].sort((a: any, b: any) => b.cargo - a.cargo)[0];
  const ownCrew = login.crew.map((c: any) => ({ id: c.id, member: c as CrewMember, sharePct: 0 }));
  const mktCrew = market.map((l: any) => ({ id: l.crewId, member: (l.member ?? l) as CrewMember, sharePct: l.sharePct }));
  const pool = [...ownCrew, ...mktCrew];
  const sk = (c: any, k: string) => c.member.skills?.[k] ?? 0;
  // Fill fuel to the 50 cap (cheapest cuts fuel cost most), then buy DEFENSE to
  // survive rock/raider hits (voids were killing runs), then whatever's left.
  const crew: any[] = [];
  const take = (cand: any[]) => { for (const c of cand) { if (crew.length >= ship.crewSlots) break; if (!crew.includes(c)) crew.push(c); } };
  const fuelCrew = pool.filter((c) => sk(c, 'fuel') > 0).sort((a, b) => (sk(b, 'fuel') - sk(a, 'fuel')) || (a.sharePct - b.sharePct));
  let fsum = 0; for (const c of fuelCrew) { if (crew.length >= ship.crewSlots || fsum >= 50) break; crew.push(c); fsum += sk(c, 'fuel'); }
  take(pool.filter((c) => sk(c, 'defense') > 0).sort((a, b) => sk(b, 'defense') - sk(a, 'defense')));
  take([...pool].sort((a, b) => a.sharePct - b.sharePct));
  const crewIds = crew.map((c) => c.id);
  const crewMembers = crew.map((c) => c.member);
  console.log(`flying ${ship.id} with crew [${crewIds.join(', ') || 'solo'}] — fuelSkill total ${crewMembers.reduce((s, c: any) => s + (c.skills?.fuel ?? 0), 0)}, share ${crew.reduce((s, c) => s + c.sharePct, 0)}%\n`);

  const cooldown = cannonCooldown(attackSkill(crewMembers)); // seconds between accepted shots
  let raised = 0, flown = 0;

  const dmg0 = 1 + Math.floor(attackSkill(crewMembers) / 25);
  const shotsPerRaider = Math.ceil(2 / dmg0);
  for (let round = 1; round <= 12; round++) {
    let bal = await j('GET', '/balances');
    // keep a working reserve of fuel + shells; a run needs shotsPerRaider×3 shells
    if (bal.FUEL < 300 && bal.GOLD > 45) { await j('POST', '/fuel/buy', { gold: Math.min(70, bal.GOLD - 25) }); }
    if ((bal.AMMO ?? 0) < shotsPerRaider * 3 && bal.GOLD > 20) { await j('POST', '/ammo/buy', { gold: 5 }); }
    bal = await j('GET', '/balances');

    const generated = await j('POST', '/missions/generate', { count: 6 });
    const board: any[] = Array.isArray(generated) && generated.length ? generated : await j('GET', '/missions');
    // score by expected net = reward − fuel cost − fee; only take runs we can
    // fuel AND whose raiders we have shells to kill (unkilled raiders = spill/void)
    const scored = board
      .filter((m) => m.status === 'open')
      .map((m) => {
        const fuel = minFuel(m.distance, crewMembers);
        const raiders = m.distance <= 120 ? 0 : 3; // worst case; be conservative on shells
        const net = m.rewardGold - Math.ceil(fuel / 4) - m.feeGold;
        return { m, fuel, needShells: raiders * shotsPerRaider, net };
      })
      .filter((x) => x.fuel <= bal.FUEL && x.m.feeGold <= bal.GOLD && x.needShells <= (bal.AMMO ?? 0) && x.net > 0)
      .sort((a, b) => b.net - a.net);
    if (!scored.length) { console.log(`round ${round}: nothing affordable/profitable — stop`); break; }
    const { m, fuel } = scored[0];

    await j('POST', `/missions/${m.id}/accept`, { shipId: ship.id, crewIds });

    // Build a fire trace that kills every raider inside its engage window:
    // hp 2, cannonDamage from attack skill → shotsToKill shots each, spaced ≥
    // cooldown globally (one cannon), each within [engageStart, attackAt].
    const tl = raiderTimeline(m.id, m.distance, m.cargo, ship.engine);
    const dmg = 1 + Math.floor(attackSkill(crewMembers) / 25);
    const shotsToKill = Math.ceil(2 / dmg);
    const fireEvents: { t: number; raider: number }[] = [];
    let lastT = -100;
    for (let i = 0; i < tl.length; i++) {
      for (let k = 0; k < shotsToKill; k++) {
        const t = Math.max(tl[i].engageStart + 0.05, lastT + cooldown + 0.05);
        if (t <= tl[i].attackAt) { fireEvents.push({ t, raider: i }); lastT = t; }
      }
    }
    fireEvents.sort((a, b) => a.t - b.t);

    const before = (await j('GET', '/balances')).GOLD;
    const payout = await j('POST', `/missions/${m.id}/complete`, { fireEvents });
    const after = await j('GET', '/balances');
    const delta = after.GOLD - before;
    raised += delta; flown++;
    console.log(
      `round ${round}: ${m.cargo}×${m.amount} d${m.distance} (fuel ${fuel}, reward ${m.rewardGold}G) → ` +
      `${payout.outcome?.toUpperCase()} delivered ${payout.delivered ?? 0}, +${payout.rewardGold ?? 0}G reward, GOLD Δ${delta >= 0 ? '+' : ''}${delta}`,
    );
  }

  const fin = await j('GET', '/balances');
  console.log(`\nflew ${flown} runs · net GOLD raised ${raised >= 0 ? '+' : ''}${raised}`);
  console.log(`FINAL:  ${money(fin)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
