export const WORLD_SCALE: number;

export function hashSeed(str: string): number;

export function mkWorld(seedStr: string, distance: number, cargo?: string): {
  rocks: Array<{ x: number; y: number; z: number; r: number }>;
  islands: Array<{ x: number; y: number; z: number; r: number }>;
  raiders: Array<{ x: number; y: number; z: number; hp: number }>;
  target: { x: number; y: number; z: number };
};

export function fuelSkill(crew: Array<{ id: string; skills?: Record<string, number> }>): number;
export function defenseSkill(crew: Array<{ id: string; skills?: Record<string, number> }>): number;
export function haulingSkill(crew: Array<{ id: string; skills?: Record<string, number> }>): number;
export function raiderCount(missionId: string, distance: number, cargo: string): number;
export function attackSkill(crew: Array<{ id: string; skills?: Record<string, number> }>): number;
export function cannonDamage(atk: number): number;
export function cannonCooldown(atk: number): number;

export function minFuelClient(distance: number, crew: Array<{ id: string; skills?: Record<string, number> }>): number;

export const ENGAGE_RANGE_WORLD: number;

export function raiderTimeline(
  missionId: string,
  distance: number,
  cargo: string,
  engine: number,
): Array<{ engageStart: number; attackAt: number }>;

export interface FireEvent {
  t: number;
  raider: number | null;
}

export interface ResolveRunArgs {
  missionId: string;
  distance: number;
  cargo: string;
  amount: number;
  ship: { cargo: number; hull: number; engine: number };
  crew: Array<{ id?: string; skills?: Record<string, number> }>;
  startHull: number;
  ammoAvailable: number;
  fireEvents: FireEvent[];
}

// A hand-written mirror of a JS module's runtime shape, not a real
// discriminated union enforced by the compiler: callers (including test code
// mirroring the brief verbatim) read result fields straight off `r.ok`
// checks without a `res is {ok:true}` narrowing guard, so the success fields
// are typed optional rather than gated behind `ok: true` — they are always
// present at runtime when `ok` is true, per resolveRun's implementation.
export interface ResolveRunResult {
  ok: boolean;
  reason?: string;
  raidersDestroyed?: number;
  raiderHits?: number;
  ammoSpent?: number;
  fuelSpent?: number;
  loaded?: number;
  cargoDelivered?: number;
  hullDamage?: number;
  finalHull?: number;
  outcome?: 'landed' | 'void';
}

export function resolveRun(args: ResolveRunArgs): ResolveRunResult;

export function mkRun(
  ship: { id: string; owner: string; engine: number; cargo: number; crewSlots: number; hull: number },
  crew: Array<{ id: string; skills?: Record<string, number> }>,
  distance: number,
  fuelBudget: number,
  ammoBudget?: number,
  startHull?: number,
): {
  pos: { x: number; z: number };
  heading: number;
  throttle: number;
  fuel: number;
  fuelBudget: number;
  ammoBudget: number;
  shots: number;
  hull: number;
  t: number;
  distance: number;
  engine: number;
  fuelSkill: number;
  defense: number;
  hauling: number;
  attack: number;
  kills: number;
  raiderHits: number;
  struck: Set<number>;
  done: boolean;
  outcome: string | null;
};

export function stepRun(
  run: any,
  dt: number,
  input: { yaw?: number; throttle?: number },
  world: { rocks: Array<{ x: number; y: number; z: number; r: number }>; islands: any[]; target: { x: number; y: number; z: number } },
  rand?: () => number,
): any;

export function fireShot(run: any): boolean;
export function applyRaiderHit(run: any, rand?: () => number): 'dodged' | 'hit';
export function registerKill(run: any): void;
