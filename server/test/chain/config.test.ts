import { describe, it, expect } from 'vitest';
import { isReservedWallet, loadChainConfig } from '../../src/chain/config.js';

describe('reserved wallet names', () => {
  it('rejects the system accounts in any case', () => {
    for (const w of ['harbour', 'SETTLEMENT', 'mint', 'Burn', 'chain', 'escrow:m1']) {
      expect(isReservedWallet(w)).toBe(true);
    }
    expect(isReservedWallet('alice')).toBe(false);
    expect(isReservedWallet('harbourmaster')).toBe(false);
  });
});

describe('chain config', () => {
  it('is disabled by default and enabled by SKYHARBOUR_CHAIN=devnet', () => {
    expect(loadChainConfig({}).enabled).toBe(false);
    const c = loadChainConfig({ SKYHARBOUR_CHAIN: 'devnet', SKYHARBOUR_RPC: 'http://x', SKYHARBOUR_ADMIN_KEY: 'k' });
    expect(c.enabled).toBe(true);
    expect(c.rpc).toBe('http://x');
    expect(c.adminKey).toBe('k');
  });
  it('defaults the rpc and chainDir', () => {
    const c = loadChainConfig({ SKYHARBOUR_CHAIN: 'devnet' });
    expect(c.rpc).toBe('https://api.devnet.solana.com');
    expect(c.chainDir.endsWith('/chain')).toBe(true);
  });
  it('defaults the keypair path under the user config dir when SKYHARBOUR_KEYPAIR is unset', () => {
    const c = loadChainConfig({});
    expect(c.keypairPath.endsWith('.config/skyharbour/devnet-keypair.json')).toBe(true);
  });
  it('honors an explicit SKYHARBOUR_KEYPAIR', () => {
    const c = loadChainConfig({ SKYHARBOUR_KEYPAIR: '/tmp/some-keypair.json' });
    expect(c.keypairPath).toBe('/tmp/some-keypair.json');
  });
});
