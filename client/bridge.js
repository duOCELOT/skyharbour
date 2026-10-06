import { getWallet, setWallet, clearWallet, getSession, setSession, clearSession, login, balances, missions, generateMissions, acceptMission, failMission, settlement, leaderboard, crewMarket, buyFuel, buyAmmo, missionsMine, authNonce, authVerify, claim, claimsList, repairShip, buyGold, solPayForGold } from './api.js';
import { renderTicker, renderManifest, renderBoard, renderPanel, renderSettlement, renderLeaderboard, renderCrewMarket, renderGhostRuns, renderShipSpecs, renderHold, renderShipSwitcher, escapeHtml } from './render.js';
import { makeCrt } from './crt.js';
import { haulingSkill, minFuelClient } from './flightMath.js';

const $ = (id) => document.getElementById(id);

// SOL on-ramp (plan 2): devnet RPC endpoint for the client-built transfer.
// /login does not expose an rpc field — this is the fixed devnet default.
const DEVNET_RPC = 'https://api.devnet.solana.com';

// Paid-but-uncredited SOL purchases survive here until the server confirms
// them. The instant Phantom submits the transfer we record the signature, so
// a slow/failed on-chain verify can never lose a payment — drainPendingGold()
// re-posts pending signatures (idempotent server-side) on login and on the
// next buy until each credits.
const PENDING_KEY = 'sh_pending_sol';
const pendingSigs = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; } };
const addPending = (sig) => { const s = new Set(pendingSigs()); s.add(sig); localStorage.setItem(PENDING_KEY, JSON.stringify([...s])); };
const removePending = (sig) => localStorage.setItem(PENDING_KEY, JSON.stringify(pendingSigs().filter((x) => x !== sig)));

async function drainPendingGold() {
  const sigs = pendingSigs();
  if (!sigs.length) return;
  for (const sig of sigs) {
    try {
      const r = await buyGold(sig);
      removePending(sig);
      crt.comm('TELLER', `Recovered ${r.gold} gold from a pending payment.`);
    } catch (e) {
      if (/already credited/.test(String(e?.message || e))) removePending(sig); // else keep, retry later
    }
  }
  await refreshEconomy();
}

// The bridge monitor (part3 CRT): green-dot image renders + comms/log lines.
const crt = makeCrt('crt-screen', 'crt-comms');

// Map a ship to a portrait for the monitor. Real NFT art (from the registry's
// image URL) will replace these local placeholders once minted.
function shipImage(ship) {
  const kind = (ship?.id || '').split('-').pop();
  if (kind === 'courier') return 'ships/2.png';
  if (kind === 'freighter') return 'ships/3.png';
  return 'ships/1.png'; // hauler + anything else
}
const CARGO_IMAGE = { FIRERUNE: 'img/firerune.png' };
let session = null; // { wallet, ships, crew, granted, chain, treasury }
let selectedShipId = null;
let busy = false; // true while a mission is escrowed/flying — blocks a second ACCEPT
let lastMarket = []; // cached crew-market listings, refreshed by refreshCrew()
let selectedMissionId = null; // the contract picked on the board, previewed in the loadout bay
let lastBoard = []; // cached open missions, so the loadout bay can look up the selected one

function say(text) { $('account').textContent = text; }

// A Solana wallet has no username — Phantom only exposes the public key. Show a
// truncated key (ArGb…5fvm) so a 44-char base58 string never deforms the bar,
// and let the pilot set a callsign (click the account line) shown in its place.
const CALLSIGN_KEY = 'sh-callsign';
const getCallsign = () => localStorage.getItem(CALLSIGN_KEY) || '';
const shortWallet = (w) => (w && w.length > 16 ? `${w.slice(0, 4)}…${w.slice(-4)}` : (w || ''));
const pilotName = () => getCallsign() || shortWallet(session?.wallet ?? '');

const selectedShip = () => session?.ships.find((s) => s.id === selectedShipId) ?? session?.ships[0];
const selectedMission = () => lastBoard.find((m) => m.id === selectedMissionId && m.status === 'open') ?? null;

// The crew ticked on the CREW screen, skills resolved from the session (own
// crew) or the cached market listings (hired) — feeds the loadout + the launch.
function checkedCrewInfo() {
  return [...document.querySelectorAll('#crew-mount input:checked')].map((el) => {
    const id = el.dataset.crew;
    const own = session?.crew.find((k) => k.id === id);
    const listed = lastMarket.find((l) => l.crewId === id);
    return { id, skills: own?.skills ?? listed?.skills ?? {} };
  });
}

