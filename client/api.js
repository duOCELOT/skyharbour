// Dev auth until the chain gateway (plan 2): the "wallet" is a name in
// localStorage, sent as the x-wallet header the server expects.
const KEY = 'sh-wallet';
// Chain gateway (plan 2): a Phantom-signed session token, sent as the
// x-session header. When present it takes over from x-wallet entirely.
const SESSION_KEY = 'sh-session';

export function getWallet() { return localStorage.getItem(KEY); }
export function setWallet(name) { localStorage.setItem(KEY, name); }
export function clearWallet() { localStorage.removeItem(KEY); }

export function getSession() { return localStorage.getItem(SESSION_KEY); }
export function setSession(token) { localStorage.setItem(SESSION_KEY, token); }
export function clearSession() { localStorage.removeItem(SESSION_KEY); }

// Offline demo: on a static host (GitHub Pages) there is no game server, so
// the first request that finds none — a network error, or a non-JSON reply
// like a host's HTML 404 page — switches every call to the in-browser demo
// harbour (client/demo/demo.js, the same server modules on wasm SQLite).
// A real server always answers JSON, so local dev and deploys are untouched.
let demo = null; // null = undecided, false = live server, else the demo module
export const isDemo = () => !!demo;

async function demoCall(path, method, body) {
  const res = demo.request({ method, path, wallet: getWallet(), body });
  if (res.status >= 400) throw new Error(res.body?.error ?? `request failed: ${path}`);
  return res.body;
}

async function enterDemo() {
  demo = await import('./demo/demo.js');
  console.info('[skyharbour] no game server found — running the offline demo harbour');
}

export async function api(path, { method = 'GET', body } = {}) {
  if (demo) return demoCall(path, method, body);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(getSession() ? { 'x-session': getSession() } : { 'x-wallet': getWallet() ?? '' }),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    if (demo !== null) throw e; // a live server that dropped out — surface it
    await enterDemo();
    return demoCall(path, method, body);
  }
  const type = res.headers?.get?.('content-type');
  if (demo === null && typeof type === 'string' && !type.includes('json')) {
    await enterDemo();
    return demoCall(path, method, body);
  }
  if (demo === null) demo = false;
  if (!res.ok) {
    let message = `request failed: ${path}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch { /* keep generic message */ }
    throw new Error(message);
  }
  return res.json();
}

export const login = () => api('/login', { method: 'POST' });
export const balances = () => api('/balances');
export const missions = () => api('/missions');
export const missionsMine = () => api('/missions/mine');
export const generateMissions = (count) => api('/missions/generate', { method: 'POST', body: { count } });
export const acceptMission = (id, shipId, crewIds) => api(`/missions/${id}/accept`, { method: 'POST', body: { shipId, crewIds } });
export const completeMission = (id, fireEvents) => api(`/missions/${id}/complete`, { method: 'POST', body: { fireEvents } });
export const failMission = (id, fuelSpent = 0, ammoSpent = 0) => api(`/missions/${id}/fail`, { method: 'POST', body: { fuelSpent, ammoSpent } });
export const settlement = () => api('/settlement');
export const leaderboard = () => api('/leaderboard');
export const crewMarket = () => api('/crew/market');
export const buyFuel = (gold) => api('/fuel/buy', { method: 'POST', body: { gold } });
export const buyAmmo = (gold) => api('/ammo/buy', { method: 'POST', body: { gold } });
export const repairShip = (shipId, toHull) => api('/ship/repair', { method: 'POST', body: { shipId, toHull } });
export const authNonce = (wallet) => api('/auth/nonce', { method: 'POST', body: { wallet } });
export const authVerify = (wallet, signature) => api('/auth/verify', { method: 'POST', body: { wallet, signature } });
export const claim = (token) => api('/claim', { method: 'POST', body: { token } });
export const claimsList = () => api('/claims');
export const buyGold = (signature) => api('/gold/buy', { method: 'POST', body: { signature } });

// SOL on-ramp (plan 2): builds and sends a devnet SOL transfer from the
// connected wallet to the treasury via Phantom, returning the tx signature
// to be posted to /gold/buy. web3 comes from the self-contained IIFE bundle
// loaded as a classic <script> → window.solanaWeb3 (the browser-ESM build
// can't resolve its bare `import from 'buffer'` without a bundler). Reading
// window inside the function keeps client/api.js loadable in Node tests.
export async function solPayForGold(rpc, treasury, wallet, lamports) {
  if (!window.solana) throw new Error('no wallet');
  const w3 = window.solanaWeb3;
  if (!w3) throw new Error('web3 not loaded');
  const { Connection, PublicKey, SystemProgram, Transaction } = w3;
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: new PublicKey(wallet),
    toPubkey: new PublicKey(treasury),
    lamports,
  }));
  tx.feePayer = new PublicKey(wallet);
  tx.recentBlockhash = (await new Connection(rpc).getLatestBlockhash()).blockhash;
  const { signature } = await window.solana.signAndSendTransaction(tx);
  return signature;
}
