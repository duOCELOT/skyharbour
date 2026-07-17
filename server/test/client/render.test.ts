import { describe, it, expect } from 'vitest';
import {
  renderTicker, renderManifest, renderHangar, renderBoard,
  renderSettlement, renderCrewMarket, renderGhostRuns, renderPanel, escapeHtml,
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
  it('escapes HTML in balance values', () => {
    const html = renderTicker({ GOLD: '<i>9</i>', FUEL: 0 } as any);
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;i&gt;');
  });
  it('always shows AMMO after FUEL', () => {
    const t = renderTicker({ ...bal, AMMO: 12 });
    expect(t).toContain('AMMO 12');
    expect(t.indexOf('FUEL')).toBeLessThan(t.indexOf('AMMO'));
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
  it('escapes numeric fields to prevent XSS', () => {
    const html = renderBoard([{ id: 'm1', cargo: 'LOG', amount: '<script>1</script>' as any, origin: 'RUNEFALL', distance: 1, rewardGold: 1, feeGold: 1, status: 'open' }]);
    expect(html).not.toContain('<script>');
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
  it('escapes HTML in need keys from API data', () => {
    const html = renderSettlement({
      stage: { index: 0, name: 'Landing Dock', needs: { '<b>LOG</b>': 10 } as any },
      received: { '<b>LOG</b>': 5 }, remainingNeeds: {}, completedStages: 0,
    });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
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

  it('crew market shows listing skills', () => {
    const html = renderCrewMarket(
      [{ crewId: 'npc-stoker', owner: 'harbour', sharePct: 10, skills: { fuel: 35 } }],
      [],
    );
    expect(html).toContain('FUEL 35');
    expect(html).toContain('NPC-STOKER');
  });

  it('crew market shows HAUL for hauling skill', () => {
    const html = renderCrewMarket(
      [{ crewId: 'npc-longshoreman', owner: 'harbour', sharePct: 12, skills: { hauling: 20 } }],
      [],
    );
    expect(html).toContain('HAUL 20');
    expect(html).toContain('NPC-LONGSHOREMAN');
  });
});

describe('renderGhostRuns', () => {
  it('ghost runs render abandon buttons and escape data', () => {
    const html = renderGhostRuns([{ id: 'g1', cargo: 'LOG', amount: 5, distance: 148, status: 'active' }]);
    expect(html).toContain('data-mission="g1"');
    expect(html).toContain('ABANDON');
    expect(renderGhostRuns([])).toBe('');
  });
});

describe('renderPanel', () => {
  it('renderPanel shows balances, the build meter, and hull', () => {
    const html = renderPanel(
      { GOLD: 104, FUEL: 152, AMMO: 20, LOG: 0 },
      { stage: { index: 0, name: 'Landing Dock', needs: { LOG: 100 } }, received: { LOG: 5 } },
      { id: 'ship-1', hull: 8, currentHull: 5 },
    );
    expect(html).toContain('104'); expect(html).toContain('AMMO');
    expect(html).toContain('LANDING DOCK'); expect(html).toContain('5/8');
  });

  it('renderPanel is null-safe when no ship is selected', () => {
    const html = renderPanel({ GOLD: 0, FUEL: 0, AMMO: 0 },
      { stage: { index: 0, name: 'Landing Dock', needs: { LOG: 100 } }, received: {} }, null);
    expect(html).toContain('LANDING DOCK'); // does not throw, still renders the panel
  });
});

describe('renderHangar/renderManifest/escapeHtml', () => {
  it('hangar carries data-ship', () => {
    expect(renderHangar([{ id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8 }]))
      .toContain('data-ship="ship-1"');
  });
  it('hangar displays BRIDGE for crew capacity', () => {
    const html = renderHangar([{ id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8 }]);
    expect(html).toContain('BRIDGE 2');
    expect(html).not.toContain('CREW 2');
  });
  it('hangar shows HULL cur/max at full hull and no repair button', () => {
    const html = renderHangar([{ id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8 }]);
    expect(html).toContain('HULL 8/8');
    expect(html).not.toContain('data-repair');
  });
  it('hangar shows a REPAIR button with data-repair when battered', () => {
    const html = renderHangar([{ id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8, currentHull: 5 }]);
    expect(html).toContain('HULL 5/8');
    expect(html).toContain('data-repair="ship-1"');
    expect(html).toContain('REPAIR');
  });
  it('falls back to full hull when currentHull is absent', () => {
    const html = renderHangar([{ id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2, hull: 8 }]);
    expect(html).toContain('HULL 8/8');
  });
  it('manifest shows balances', () => {
    expect(renderManifest(bal)).toContain('104');
  });
  it('manifest always shows an AMMO row', () => {
    expect(renderManifest({ ...bal, AMMO: 7 })).toContain('AMMO');
  });
  it('escapeHtml neutralizes angle brackets and quotes', () => {
    expect(escapeHtml('<a b="c">&')).toBe('&lt;a b=&quot;c&quot;&gt;&amp;');
  });
});