// Redraw the loadout bay (SHIP screen): fleet switcher, specs, the cargo hold
// for the selected contract, the top-view blueprint, and the LAUNCH state.
function refreshShipView() {
  if (!session) return;
  const ship = selectedShip();
  const mission = selectedMission();
  const crew = checkedCrewInfo().map((c) => ({ skills: c.skills }));
  if ($('ship-switcher')) $('ship-switcher').innerHTML = renderShipSwitcher(session.ships, ship?.id);
  if ($('ship-specs')) $('ship-specs').innerHTML = renderShipSpecs(ship);
  if ($('ship-hold')) $('ship-hold').innerHTML = renderHold(ship, mission, crew);
  drawBlueprint($('ship-blueprint'), ship, mission, crew);
  const launch = $('launch-btn');
  if (launch) {
    const loaded = ship && mission ? Math.min(ship.cargo + haulingSkill(crew), mission.amount) : 0;
    launch.disabled = busy || !ship || !mission;
    launch.textContent = !ship ? 'NO SHIP' : !mission ? 'SELECT A CONTRACT' : busy ? 'BRIDGE BUSY' : `LAUNCH — ${mission.cargo} ×${loaded}`;
  }
}

// Top-view schematic: a fuselage scaled by cargo, a cargo bay that fills with
// the selected contract's load, a bridge module (crew slots), engine nacelles.
function drawBlueprint(cv, ship, mission, crew) {
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(devicePixelRatio, 2);
  const W = cv.clientWidth || 260, H = cv.clientHeight || 150;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!ship) return;
  const P = (a = 1) => `rgba(65,255,122,${a})`;
  const GOLD = 'rgba(245,193,75,0.9)';
  const cx = W / 2, cy = H / 2;
  const bodyW = Math.min(W * 0.44, 34 + ship.cargo * 0.7), bodyH = H * 0.74;
  const top = cy - bodyH / 2, bot = cy + bodyH / 2;
  ctx.strokeStyle = P(0.85); ctx.lineWidth = 1.5; ctx.fillStyle = P(0.04);
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx + bodyW / 2, top + bodyH * 0.22);
  ctx.lineTo(cx + bodyW / 2, bot - bodyH * 0.12);
  ctx.lineTo(cx + bodyW * 0.32, bot);
  ctx.lineTo(cx - bodyW * 0.32, bot);
  ctx.lineTo(cx - bodyW / 2, bot - bodyH * 0.12);
  ctx.lineTo(cx - bodyW / 2, top + bodyH * 0.22);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = P(0.6);
  for (let i = 0; i < ship.crewSlots; i++) {
    const bx = cx - (ship.crewSlots - 1) * 6 + i * 12;
    ctx.strokeRect(bx - 3, top + bodyH * 0.16, 6, 8);
  }
  const nac = Math.min(4, Math.max(2, Math.round(ship.engine / 5)));
  for (let i = 0; i < nac; i++) {
    const ex = cx - (nac - 1) * 8 + i * 16;
    ctx.strokeStyle = P(0.7); ctx.strokeRect(ex - 4, bot - 6, 8, 10);
    ctx.strokeStyle = P(0.35); ctx.beginPath(); ctx.moveTo(ex, bot + 4); ctx.lineTo(ex, bot + 12); ctx.stroke();
  }
  const cap = ship.cargo + haulingSkill(crew);
  const loaded = mission ? Math.min(cap, mission.amount) : 0;
  const cols = 4, bayX = cx - bodyW * 0.36, bayY = top + bodyH * 0.34, bayW = bodyW * 0.72, bayH = bodyH * 0.42;
  const shown = Math.min(cap, cols * 8), rowsShown = Math.max(1, Math.ceil(shown / cols));
  const cw = bayW / cols, ch = bayH / rowsShown;
  ctx.strokeStyle = P(0.22); ctx.strokeRect(bayX, bayY, bayW, bayH);
  for (let i = 0; i < shown; i++) {
    const x = bayX + (i % cols) * cw + 1.5, y = bayY + Math.floor(i / cols) * ch + 1.5, w = cw - 3, h = ch - 3;
    if (i < loaded) { ctx.fillStyle = mission?.cargo === 'FIRERUNE' ? GOLD : P(0.55); ctx.fillRect(x, y, w, h); }
    else { ctx.strokeStyle = P(0.14); ctx.strokeRect(x, y, w, h); }
  }
  ctx.fillStyle = P(0.5); ctx.font = '9px Tektur, monospace'; ctx.textAlign = 'center';
  ctx.fillText(mission ? `${loaded}/${cap}` : `CAP ${cap}`, cx, bot + 22);
}

