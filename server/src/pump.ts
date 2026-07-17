import { Ledger } from './ledger.js';

// The armory made concrete: entry fees accumulate in the
// settlement treasury; pilots buy provisions back with GOLD at flat rates.
export const RATES: Record<'FUEL' | 'AMMO', number> = { FUEL: 4, AMMO: 2 };

// Legacy export for back-compat
export const FUEL_PER_GOLD = RATES.FUEL;

export function buyProvision(ledger: Ledger, wallet: string, gold: number, token: 'FUEL' | 'AMMO'): { credited: number } {
  if (!Number.isSafeInteger(gold) || gold <= 0) {
    throw new Error('purchase must be a positive integer of GOLD');
  }
  const credited = gold * RATES[token];
  if (!Number.isSafeInteger(credited)) {
    throw new Error('purchase must be a positive integer of GOLD');
  }
  ledger.post(`provision pump ${wallet}`, [
    { account: `wallet:${wallet}`, token: 'GOLD', amount: -gold },
    { account: 'settlement', token: 'GOLD', amount: gold },
    { account: 'mint', token, amount: -credited },
    { account: `wallet:${wallet}`, token, amount: credited },
  ]);
  return { credited };
}

export function buyFuel(ledger: Ledger, wallet: string, gold: number): { fuelCredited: number } {
  const r = buyProvision(ledger, wallet, gold, 'FUEL');
  return { fuelCredited: r.credited };
}
