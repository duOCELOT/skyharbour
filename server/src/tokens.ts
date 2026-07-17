export type TokenId = 'GOLD' | 'FUEL' | 'AMMO' | 'LOG' | 'MINERAL' | 'FURNITURE' | 'FIRERUNE';

export interface TokenInfo {
  id: TokenId;
  kind: 'currency' | 'fuel' | 'ammo' | 'cargo';
  unitPriceGold: number; // GOLD paid per delivered unit; 0 for non-cargo
}

export const TOKENS: Record<TokenId, TokenInfo> = {
  GOLD: { id: 'GOLD', kind: 'currency', unitPriceGold: 0 },
  FUEL: { id: 'FUEL', kind: 'fuel', unitPriceGold: 0 },
  AMMO: { id: 'AMMO', kind: 'ammo', unitPriceGold: 0 },
  LOG: { id: 'LOG', kind: 'cargo', unitPriceGold: 1 },
  MINERAL: { id: 'MINERAL', kind: 'cargo', unitPriceGold: 2 },
  FURNITURE: { id: 'FURNITURE', kind: 'cargo', unitPriceGold: 3 },
  FIRERUNE: { id: 'FIRERUNE', kind: 'cargo', unitPriceGold: 10 },
};

export const CARGO_TOKENS: TokenId[] = (Object.values(TOKENS) as TokenInfo[])
  .filter((t) => t.kind === 'cargo')
  .map((t) => t.id);

export function isTokenId(s: string): s is TokenId {
  return Object.prototype.hasOwnProperty.call(TOKENS, s);
}
