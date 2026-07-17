// Pure HTML-string renderers for the console channels. No DOM access here —
// bridge.js owns the document. Every data string passes through escapeHtml.
import { haulingSkill, minFuelClient } from './flightMath.js';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const CARGO = ['LOG', 'MINERAL', 'FURNITURE', 'FIRERUNE'];

export function renderTicker(bal) {
  const parts = [`FUEL ${escapeHtml(bal.FUEL ?? 0)}`, `AMMO ${escapeHtml(bal.AMMO ?? 0)}`, `GOLD ${escapeHtml(bal.GOLD ?? 0)}`];
  for (const t of CARGO) if (bal[t]) parts.push(`${t} ${escapeHtml(bal[t])}`);
  return parts.join(' · ');
}

export function renderManifest(bal) {
  const rows = [['GOLD', bal.GOLD ?? 0], ['FUEL', bal.FUEL ?? 0], ['AMMO', bal.AMMO ?? 0]];
  for (const t of CARGO) if (bal[t]) rows.push([t, bal[t]]);
  return rows.map(([t, v]) =>
    `<p class="manifest-line">${escapeHtml(t)} <span class="dots"></span> <b>${escapeHtml(v)}</b></p>`).join('');
}

export function renderHangar(ships) {
  if (!ships.length) return '<p class="card-description">NO SHIP NFT ON THIS WALLET — THE HARBOUR HAS NOTHING TO GRANT.</p>';
  return ships.map((s) => {
    const cur = s.currentHull ?? s.hull;
    const repair = cur < s.hull
      ? ` <button class="repair-btn console-btn" data-repair="${escapeHtml(s.id)}">REPAIR</button>` : '';
    return `
    <div class="frame-part" data-ship="${escapeHtml(s.id)}">
      <div class="card-details">
        <p class="card-name">${escapeHtml(s.id).toUpperCase()}</p>
        <p class="card-description">ENGINE ${escapeHtml(s.engine)} · CARGO ${escapeHtml(s.cargo)} · BRIDGE ${escapeHtml(s.crewSlots)}</p>
        <p class="card-description">HULL ${escapeHtml(cur)}/${escapeHtml(s.hull)}${repair}</p>
      </div>
    </div>`;
  }).join('');
}