export async function refreshEconomy() {
  if (!getWallet()) return;
  const [bal, st, lb] = await Promise.all([balances(), settlement(), leaderboard()]);
  $('ticker').textContent = renderTicker(bal);
  $('manifest-mount').innerHTML = renderManifest(bal);
  const ship = session?.ships.find((s) => s.id === selectedShipId);
  $('panel-readout').innerHTML = renderPanel(bal, st, ship);
  // The SETTLEMENT screen (a console channel on the big display) shows the
  // full build meter + the leaderboard; the panel keeps the compact meter.
  const smount = $('settlement-mount');
  if (smount) smount.innerHTML = renderSettlement(st);
  const lmount = $('leaderboard-mount');
  if (lmount) lmount.innerHTML = renderLeaderboard(lb, session?.wallet);
}

async function refreshBoard() {
  if (!getWallet()) return;
  lastBoard = await missions();
  if (selectedMissionId && !lastBoard.some((m) => m.id === selectedMissionId && m.status === 'open')) selectedMissionId = null;
  $('missions-mount').innerHTML = renderBoard(lastBoard);
  for (const btn of document.querySelectorAll('#missions-mount .select-btn')) {
    const on = btn.dataset.mission === selectedMissionId;
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'SELECTED' : 'SELECT';
  }
}

async function refreshCrew() {
  if (!session) return;
  lastMarket = await crewMarket();
  $('crew-mount').innerHTML = renderCrewMarket(lastMarket, session.crew);
}

async function completeLogin() {
  try {
    session = await login();
    say(`DOCKED: ${pilotName().toUpperCase()}${session.demo ? ' · DEMO' : ''}${session.granted ? ' — STARTER GRANT ISSUED' : ''}`);
    selectedShipId = session.ships[0]?.id ?? null;
    selectedMissionId = null;
    refreshShipView();
    crt.comm('HARBOURMASTER', `Welcome to the bridge, ${pilotName()}.`);
    if (session.granted) crt.comm('QUARTERMASTER', 'Starter grant issued — fuel, shells, and coin aboard.');
    if (session.demo) crt.comm('HARBOURMASTER', 'Demo harbour — your progress is saved in this browser. Wallet claims open on the live server.');
    const first = session.ships.find((s) => s.id === selectedShipId);
    if (first) crt.showImage(shipImage(first));
    $('ghosts-mount').innerHTML = renderGhostRuns(await missionsMine());
    // Claiming only makes sense once there's a chain to claim onto — the
    // server tells us via /login's `chain` flag (dev mode never mints).
    $('claim-button').disabled = !session.chain;
    await Promise.all([refreshEconomy(), refreshBoard(), refreshCrew()]);
    await drainPendingGold(); // repay any purchase charged on-chain but not yet credited
  } catch (e) {
    say(`DOCKING REFUSED: ${e.message.toUpperCase()}`);
    clearWallet();
    clearSession();
    $('claim-button').disabled = true;
  }
}

async function doLogin() {
  if (window.solana?.isPhantom) {
    try {
      const { publicKey } = await window.solana.connect();
      const pub = publicKey.toBase58();
      const { message } = await authNonce(pub);
      const sig = await window.solana.signMessage(new TextEncoder().encode(message), 'utf8');
      const { session: token } = await authVerify(pub, btoa(String.fromCharCode(...sig.signature)));
      setWallet(pub);
      setSession(token);
      await completeLogin();
      return;
    } catch {
      say('WALLET REFUSED — DEV DOCKING');
    }
  }
  const name = getWallet() ?? prompt('Pilot name (dev wallet — Phantom arrives with the chain gateway):', 'alice');
  if (!name) return;
  setWallet(name.trim());
  await completeLogin();
}

// Click the account line while docked to set/clear a callsign (a display name
// saved in this browser, shown instead of the truncated wallet key).
$('account').addEventListener('click', () => {
  if (!session) return;
  const cs = prompt('Set your callsign (blank shows your wallet):', getCallsign());
  if (cs === null) return;
  const v = cs.trim();
  if (v) localStorage.setItem(CALLSIGN_KEY, v); else localStorage.removeItem(CALLSIGN_KEY);
  say(`DOCKED: ${pilotName().toUpperCase()}${session.demo ? " · DEMO" : ""}`);
});

