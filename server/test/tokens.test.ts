import { describe, it, expect } from 'vitest';
import { TOKENS, CARGO_TOKENS, isTokenId } from '../src/tokens.js';

describe('token registry', () => {
  it('defines the seven v1 tokens', () => {
    expect(Object.keys(TOKENS).sort()).toEqual(
      ['AMMO', 'FIRERUNE', 'FUEL', 'FURNITURE', 'GOLD', 'LOG', 'MINERAL'],
    );
  });
  it('AMMO is kind ammo', () => {
    expect(TOKENS.AMMO.kind).toBe('ammo');
  });
  it('prices cargo per spec', () => {
    expect(TOKENS.LOG.unitPriceGold).toBe(1);
    expect(TOKENS.MINERAL.unitPriceGold).toBe(2);
    expect(TOKENS.FURNITURE.unitPriceGold).toBe(3);
    expect(TOKENS.FIRERUNE.unitPriceGold).toBe(10);
  });
  it('CARGO_TOKENS excludes GOLD and FUEL', () => {
    expect(CARGO_TOKENS.sort()).toEqual(['FIRERUNE', 'FURNITURE', 'LOG', 'MINERAL']);
  });
  it('isTokenId rejects unknown strings', () => {
    expect(isTokenId('GOLD')).toBe(true);
    expect(isTokenId('DOGE')).toBe(false);
  });
});