export function renderBoard(missions) {
  const open = missions.filter((m) => m.status === 'open');
  if (!open.length) {
    return '<p class="card-description">NO CONTRACTS — THE SETTLEMENT WANTS FOR NOTHING. GENERATE A POSTING.</p>';
  }
  const rows = open.map((m) => `
    <tr${m.cargo === 'FIRERUNE' ? ' class="rare"' : ''}>
      <td>${escapeHtml(m.cargo)} ×${escapeHtml(m.amount)}</td>
      <td>${escapeHtml(m.origin).toUpperCase()}</td>
      <td class="n">${escapeHtml(m.distance)}</td>
      <td class="n gold">${escapeHtml(m.rewardGold)} G</td>
      <td class="n">${escapeHtml(m.feeGold)} G</td>
      <td><button class="select-btn" data-mission="${escapeHtml(m.id)}">SELECT</button></td>
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
  const needLabel = Object.entries(needs).map(([t, n]) => `${escapeHtml(state.received[t] ?? 0)}/${escapeHtml(n)} ${escapeHtml(t)}`).join(' · ');
  return `
    <p class="card-name">SETTLEMENT — STAGE ${escapeHtml(state.stage.index)}</p>
    <div class="meter"><div class="meter-fill" style="width:${pct}%"></div>
      <span class="meter-label">${escapeHtml(state.stage.name).toUpperCase()} — ${needLabel} (${pct}%)</span></div>`;
}

// The always-on control panel (beside the 9 command buttons): a compact
// GOLD/FUEL/AMMO row, the settlement build meter (reuses renderSettlement —
// do not re-implement it here), and the selected ship's hull. `ship` may be
// null/undefined (no wallet, or nothing selected yet) — never throw.
export function renderPanel(bal, settlementState, ship) {
  const b = bal ?? {};
  const balRow = `<p class="panel-balances">GOLD <b>${escapeHtml(b.GOLD ?? 0)}</b> · FUEL <b>${escapeHtml(b.FUEL ?? 0)}</b> · AMMO <b>${escapeHtml(b.AMMO ?? 0)}</b></p>`;
  const meter = renderSettlement(settlementState ?? { stage: null, received: {} });
  const hullLine = ship
    ? `<p class="panel-hull">HULL <b>${escapeHtml(ship.currentHull ?? ship.hull)}/${escapeHtml(ship.hull)}</b></p>`
    : `<p class="panel-hull">HULL <b>—/—</b></p>`;
  return `<div class="panel-readout-inner">${balRow}${meter}${hullLine}</div>`;
}

function skillLabel(skills) {
  const parts = [];
  if (skills?.fuel) parts.push(`FUEL ${escapeHtml(skills.fuel)}`);
  if (skills?.defense) parts.push(`DEF ${escapeHtml(skills.defense)}`);
  if (skills?.attack) parts.push(`ATK ${escapeHtml(skills.attack)}`);
  if (skills?.hauling) parts.push(`HAUL ${escapeHtml(skills.hauling)}`);
  return parts.length ? ` — ${parts.join(' · ')}` : '';
}

export function renderGhostRuns(missions) {
  if (!missions.length) return '';
  const rows = missions.map((m) => `
    <p class="ghost-run">GHOST RUN: ${escapeHtml(m.cargo)} ×${escapeHtml(m.amount)} (D${escapeHtml(m.distance)})
      <button class="abandon-btn console-btn" data-mission="${escapeHtml(m.id)}">ABANDON</button></p>`);
  return `<div class="ghosts">${rows.join('')}</div>`;
}

export function renderCrewMarket(listings, ownCrew) {
  const rows = [
    ...ownCrew.map((c) => `
      <label class="crew-pick"><input type="checkbox" data-crew="${escapeHtml(c.id)}">
        ${escapeHtml(c.id).toUpperCase()}${skillLabel(c.skills)} — SHARE 0% (YOURS)</label>`),
    ...listings.map((l) => `
      <label class="crew-pick"><input type="checkbox" data-crew="${escapeHtml(l.crewId)}">
        ${escapeHtml(l.crewId).toUpperCase()}${skillLabel(l.skills)} — SHARE ${escapeHtml(l.sharePct)}% (OWNER ${escapeHtml(l.owner).toUpperCase()})</label>`),
  ];
  return rows.length ? rows.join('') : '<p class="card-description">NO HANDS FOR HIRE AT THE HARBOUR.</p>';
}

// --- loadout bay (the SHIP screen) ---
// Chain ship ids look like "SH-001 First Pilgrim"; dev ids like "alice-hauler".
// Show the human part.
function shipShortName(id) {
  const s = String(id);
  const m = s.match(/^SH-\d+\s+(.*)$/);
  return (m ? m[1] : s.replace(/^.*-/, '')).toUpperCase();
}

export function renderShipSpecs(ship) {
  if (!ship) return '<p class="card-description">NO SHIP ON THIS WALLET.</p>';
  const cur = ship.currentHull ?? ship.hull;
  const repair = cur < ship.hull ? ` <button class="repair-btn console-btn" data-repair="${escapeHtml(ship.id)}">REPAIR</button>` : '';
  return `<p class="spec-name">${escapeHtml(shipShortName(ship.id))}</p>
    <div class="spec-grid">
      <span>ENGINE</span><b>${escapeHtml(ship.engine)}</b>
      <span>CARGO</span><b>${escapeHtml(ship.cargo)}</b>
      <span>BRIDGE</span><b>${escapeHtml(ship.crewSlots)} slots</b>
      <span>HULL</span><b>${escapeHtml(cur)}/${escapeHtml(ship.hull)}${repair}</b>
    </div>`;
}

export function renderHold(ship, mission, crew) {
  if (!ship) return '';
  const cap = ship.cargo + haulingSkill(crew);
  if (!mission) {
    return `<p class="hold-title">HOLD — CAP ${escapeHtml(cap)}${haulingSkill(crew) ? ` (${escapeHtml(ship.cargo)}+${escapeHtml(haulingSkill(crew))} hauling)` : ''}</p>
      <p class="card-description small">SELECT A CONTRACT ON THE MISSION BOARD TO LOAD THE HOLD.</p>`;
  }
  const loaded = Math.min(cap, mission.amount);
  const overflow = mission.amount - loaded;
  const fuel = minFuelClient(mission.distance, crew);
  const pct = cap ? Math.round((loaded / cap) * 100) : 0;
  return `<p class="hold-title">HOLD — ${escapeHtml(mission.cargo)} ${escapeHtml(loaded)}/${escapeHtml(cap)}${overflow > 0 ? ` <span class="bad">(+${escapeHtml(overflow)} won't fit)</span>` : ''}</p>
    <div class="hold-bar"><div class="hold-fill" style="width:${pct}%"></div></div>
    <div class="loadout-stats">
      <span>REWARD <b class="gold">${escapeHtml(mission.rewardGold)} G</b></span>
      <span>FUEL <b>${escapeHtml(fuel)}</b></span>
      <span>FEE <b>${escapeHtml(mission.feeGold)} G</b></span>
      <span>DIST <b>${escapeHtml(mission.distance)}</b></span>
    </div>
    ${overflow > 0 ? '<p class="card-description small bad">Hold too small — partial delivery, less reward. A bigger ship or HAULING crew carries more.</p>' : ''}`;
}

export function renderShipSwitcher(ships, selectedId) {
  if (!ships.length) return '<p class="card-description">NO SHIP NFT — MINT A GENESIS SHIP TO FLY.</p>';
  return `<div class="ship-switcher">${ships.map((s) => {
    const cur = s.currentHull ?? s.hull;
    return `<button class="ship-chip${s.id === selectedId ? ' active' : ''}" data-ship="${escapeHtml(s.id)}">
      <span class="chip-name">${escapeHtml(shipShortName(s.id))}</span>
      <span class="chip-stat">C${escapeHtml(s.cargo)} · E${escapeHtml(s.engine)} · H${escapeHtml(cur)}</span>
    </button>`;
  }).join('')}</div>`;
}

// Leaderboard on the SETTLEMENT screen: who has delivered most to the city.
// The airdrop share ledger — value delivered decides the split.
export function renderLeaderboard(rows, myWallet) {
  if (!rows || !rows.length) return '<p class="card-description small">NO DELIVERIES YET — BE THE FIRST TO BUILD THE CITY.</p>';
  const short = (w) => (w && w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : (w || '?'));
  const trs = rows.map((r, i) => `
    <tr${r.wallet === myWallet ? ' class="rare"' : ''}>
      <td class="n">${i + 1}</td>
      <td>${escapeHtml(short(r.wallet))}${r.wallet === myWallet ? ' ·YOU' : ''}</td>
      <td class="n">${escapeHtml(r.deliveries)}</td>
      <td class="n gold">${escapeHtml(r.value)}</td>
    </tr>`).join('');
  return `<p class="card-name">TOP BUILDERS</p>
    <table class="board-table"><thead><tr><th>#</th><th>PILOT</th><th>TRIPS</th><th>VALUE</th></tr></thead>
    <tbody>${trs}</tbody></table>
    <p class="card-description small">When the settlement can give back, airdrops split by VALUE delivered.</p>`;
}