$('sign-in-button').addEventListener('click', doLogin);
$('sign-out-button').addEventListener('click', () => {
  clearWallet(); clearSession(); session = null;
  $('claim-button').disabled = true;
  say('SKY HARBOUR BRIDGE — DOCK IN, PILOT');
});

$('generate-btn')?.addEventListener('click', async () => {
  if (!session) { say('DOCK IN FIRST, PILOT'); return; }
  try { await generateMissions(3); await refreshBoard(); crt.comm('BOARD', 'Fresh contracts pinned to the board.'); }
  catch (e) { say(e.message.toUpperCase()); }
});

// Loadout bay: clicking a ship chip selects it; the blueprint/specs/hold update.
$('ship-switcher')?.addEventListener('click', (ev) => {
  const chip = ev.target.closest?.('.ship-chip[data-ship]');
  if (!chip || !session) return;
  selectedShipId = chip.dataset.ship;
  refreshShipView();
  const ship = selectedShip();
  if (ship) { crt.showImage(shipImage(ship)); crt.comm('DECKHAND', `${ship.id.toUpperCase().replace(/^SH-\d+\s*/, '')} on the pad — hull ${ship.currentHull ?? ship.hull}/${ship.hull}.`); }
});

// CREW screen: (un)ticking a hand re-prices the loadout (hauling → hold, fuel → range).
$('crew-mount')?.addEventListener('change', () => refreshShipView());

// Hangar: REPAIR buys hull back up to max with GOLD, then refreshes the
// ticker/manifest (GOLD spent) and re-renders the hangar (HULL cur/max,
// button disappears once the ship is whole).
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest?.('[data-repair]');
  if (!btn || !session) return;
  const shipId = btn.dataset.repair;
  const ship = session.ships.find((s) => s.id === shipId);
  if (!ship) return;
  try {
    const result = await repairShip(shipId, ship.hull);
    ship.currentHull = result.hull;
    refreshShipView();
    await refreshEconomy();
  } catch (e) { say(String(e.message || e).toUpperCase()); }
});

// MISSION board: SELECT a contract → preview it in the loadout bay (SHIP screen).
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('.select-btn');
  if (!btn || !session) return;
  selectedMissionId = btn.dataset.mission;
  for (const b of document.querySelectorAll('#missions-mount .select-btn')) {
    const on = b.dataset.mission === selectedMissionId;
    b.classList.toggle('active', on); b.textContent = on ? 'SELECTED' : 'SELECT';
  }
  refreshShipView();
  document.querySelector('.item_button[data-slug="ship"]')?.click(); // jump to the loadout bay
  const m = selectedMission();
  if (m) crt.comm('DISPATCH', `${m.cargo}×${m.amount} from ${m.origin} — ${m.distance} out. Rig the hold, ${pilotName()}.`);
});

// LAUNCH (from the loadout bay): accept the selected contract with the current
// ship + crew, then hand off to the flight overlay.
$('launch-btn')?.addEventListener('click', async () => {
  if (!session || busy) { if (busy) say('BRIDGE BUSY — FINISH THE CURRENT RUN'); return; }
  const ship = selectedShip();
  const mission0 = selectedMission();
  if (!ship) { say('NO SHIP NFT — NOTHING TO FLY'); return; }
  if (!mission0) { say('SELECT A CONTRACT FIRST'); return; }
  const checked = [...document.querySelectorAll('#crew-mount input:checked')];
  if (checked.length > ship.crewSlots) say(`ONLY ${ship.crewSlots} CREW SLOTS — EXTRAS LEFT AT THE DOCK`);
  const crewIds = checked.map((el) => el.dataset.crew).slice(0, ship.crewSlots);
  busy = true; refreshShipView();
  try {
    const mission = await acceptMission(mission0.id, ship.id, crewIds);
    // skills for own crew come from the session; hired crew from the cached market listings
    const crew = (mission.crewTerms ?? []).map((t) => {
      const own = session.crew.find((k) => k.id === t.crewId);
      const listed = lastMarket.find((l) => l.crewId === t.crewId);
      return { id: t.crewId, skills: own?.skills ?? listed?.skills ?? {} };
    });
    crt.comm('DISPATCH', `${mission.cargo}×${mission.amount} — ${mission.distance} out. Fly true, ${pilotName()}.`);
    if (CARGO_IMAGE[mission.cargo]) crt.showImage(CARGO_IMAGE[mission.cargo]);
    selectedMissionId = null;
    await Promise.all([refreshEconomy(), refreshBoard()]);
    window.dispatchEvent(new CustomEvent('sh:launch', { detail: { mission, ship, crew } }));
  } catch (e) { say(e.message.toUpperCase()); busy = false; refreshShipView(); }
});

