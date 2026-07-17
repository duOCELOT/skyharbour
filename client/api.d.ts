export function getWallet(): string | null;
export function setWallet(name: string): void;
export function clearWallet(): void;

export function getSession(): string | null;
export function setSession(token: string): void;
export function clearSession(): void;

export function api(path: string, options?: { method?: string; body?: any }): Promise<any>;

export function login(): Promise<any>;
export function balances(): Promise<any>;
export function missions(): Promise<any>;
export function missionsMine(): Promise<any>;
export function generateMissions(count: number): Promise<any>;
export function acceptMission(id: string, shipId: string, crewIds: string[]): Promise<any>;
export function completeMission(id: string, fireEvents: Array<{ t: number; raider: number | null }>): Promise<any>;
export function failMission(id: string, fuelSpent?: number, ammoSpent?: number): Promise<any>;
export function settlement(): Promise<any>;
export function crewMarket(): Promise<any>;
export function buyFuel(gold: number): Promise<any>;
export function buyAmmo(gold: number): Promise<any>;
export function repairShip(shipId: string, toHull: number): Promise<{ spent: number; hull: number; max: number }>;
export function authNonce(wallet: string): Promise<{ nonce: string; message: string }>;
export function authVerify(wallet: string, signature: string): Promise<{ session: string }>;
export function claim(token: string): Promise<{ id: number; amount: number }>;
export function claimsList(): Promise<Array<{
  id: number;
  wallet: string;
  token: string;
  amount: number;
  status: 'pending' | 'minting' | 'minted' | 'failed' | 'refunded';
  sig: string | null;
  attempts: number;
}>>;
export function buyGold(signature: string): Promise<{ gold: number }>;
export function solPayForGold(rpc: string, treasury: string, wallet: string, lamports: number): Promise<string>;
