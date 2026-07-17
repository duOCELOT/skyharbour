import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESERVED = ['harbour', 'settlement', 'mint', 'burn', 'chain'];

export function isReservedWallet(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED.includes(n) || n.startsWith('escrow:');
}

export interface ChainConfig {
  enabled: boolean;
  rpc: string;
  keypairPath: string;
  chainDir: string;
  adminKey?: string;
}

export function loadChainConfig(env: Record<string, string | undefined> = process.env): ChainConfig {
  return {
    enabled: env.SKYHARBOUR_CHAIN === 'devnet',
    rpc: env.SKYHARBOUR_RPC ?? 'https://api.devnet.solana.com',
    keypairPath: env.SKYHARBOUR_KEYPAIR ?? path.join(os.homedir(), '.config/skyharbour/devnet-keypair.json'),
    chainDir: env.SKYHARBOUR_CHAIN_DIR
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../chain'),
    adminKey: env.SKYHARBOUR_ADMIN_KEY,
  };
}