// Abandon a ghost run — a mid-flight reload leaves it active; forfeit the fee to bail out.
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest?.('.abandon-btn');
  if (!btn || !session) return;
  try {
    await failMission(btn.dataset.mission, 0);
    say('GHOST RUN ABANDONED — FEE FORFEITED');
    $('ghosts-mount').innerHTML = renderGhostRuns(await missionsMine());
    await Promise.all([refreshEconomy(), refreshBoard()]);
  } catch (e) { say(String(e.message || e).toUpperCase()); }
});

// Provisions: buy fuel or ammo with gold at the hangar console. Buttons carry
// data-token="FUEL"|"AMMO" so one handler covers both pumps.
const PUMP_TOKENS = {
  FUEL: { buy: buyFuel, say: (r) => `TANKS +${r.fuelCredited} FUEL` },
  AMMO: { buy: buyAmmo, say: (r) => `MAGAZINE +${r.credited} SHELLS` },
};
document.addEventListener('click', async (ev) => {
  const pump = ev.target.closest?.('.pump-btn');
  if (!pump) return;
  if (!session) { say('DOCK IN FIRST, PILOT'); return; }
  const token = PUMP_TOKENS[pump.dataset.token];
  if (!token) return;
  try {
    const r = await token.buy(Number(pump.dataset.gold));
    say(token.say(r));
    crt.comm(pump.dataset.token === 'AMMO' ? 'ARMORER' : 'DECKHAND', token.say(r).toLowerCase() + ' — squared away.');
    await refreshEconomy();
  } catch (e) { say(String(e.message || e).toUpperCase()); }
});

// Claim manifest: file every claimable balance, then show the last 3 claims.
$('claim-button').addEventListener('click', async () => {
  if (!session) { say('DOCK IN FIRST, PILOT'); return; }
  try {
    const bal = await balances();
    const claimable = Object.entries(bal).filter(([, v]) => v > 0);
    if (!claimable.length) { say('NOTHING TO CLAIM'); return; }
    let total = 0;
    for (const [t] of claimable) { const r = await claim(t); total += r.amount; }
    say(`CLAIM FILED — ${total} TOKENS QUEUED FOR THE CHAIN`);
    const rows = (await claimsList()).slice(0, 3);
    $('claims-mount').innerHTML = rows.map((c) =>
      `<p class="manifest-line">${escapeHtml(c.token)} ${escapeHtml(c.amount)} <span class="dots"></span> <b>${escapeHtml(c.status).toUpperCase()}</b></p>`).join('');
    await refreshEconomy();
  } catch (e) { say(String(e.message || e).toUpperCase()); }
});

// The 3x3 physical console buttons — quick commands that mirror the actions
// otherwise scattered across the panels. Each cell carries data-cmd.
const needDock = () => { if (!session) { say('DOCK IN FIRST, PILOT'); return false; } return true; };

