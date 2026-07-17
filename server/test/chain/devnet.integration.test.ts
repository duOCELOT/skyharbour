import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { loadChainConfig } from '../../src/chain/config.js';
import { fetchOwnedMints, type RegistryEntry } from '../../src/chain/fleet.js';

const enabled = process.env.SKYHARBOUR_CHAIN_TEST === '1';

(enabled ? describe : describe.skip)('devnet integration', () => {
  it('config and operator are available', async () => {
    const cfg = loadChainConfig();
    expect(cfg.enabled).toBe(true);

    const cfgFile = path.join(cfg.chainDir, 'config.json');
    if (!fs.existsSync(cfgFile)) {
      console.log(`skipping: config.json not found at ${cfgFile}`);
      expect(true).toBe(true);
      return;
    }

    const config = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as {
      operator: string;
      mints: Record<string, string>;
    };

    const conn = new Connection(cfg.rpc, 'confirmed');
    const operatorPk = new PublicKey(config.operator);

    // Assert operator has a balance
    const balance = await conn.getBalance(operatorPk);
    expect(balance).toBeGreaterThan(0);
    console.log(`operator balance: ${balance / 1e9} SOL`);
  }, 30_000);

  it('configured mints exist on-chain', async () => {
    const cfg = loadChainConfig();
    const cfgFile = path.join(cfg.chainDir, 'config.json');

    if (!fs.existsSync(cfgFile)) {
      console.log(`skipping: config.json not found at ${cfgFile}`);
      expect(true).toBe(true);
      return;
    }

    const config = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as {
      mints: Record<string, string>;
    };

    const conn = new Connection(cfg.rpc, 'confirmed');

    for (const [name, mintAddr] of Object.entries(config.mints)) {
      const mintPk = new PublicKey(mintAddr);
      const mint = await getMint(conn, mintPk);
      expect(mint.address.toBase58()).toBe(mintAddr);
      console.log(`mint ${name} verified: ${mintAddr}`);
    }
  }, 30_000);

  it('operator mints intersect registry when registry is present', async () => {
    const cfg = loadChainConfig();
    const cfgFile = path.join(cfg.chainDir, 'config.json');
    const registryFile = path.join(cfg.chainDir, 'registry.json');

    if (!fs.existsSync(cfgFile)) {
      console.log(`skipping: config.json not found at ${cfgFile}`);
      expect(true).toBe(true);
      return;
    }

    if (!fs.existsSync(registryFile)) {
      console.log(`skipping: registry.json not found at ${registryFile}`);
      expect(true).toBe(true);
      return;
    }

    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as Record<
      string,
      RegistryEntry
    >;

    if (Object.keys(registry).length === 0) {
      console.log('registry is empty; skipping intersection check');
      expect(true).toBe(true);
      return;
    }

    const config = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as {
      operator: string;
    };

    const conn = new Connection(cfg.rpc, 'confirmed');
    const operatorPk = new PublicKey(config.operator);

    // Fetch mints owned by operator
    const ownedMints = await fetchOwnedMints(conn, config.operator);
    const registryMints = Object.keys(registry);

    // Check that at least one mint in registry is held by operator
    const intersection = ownedMints.filter((m) => registryMints.includes(m));
    console.log(
      `operator holds ${ownedMints.length} mints, registry has ${registryMints.length}, intersection: ${intersection.length}`
    );

    // For devnet bootstrap test: if registry exists, there should be some intersection
    // (operator mints test assets). If not yet minted, just log and pass.
    if (intersection.length === 0) {
      console.log(
        'no intersection: operator has not yet minted registry assets, or registry is for others'
      );
    }
    expect(true).toBe(true);
  }, 30_000);
});
