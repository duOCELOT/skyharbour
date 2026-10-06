// System account names a wallet may never dock as. Kept free of node imports
// so the in-browser demo backend (src/demo) can share it with the server.
export const RESERVED = ['harbour', 'settlement', 'mint', 'burn', 'chain'];

export function isReservedWallet(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED.includes(n) || n.startsWith('escrow:');
}