const CONSOLE_CMDS = {
  dock: () => doLogin(),
  postings: async () => { if (!needDock()) return; await generateMissions(3); await refreshBoard(); say('NEW POSTINGS ON THE BOARD'); crt.comm('BOARD', 'Fresh contracts pinned to the board.'); },
  refuel: async () => { if (!needDock()) return; const r = await buyFuel(25); say(`TANKS +${r.fuelCredited} FUEL`); crt.comm('DECKHAND', `Tanks topped +${r.fuelCredited} fuel.`); await refreshEconomy(); },
  rearm: async () => { if (!needDock()) return; const r = await buyAmmo(25); say(`MAGAZINE +${r.credited} SHELLS`); crt.comm('ARMORER', `Magazine loaded +${r.credited} shells.`); await refreshEconomy(); },
  repair: async () => {
    if (!needDock()) return;
    const ship = session.ships.find((s) => s.id === selectedShipId) ?? session.ships[0];
    if (!ship) { say('NO SHIP TO REPAIR'); return; }
    const result = await repairShip(ship.id, ship.hull);
    ship.currentHull = result.hull;
    refreshShipView();
    say(result.spent > 0 ? `HULL PATCHED — ${result.spent} G` : `${ship.id.toUpperCase()} ALREADY WHOLE`);
    crt.comm('FITTER', result.spent > 0 ? `Hull patched — ${result.spent} gold, good as new.` : `${ship.id.toUpperCase()} already whole.`);
    await refreshEconomy();
  },
  // HANGAR BAY: one button that opens a chooser on the green monitor —
  // refuel / rearm / repair each fire their existing command via data-cmd.
  hangarbay: () => {
    if (!needDock()) return;
    const menu = $('crt-menu');
    menu.innerHTML = `
      <p class="menu-title">HANGAR BAY</p>
      <button class="menu-btn" data-cmd="refuel">REFUEL · 25 G → FUEL</button>
      <button class="menu-btn" data-cmd="rearm">REARM · 25 G → SHELLS</button>
      <button class="menu-btn" data-cmd="repair">REPAIR HULL</button>
      <button class="menu-btn menu-close" data-cmd="hangarclose">CLOSE</button>`;
    menu.hidden = false;
    crt.comm('DECKHAND', 'Hangar bay open — pick a service.');
  },
  hangarclose: () => { $('crt-menu').hidden = true; },
  claim: () => { if (needDock()) $('claim-button').click(); },
  buygold: async () => {
    if (!needDock()) return;
    if (!session.treasury) { say('SOL PURCHASE NEEDS CHAIN MODE'); crt.comm('TELLER', 'No treasury on this bridge — SOL purchase is chain-mode only.'); return; }
    await drainPendingGold(); // settle anything still owed before spending again
    let sig;
    try {
      say('AWAITING WALLET — 0.1 SOL');
      sig = await solPayForGold(DEVNET_RPC, session.treasury, session.wallet, 100_000_000);
    } catch (e) {
      const msg = String(e?.message || e);
      say(msg.toUpperCase());
      crt.comm('TELLER', `Purchase not started — ${msg}`);
      return;
    }
    // Paid on-chain. Record the signature BEFORE crediting — a slow/failed
    // verify must never lose the payment; drainPendingGold retries it.
    addPending(sig);
    say('PAID — VERIFYING ON CHAIN…');
    try {
      const r = await buyGold(sig);
      removePending(sig);
      say(`+${r.gold} GOLD`);
      crt.comm('TELLER', `${r.gold} gold credited — 0.1 SOL cleared.`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/already credited/.test(msg)) removePending(sig);
      say('VERIFY PENDING — WILL RETRY');
      crt.comm('TELLER', `Paid — verification is lagging; your signature is kept and will credit on retry. (${msg})`);
    }
    await refreshEconomy();
  },
};

document.addEventListener('click', async (ev) => {
  const cell = ev.target.closest?.('[data-cmd]');
  if (!cell) return;
  const cmd = CONSOLE_CMDS[cell.dataset.cmd];
  if (!cmd) return;
  cell.classList.add('pressed');
  setTimeout(() => cell.classList.remove('pressed'), 150);
  try { await cmd(); } catch (e) { say(String(e.message || e).toUpperCase()); }
});

// Auto-dock if a dev wallet is already stored.
if (getWallet()) doLogin();

window.addEventListener('sh:done', async () => {
  crt.comm('BRIDGE', 'Run logged. The settlement thanks you, pilot.');
  const ship = session?.ships.find((s) => s.id === selectedShipId);
  if (ship) crt.showImage(shipImage(ship));
  await Promise.all([refreshEconomy(), refreshBoard(), refreshCrew()]);
});
window.addEventListener('sh:done', () => { busy = false; refreshShipView(); });
window.addEventListener('sh:scrubbed', () => { busy = false; refreshShipView(); });

// Channel changes retune the monitor: crew portrait on CREW, void chart on
// VOID CHART, the selected ship in the HANGAR, else the resting sweep.
window.addEventListener('hashchange', () => {
  const ch = location.hash.replace('#', '');
  if (ch === 'crew') crt.showImage('img/crew.png');
  else if (ch === 'voidchart') crt.showImage('img/routes.png');
  else if (ch === 'ship') {
    const ship = session?.ships.find((s) => s.id === selectedShipId) ?? session?.ships[0];
    if (ship) crt.showImage(shipImage(ship)); else crt.idle();
  } else crt.idle();
});
