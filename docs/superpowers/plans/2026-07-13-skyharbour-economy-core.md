# Skyharbour Economy Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Skyharbour's off-chain economy backbone — double-entry token ledger, ship/crew fleet seam, grants + fuel airdrops, shared settlement, crew market, mission engine with atomic payouts, run validation, and the HTTP API — fully tested, no chain code.

**Architecture:** One TypeScript/Node service (`server/`). Every economic movement is an append-only double-entry ledger event; balances are derived. Ships/crew come from a `FleetSource` interface backed by dev fixtures in this plan — the Solana chain gateway (separate plan) will re-implement that same interface. HTTP API via Fastify with dev header auth (`x-wallet`); real wallet-signature auth arrives with the chain gateway plan.

**Tech Stack:** Node ≥ 20, TypeScript (strict, ESM), better-sqlite3, Fastify 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-skyharbour-v1-design.md`. This is plan 1 of 3 (2: Solana chain gateway; 3: Three.js game client + dapp UI).

## Global Constraints

- Node ≥ 20, `"type": "module"`, TypeScript `strict: true`.
- All balances are **integers** (whole token units). No floats in money math.
- Ledger is double-entry: every post's legs sum to **zero per token**. Only the `mint` account may go negative.
- Token ids are exactly: `GOLD`, `FUEL`, `LOG`, `MINERAL`, `FURNITURE`, `FIRERUNE`.
- Economy numbers (tunable, but use these): starter grant = 100 GOLD + 300 FUEL, once per wallet; unit prices GOLD per cargo unit: LOG 1, MINERAL 2, FURNITURE 3, FIRERUNE 10; mission fee = 10% of reward (min 1); crew shares total ≤ 50% of reward; fuel need = `distance`, reduced by crew fuel skill, capped at 50% reduction.
- Player accounts in the ledger are `wallet:<address>`; system accounts: `mint`, `burn`, `settlement`, `escrow:<missionId>`.
- No Solana/web3 imports anywhere in this plan.
- Run tests from `server/`. Commit after every green cycle.

---

### Task 1: Server package scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `server/src/version.ts`
- Test: `server/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `server/` package where `npm test` runs Vitest over TypeScript ESM.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "skyharbour-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "fastify": "^4.28.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json and vitest.config.ts**

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

- [ ] **Step 3: Install and write the smoke test**

Run: `cd ~/skyharbour/server && npm install`

`server/src/version.ts`:
```ts
export const VERSION = '0.1.0';
```

`server/test/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/version.js';

describe('scaffold', () => {
  it('runs typescript tests', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server && git commit -m "chore(server): scaffold TypeScript/Vitest package"
```

---

### Task 2: Token registry

**Files:**
- Create: `server/src/tokens.ts`
- Test: `server/test/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TokenId = 'GOLD'|'FUEL'|'LOG'|'MINERAL'|'FURNITURE'|'FIRERUNE'`
  - `interface TokenInfo { id: TokenId; kind: 'currency'|'fuel'|'cargo'; unitPriceGold: number }`
  - `const TOKENS: Record<TokenId, TokenInfo>`
  - `const CARGO_TOKENS: TokenId[]` (only `kind === 'cargo'`)
  - `function isTokenId(s: string): s is TokenId`

- [ ] **Step 1: Write the failing test**

`server/test/tokens.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { TOKENS, CARGO_TOKENS, isTokenId } from '../src/tokens.js';

describe('token registry', () => {
  it('defines the six v1 tokens', () => {
    expect(Object.keys(TOKENS).sort()).toEqual(
      ['FIRERUNE', 'FUEL', 'FURNITURE', 'GOLD', 'LOG', 'MINERAL'],
    );
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/tokens.js`.

- [ ] **Step 3: Write the implementation**

`server/src/tokens.ts`:
```ts
export type TokenId = 'GOLD' | 'FUEL' | 'LOG' | 'MINERAL' | 'FURNITURE' | 'FIRERUNE';

export interface TokenInfo {
  id: TokenId;
  kind: 'currency' | 'fuel' | 'cargo';
  unitPriceGold: number; // GOLD paid per delivered unit; 0 for non-cargo
}

export const TOKENS: Record<TokenId, TokenInfo> = {
  GOLD: { id: 'GOLD', kind: 'currency', unitPriceGold: 0 },
  FUEL: { id: 'FUEL', kind: 'fuel', unitPriceGold: 0 },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/tokens.ts server/test/tokens.test.ts && git commit -m "feat(server): token registry with cargo unit prices"
```

---

### Task 3: Double-entry ledger

**Files:**
- Create: `server/src/ledger.ts`
- Test: `server/test/ledger.test.ts`

**Interfaces:**
- Consumes: `TokenId` from `tokens.ts`.
- Produces:
  - `interface Leg { account: string; token: TokenId; amount: number }` (positive = credit, negative = debit)
  - `class InsufficientFunds extends Error`
  - `class UnbalancedPost extends Error`
  - `class Ledger { constructor(db: Database.Database); post(memo: string, legs: Leg[]): number; balance(account: string, token: TokenId): number }`
  - `post` returns the event id. It is atomic: all legs apply or none. Legs must sum to zero per token or `UnbalancedPost` is thrown. Any account other than `mint` ending negative throws `InsufficientFunds`.

- [ ] **Step 1: Write the failing test**

`server/test/ledger.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger, InsufficientFunds, UnbalancedPost } from '../src/ledger.js';

let ledger: Ledger;
beforeEach(() => {
  ledger = new Ledger(new Database(':memory:'));
});

describe('ledger', () => {
  it('mints and reads balances', () => {
    ledger.post('grant', [
      { account: 'mint', token: 'GOLD', amount: -100 },
      { account: 'wallet:alice', token: 'GOLD', amount: 100 },
    ]);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(100);
    expect(ledger.balance('mint', 'GOLD')).toBe(-100);
  });

  it('rejects unbalanced posts', () => {
    expect(() =>
      ledger.post('bad', [{ account: 'wallet:alice', token: 'GOLD', amount: 5 }]),
    ).toThrow(UnbalancedPost);
  });

  it('rejects overdrafts on non-mint accounts and rolls back atomically', () => {
    ledger.post('grant', [
      { account: 'mint', token: 'GOLD', amount: -10 },
      { account: 'wallet:alice', token: 'GOLD', amount: 10 },
    ]);
    expect(() =>
      ledger.post('overspend', [
        { account: 'wallet:alice', token: 'GOLD', amount: -50 },
        { account: 'wallet:bob', token: 'GOLD', amount: 50 },
      ]),
    ).toThrow(InsufficientFunds);
    // rollback: nothing moved
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(10);
    expect(ledger.balance('wallet:bob', 'GOLD')).toBe(0);
  });

  it('handles multi-token atomic posts', () => {
    ledger.post('setup', [
      { account: 'mint', token: 'FUEL', amount: -60 },
      { account: 'wallet:alice', token: 'FUEL', amount: 60 },
    ]);
    ledger.post('burn fuel', [
      { account: 'wallet:alice', token: 'FUEL', amount: -20 },
      { account: 'burn', token: 'FUEL', amount: 20 },
    ]);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(40);
    expect(ledger.balance('burn', 'FUEL')).toBe(20);
  });

  it('rejects non-integer amounts', () => {
    expect(() =>
      ledger.post('float', [
        { account: 'mint', token: 'GOLD', amount: -0.5 },
        { account: 'wallet:alice', token: 'GOLD', amount: 0.5 },
      ]),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/ledger.js`.

- [ ] **Step 3: Write the implementation**

`server/src/ledger.ts`:
```ts
import type Database from 'better-sqlite3';
import type { TokenId } from './tokens.js';

export interface Leg {
  account: string;
  token: TokenId;
  amount: number; // positive credit, negative debit
}

export class InsufficientFunds extends Error {}
export class UnbalancedPost extends Error {}

export class Ledger {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        memo TEXT NOT NULL,
        legs TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS balances (
        account TEXT NOT NULL,
        token TEXT NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (account, token)
      );
    `);
  }

  post(memo: string, legs: Leg[]): number {
    const perToken = new Map<string, number>();
    for (const leg of legs) {
      if (!Number.isInteger(leg.amount)) {
        throw new UnbalancedPost(`non-integer amount for ${leg.account}`);
      }
      perToken.set(leg.token, (perToken.get(leg.token) ?? 0) + leg.amount);
    }
    for (const [token, sum] of perToken) {
      if (sum !== 0) throw new UnbalancedPost(`legs for ${token} sum to ${sum}, not 0`);
    }

    const upsert = this.db.prepare(`
      INSERT INTO balances (account, token, amount) VALUES (?, ?, ?)
      ON CONFLICT(account, token) DO UPDATE SET amount = amount + excluded.amount
    `);
    const read = this.db.prepare(
      'SELECT amount FROM balances WHERE account = ? AND token = ?',
    );
    const insertEvent = this.db.prepare(
      'INSERT INTO ledger_events (memo, legs) VALUES (?, ?)',
    );

    const txn = this.db.transaction((): number => {
      for (const leg of legs) upsert.run(leg.account, leg.token, leg.amount);
      for (const leg of legs) {
        if (leg.account === 'mint') continue;
        const row = read.get(leg.account, leg.token) as { amount: number };
        if (row.amount < 0) {
          throw new InsufficientFunds(`${leg.account} would hold ${row.amount} ${leg.token}`);
        }
      }
      const res = insertEvent.run(memo, JSON.stringify(legs));
      return Number(res.lastInsertRowid);
    });
    return txn();
  }

  balance(account: string, token: TokenId): number {
    const row = this.db
      .prepare('SELECT amount FROM balances WHERE account = ? AND token = ?')
      .get(account, token) as { amount: number } | undefined;
    return row?.amount ?? 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass (overdraft test relies on better-sqlite3 transaction rollback on throw).

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/ledger.ts server/test/ledger.test.ts && git commit -m "feat(server): append-only double-entry ledger with derived balances"
```

---

### Task 4: Fleet seam (ships + crew fixtures)

**Files:**
- Create: `server/src/fleet.ts`
- Test: `server/test/fleet.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (the boundary the future Solana chain gateway re-implements):
  - `interface Ship { id: string; owner: string; engine: number; cargo: number; crewSlots: number }`
  - `interface CrewMember { id: string; owner: string; skills: { fuel?: number; attack?: number; defense?: number } }` (skill values are integer percentage points, 0–100)
  - `interface FleetSource { shipsOf(wallet: string): Ship[]; crewOf(wallet: string): CrewMember[]; getShip(id: string): Ship | undefined; getCrew(id: string): CrewMember | undefined }`
  - `class DevFleet implements FleetSource { constructor(ships: Ship[], crew: CrewMember[]) }`
  - `function devFixtures(): { ships: Ship[]; crew: CrewMember[] }` — deterministic fixtures used by tests and the dev seed.

- [ ] **Step 1: Write the failing test**

`server/test/fleet.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DevFleet, devFixtures } from '../src/fleet.js';

describe('dev fleet', () => {
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);

  it('resolves ships by owner and id', () => {
    const alices = fleet.shipsOf('alice');
    expect(alices.length).toBeGreaterThan(0);
    expect(fleet.getShip(alices[0].id)?.owner).toBe('alice');
  });

  it('resolves crew by owner and id', () => {
    const bobs = fleet.crewOf('bob');
    expect(bobs.length).toBeGreaterThan(0);
    expect(fleet.getCrew(bobs[0].id)?.owner).toBe('bob');
  });

  it('returns empty for unknown wallets', () => {
    expect(fleet.shipsOf('nobody')).toEqual([]);
    expect(fleet.crewOf('nobody')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/fleet.js`.

- [ ] **Step 3: Write the implementation**

`server/src/fleet.ts`:
```ts
export interface Ship {
  id: string;
  owner: string;
  engine: number; // distance units per second
  cargo: number; // max cargo units
  crewSlots: number;
}

export interface CrewMember {
  id: string;
  owner: string;
  skills: { fuel?: number; attack?: number; defense?: number }; // integer % points
}

export interface FleetSource {
  shipsOf(wallet: string): Ship[];
  crewOf(wallet: string): CrewMember[];
  getShip(id: string): Ship | undefined;
  getCrew(id: string): CrewMember | undefined;
}

export class DevFleet implements FleetSource {
  constructor(private ships: Ship[], private crew: CrewMember[]) {}
  shipsOf(wallet: string): Ship[] {
    return this.ships.filter((s) => s.owner === wallet);
  }
  crewOf(wallet: string): CrewMember[] {
    return this.crew.filter((c) => c.owner === wallet);
  }
  getShip(id: string): Ship | undefined {
    return this.ships.find((s) => s.id === id);
  }
  getCrew(id: string): CrewMember | undefined {
    return this.crew.find((c) => c.id === id);
  }
}

export function devFixtures(): { ships: Ship[]; crew: CrewMember[] } {
  return {
    ships: [
      { id: 'ship-1', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2 },
      { id: 'ship-2', owner: 'bob', engine: 15, cargo: 10, crewSlots: 1 },
    ],
    crew: [
      { id: 'crew-1', owner: 'bob', skills: { fuel: 20 } },
      { id: 'crew-2', owner: 'carol', skills: { defense: 30 } },
      { id: 'crew-3', owner: 'carol', skills: { fuel: 40, attack: 10 } },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/fleet.ts server/test/fleet.test.ts && git commit -m "feat(server): FleetSource seam with dev fixtures"
```

---

### Task 5: Grants and fuel airdrops

**Files:**
- Create: `server/src/grants.ts`
- Test: `server/test/grants.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `Leg` from `ledger.ts`; `FleetSource` from `fleet.ts`.
- Produces:
  - `const STARTER_GOLD = 100`, `const STARTER_FUEL = 300`
  - `class Grants { constructor(db: Database.Database, ledger: Ledger, fleet: FleetSource); grantShipOwner(wallet: string): boolean; airdropFuel(wallets: string[], amount: number): number }`
  - `grantShipOwner`: mints starter GOLD+FUEL to `wallet:<w>` **once per wallet**, and **only if the wallet owns at least one ship**. Returns whether a grant was made.
  - `airdropFuel`: mints `amount` FUEL to each wallet; returns wallets credited.

- [ ] **Step 1: Write the failing test**

`server/test/grants.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../src/ledger.js';
import { DevFleet, devFixtures } from '../src/fleet.js';
import { Grants, STARTER_GOLD, STARTER_FUEL } from '../src/grants.js';

let ledger: Ledger;
let grants: Grants;
beforeEach(() => {
  const db = new Database(':memory:');
  ledger = new Ledger(db);
  const { ships, crew } = devFixtures();
  grants = new Grants(db, ledger, new DevFleet(ships, crew));
});

describe('ship-owner grant', () => {
  it('grants once to a ship owner', () => {
    expect(grants.grantShipOwner('alice')).toBe(true);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(STARTER_GOLD);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(STARTER_FUEL);
  });
  it('is idempotent per wallet', () => {
    grants.grantShipOwner('alice');
    expect(grants.grantShipOwner('alice')).toBe(false);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(STARTER_GOLD);
  });
  it('refuses wallets with no ship', () => {
    expect(grants.grantShipOwner('carol')).toBe(false);
    expect(ledger.balance('wallet:carol', 'GOLD')).toBe(0);
  });
});

describe('fuel airdrop', () => {
  it('credits FUEL to each wallet', () => {
    expect(grants.airdropFuel(['alice', 'bob'], 25)).toBe(2);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(25);
    expect(ledger.balance('wallet:bob', 'FUEL')).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/grants.js`.

- [ ] **Step 3: Write the implementation**

`server/src/grants.ts`:
```ts
import type Database from 'better-sqlite3';
import { Ledger } from './ledger.js';
import type { FleetSource } from './fleet.js';

export const STARTER_GOLD = 100;
export const STARTER_FUEL = 300;

export class Grants {
  constructor(
    private db: Database.Database,
    private ledger: Ledger,
    private fleet: FleetSource,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS grants (wallet TEXT PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  }

  grantShipOwner(wallet: string): boolean {
    if (this.fleet.shipsOf(wallet).length === 0) return false;
    const claimed = this.db.prepare('SELECT 1 FROM grants WHERE wallet = ?').get(wallet);
    if (claimed) return false;
    this.db.prepare('INSERT INTO grants (wallet) VALUES (?)').run(wallet);
    this.ledger.post(`starter grant ${wallet}`, [
      { account: 'mint', token: 'GOLD', amount: -STARTER_GOLD },
      { account: `wallet:${wallet}`, token: 'GOLD', amount: STARTER_GOLD },
      { account: 'mint', token: 'FUEL', amount: -STARTER_FUEL },
      { account: `wallet:${wallet}`, token: 'FUEL', amount: STARTER_FUEL },
    ]);
    return true;
  }

  airdropFuel(wallets: string[], amount: number): number {
    for (const w of wallets) {
      this.ledger.post(`fuel airdrop ${w}`, [
        { account: 'mint', token: 'FUEL', amount: -amount },
        { account: `wallet:${w}`, token: 'FUEL', amount },
      ]);
    }
    return wallets.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/grants.ts server/test/grants.test.ts && git commit -m "feat(server): ship-owner starter grant and fuel airdrops"
```

---

### Task 6: Settlement build progress

**Files:**
- Create: `server/src/settlement.ts`
- Test: `server/test/settlement.test.ts`

**Interfaces:**
- Consumes: `TokenId` from `tokens.ts`.
- Produces:
  - `interface Stage { index: number; name: string; needs: Partial<Record<TokenId, number>> }`
  - `class Settlement { constructor(db: Database.Database, stages: Stage[]); currentStage(): Stage | undefined; received(): Partial<Record<TokenId, number>>; remainingNeeds(): Partial<Record<TokenId, number>>; deliver(token: TokenId, amount: number): { accepted: number; stageCompleted: boolean }; completedStages(): number }`
  - `deliver` accepts at most the remaining need for that token in the current stage (`accepted` may be less than `amount`); when all needs hit zero the stage completes and progress resets against the next stage. When all stages are done, `currentStage()` is `undefined` and `deliver` accepts 0.
  - `const DEFAULT_STAGES: Stage[]` — the v1 build ladder.

- [ ] **Step 1: Write the failing test**

`server/test/settlement.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Settlement, type Stage } from '../src/settlement.js';

const stages: Stage[] = [
  { index: 0, name: 'Dock', needs: { LOG: 10 } },
  { index: 1, name: 'Hall', needs: { LOG: 5, MINERAL: 5 } },
];

let settlement: Settlement;
beforeEach(() => {
  settlement = new Settlement(new Database(':memory:'), stages);
});

describe('settlement', () => {
  it('tracks remaining needs of the current stage', () => {
    expect(settlement.currentStage()?.name).toBe('Dock');
    settlement.deliver('LOG', 4);
    expect(settlement.remainingNeeds()).toEqual({ LOG: 6 });
  });

  it('completes a stage exactly at need and advances', () => {
    const r = settlement.deliver('LOG', 10);
    expect(r).toEqual({ accepted: 10, stageCompleted: true });
    expect(settlement.currentStage()?.name).toBe('Hall');
    expect(settlement.completedStages()).toBe(1);
  });

  it('caps acceptance at remaining need', () => {
    const r = settlement.deliver('LOG', 25);
    expect(r.accepted).toBe(10);
    expect(r.stageCompleted).toBe(true);
  });

  it('rejects cargo the stage does not need', () => {
    expect(settlement.deliver('FIRERUNE', 3).accepted).toBe(0);
  });

  it('finishes the ladder', () => {
    settlement.deliver('LOG', 10);
    settlement.deliver('LOG', 5);
    settlement.deliver('MINERAL', 5);
    expect(settlement.currentStage()).toBeUndefined();
    expect(settlement.deliver('LOG', 1).accepted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/settlement.js`.

- [ ] **Step 3: Write the implementation**

`server/src/settlement.ts`:
```ts
import type Database from 'better-sqlite3';
import type { TokenId } from './tokens.js';

export interface Stage {
  index: number;
  name: string;
  needs: Partial<Record<TokenId, number>>;
}

export const DEFAULT_STAGES: Stage[] = [
  { index: 0, name: 'Landing Dock', needs: { LOG: 100 } },
  { index: 1, name: 'Great Hall', needs: { LOG: 200, MINERAL: 100 } },
  { index: 2, name: 'Market Row', needs: { LOG: 150, MINERAL: 150, FURNITURE: 50 } },
  { index: 3, name: 'Rune Beacon', needs: { MINERAL: 200, FIRERUNE: 20 } },
];

export class Settlement {
  constructor(private db: Database.Database, private stages: Stage[]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_progress (
        stage INTEGER NOT NULL,
        token TEXT NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (stage, token)
      );
      CREATE TABLE IF NOT EXISTS settlement_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_stage INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO settlement_state (id, current_stage) VALUES (1, 0);
    `);
  }

  private stageIndex(): number {
    const row = this.db
      .prepare('SELECT current_stage FROM settlement_state WHERE id = 1')
      .get() as { current_stage: number };
    return row.current_stage;
  }

  currentStage(): Stage | undefined {
    return this.stages[this.stageIndex()];
  }

  completedStages(): number {
    return Math.min(this.stageIndex(), this.stages.length);
  }

  received(): Partial<Record<TokenId, number>> {
    const rows = this.db
      .prepare('SELECT token, amount FROM settlement_progress WHERE stage = ?')
      .all(this.stageIndex()) as { token: TokenId; amount: number }[];
    const out: Partial<Record<TokenId, number>> = {};
    for (const r of rows) out[r.token] = r.amount;
    return out;
  }

  remainingNeeds(): Partial<Record<TokenId, number>> {
    const stage = this.currentStage();
    if (!stage) return {};
    const got = this.received();
    const out: Partial<Record<TokenId, number>> = {};
    for (const [token, need] of Object.entries(stage.needs) as [TokenId, number][]) {
      const rem = need - (got[token] ?? 0);
      if (rem > 0) out[token] = rem;
    }
    return out;
  }

  deliver(token: TokenId, amount: number): { accepted: number; stageCompleted: boolean } {
    const stage = this.currentStage();
    if (!stage) return { accepted: 0, stageCompleted: false };
    const remaining = this.remainingNeeds()[token] ?? 0;
    const accepted = Math.min(remaining, Math.max(0, amount));
    if (accepted === 0) return { accepted: 0, stageCompleted: false };

    this.db
      .prepare(`
        INSERT INTO settlement_progress (stage, token, amount) VALUES (?, ?, ?)
        ON CONFLICT(stage, token) DO UPDATE SET amount = amount + excluded.amount
      `)
      .run(stage.index, token, accepted);

    const stageCompleted = Object.keys(this.remainingNeeds()).length === 0;
    if (stageCompleted) {
      this.db
        .prepare('UPDATE settlement_state SET current_stage = current_stage + 1 WHERE id = 1')
        .run();
    }
    return { accepted, stageCompleted };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/settlement.ts server/test/settlement.test.ts && git commit -m "feat(server): shared settlement build stages"
```

---

### Task 7: Crew market

**Files:**
- Create: `server/src/crew.ts`
- Test: `server/test/crew.test.ts`

**Interfaces:**
- Consumes: `FleetSource`, `CrewMember` from `fleet.ts`.
- Produces:
  - `interface Listing { crewId: string; owner: string; sharePct: number }`
  - `class CrewMarket { constructor(db: Database.Database, fleet: FleetSource); list(crewId: string, wallet: string, sharePct: number): Listing; unlist(crewId: string, wallet: string): void; listings(): Listing[]; getListing(crewId: string): Listing | undefined }`
  - `list` throws `Error` unless the wallet owns the crew NFT (per `fleet.getCrew`), `1 <= sharePct <= 50`. Re-listing updates the share.

- [ ] **Step 1: Write the failing test**

`server/test/crew.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DevFleet, devFixtures } from '../src/fleet.js';
import { CrewMarket } from '../src/crew.js';

let market: CrewMarket;
beforeEach(() => {
  const { ships, crew } = devFixtures();
  market = new CrewMarket(new Database(':memory:'), new DevFleet(ships, crew));
});

describe('crew market', () => {
  it('lists owned crew with a share', () => {
    market.list('crew-1', 'bob', 15);
    expect(market.listings()).toEqual([{ crewId: 'crew-1', owner: 'bob', sharePct: 15 }]);
  });
  it('rejects listing crew you do not own', () => {
    expect(() => market.list('crew-1', 'alice', 15)).toThrow(/own/);
  });
  it('bounds share to 1..50', () => {
    expect(() => market.list('crew-1', 'bob', 0)).toThrow(/share/);
    expect(() => market.list('crew-1', 'bob', 51)).toThrow(/share/);
  });
  it('re-listing updates the share; unlist removes', () => {
    market.list('crew-1', 'bob', 15);
    market.list('crew-1', 'bob', 20);
    expect(market.getListing('crew-1')?.sharePct).toBe(20);
    market.unlist('crew-1', 'bob');
    expect(market.getListing('crew-1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/crew.js`.

- [ ] **Step 3: Write the implementation**

`server/src/crew.ts`:
```ts
import type Database from 'better-sqlite3';
import type { FleetSource } from './fleet.js';

export interface Listing {
  crewId: string;
  owner: string;
  sharePct: number;
}

export class CrewMarket {
  constructor(private db: Database.Database, private fleet: FleetSource) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crew_listings (
        crew_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        share_pct INTEGER NOT NULL
      )
    `);
  }

  list(crewId: string, wallet: string, sharePct: number): Listing {
    const member = this.fleet.getCrew(crewId);
    if (!member || member.owner !== wallet) {
      throw new Error(`wallet ${wallet} does not own crew ${crewId}`);
    }
    if (!Number.isInteger(sharePct) || sharePct < 1 || sharePct > 50) {
      throw new Error('share must be an integer 1..50');
    }
    this.db
      .prepare(`
        INSERT INTO crew_listings (crew_id, owner, share_pct) VALUES (?, ?, ?)
        ON CONFLICT(crew_id) DO UPDATE SET share_pct = excluded.share_pct
      `)
      .run(crewId, wallet, sharePct);
    return { crewId, owner: wallet, sharePct };
  }

  unlist(crewId: string, wallet: string): void {
    this.db.prepare('DELETE FROM crew_listings WHERE crew_id = ? AND owner = ?').run(crewId, wallet);
  }

  listings(): Listing[] {
    const rows = this.db
      .prepare('SELECT crew_id, owner, share_pct FROM crew_listings')
      .all() as { crew_id: string; owner: string; share_pct: number }[];
    return rows.map((r) => ({ crewId: r.crew_id, owner: r.owner, sharePct: r.share_pct }));
  }

  getListing(crewId: string): Listing | undefined {
    return this.listings().find((l) => l.crewId === crewId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/crew.ts server/test/crew.test.ts && git commit -m "feat(server): crew listing market with bounded shares"
```

---

### Task 8: Run telemetry validation

**Files:**
- Create: `server/src/validation.ts`
- Test: `server/test/validation.test.ts`

**Interfaces:**
- Consumes: `Ship`, `CrewMember` from `fleet.ts`.
- Produces:
  - `interface Telemetry { durationS: number; fuelSpent: number; cargoDelivered: number }`
  - `interface RunParams { distance: number; missionAmount: number }`
  - `function minFuel(distance: number, crew: CrewMember[]): number` — `ceil(distance * (1 - min(totalFuelSkill, 50)/100))`
  - `function validateRun(params: RunParams, ship: Ship, crew: CrewMember[], t: Telemetry): { ok: true } | { ok: false; reason: string }`
  - Rules: `durationS >= distance / ship.engine`; `fuelSpent >= minFuel(distance, crew)`; `cargoDelivered <= min(ship.cargo, params.missionAmount)`; all fields finite and non-negative.

- [ ] **Step 1: Write the failing test**

`server/test/validation.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateRun, minFuel, type Telemetry } from '../src/validation.js';
import type { Ship, CrewMember } from '../src/fleet.js';

const ship: Ship = { id: 's', owner: 'alice', engine: 10, cargo: 20, crewSlots: 2 };
const fuelCrew: CrewMember = { id: 'c', owner: 'bob', skills: { fuel: 20 } };
const params = { distance: 100, missionAmount: 15 };
const goodRun: Telemetry = { durationS: 12, fuelSpent: 90, cargoDelivered: 15 };

describe('minFuel', () => {
  it('applies crew fuel skill', () => {
    expect(minFuel(100, [])).toBe(100);
    expect(minFuel(100, [fuelCrew])).toBe(80);
  });
  it('caps total skill at 50%', () => {
    const maxed: CrewMember[] = [
      { id: 'a', owner: 'x', skills: { fuel: 40 } },
      { id: 'b', owner: 'y', skills: { fuel: 40 } },
    ];
    expect(minFuel(100, maxed)).toBe(50);
  });
});

describe('validateRun', () => {
  it('accepts a physically possible run', () => {
    expect(validateRun(params, ship, [fuelCrew], goodRun)).toEqual({ ok: true });
  });
  it('rejects faster-than-engine runs', () => {
    const r = validateRun(params, ship, [], { ...goodRun, durationS: 5, fuelSpent: 100 });
    expect(r.ok).toBe(false);
  });
  it('rejects less fuel than the route minimum', () => {
    const r = validateRun(params, ship, [], { ...goodRun, fuelSpent: 60 });
    expect(r.ok).toBe(false);
  });
  it('rejects cargo over ship capacity or mission amount', () => {
    expect(validateRun(params, ship, [fuelCrew], { ...goodRun, cargoDelivered: 21 }).ok).toBe(false);
    expect(validateRun({ distance: 100, missionAmount: 5 }, ship, [fuelCrew], { ...goodRun, cargoDelivered: 6 }).ok).toBe(false);
  });
  it('rejects garbage numbers', () => {
    expect(validateRun(params, ship, [], { durationS: -1, fuelSpent: 100, cargoDelivered: 1 }).ok).toBe(false);
    expect(validateRun(params, ship, [], { durationS: NaN, fuelSpent: 100, cargoDelivered: 1 }).ok).toBe(false);
  });
  it('property: random impossible telemetries are rejected', () => {
    for (let i = 0; i < 200; i++) {
      const cheat: Telemetry = {
        durationS: Math.random() * (params.distance / ship.engine) * 0.99,
        fuelSpent: Math.random() * minFuel(params.distance, []) * 0.99,
        cargoDelivered: ship.cargo + 1 + Math.floor(Math.random() * 100),
      };
      expect(validateRun(params, ship, [], cheat).ok).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/validation.js`.

- [ ] **Step 3: Write the implementation**

`server/src/validation.ts`:
```ts
import type { Ship, CrewMember } from './fleet.js';

export interface Telemetry {
  durationS: number;
  fuelSpent: number;
  cargoDelivered: number;
}

export interface RunParams {
  distance: number;
  missionAmount: number;
}

export function minFuel(distance: number, crew: CrewMember[]): number {
  const skill = Math.min(
    crew.reduce((sum, c) => sum + (c.skills.fuel ?? 0), 0),
    50,
  );
  return Math.ceil(distance * (1 - skill / 100));
}

export function validateRun(
  params: RunParams,
  ship: Ship,
  crew: CrewMember[],
  t: Telemetry,
): { ok: true } | { ok: false; reason: string } {
  const nums = [t.durationS, t.fuelSpent, t.cargoDelivered];
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
    return { ok: false, reason: 'telemetry values must be finite and non-negative' };
  }
  if (t.durationS < params.distance / ship.engine) {
    return { ok: false, reason: 'run faster than ENGINE allows' };
  }
  if (t.fuelSpent < minFuel(params.distance, crew)) {
    return { ok: false, reason: 'less fuel than the route minimum' };
  }
  if (t.cargoDelivered > Math.min(ship.cargo, params.missionAmount)) {
    return { ok: false, reason: 'cargo exceeds ship capacity or mission amount' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/validation.ts server/test/validation.test.ts && git commit -m "feat(server): physics sanity validation for run telemetry"
```

---

### Task 9: Mission engine with atomic payouts

**Files:**
- Create: `server/src/missions.ts`
- Test: `server/test/missions.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `Leg` (`ledger.ts`); `Settlement` (`settlement.ts`); `CrewMarket` (`crew.ts`); `FleetSource` (`fleet.ts`); `TOKENS`, `TokenId`, `CARGO_TOKENS` (`tokens.ts`); `validateRun`, `minFuel`, `Telemetry` (`validation.ts`).
- Produces:
  - `interface Mission { id: string; cargo: TokenId; amount: number; origin: string; distance: number; rewardGold: number; feeGold: number; status: 'open'|'active'|'done'|'failed'; pilot?: string; shipId?: string; crewIds?: string[] }`
  - `interface Payout { rewardGold: number; crewShares: { owner: string; gold: number }[]; fuelBurned: number; delivered: number; stageCompleted: boolean }`
  - `class MissionEngine { constructor(db, ledger, settlement, market, fleet); generate(count: number): Mission[]; open(): Mission[]; get(id: string): Mission | undefined; accept(id: string, wallet: string, shipId: string, crewIds: string[]): Mission; complete(id: string, telemetry: Telemetry): Payout; fail(id: string): void }`
  - Reward = `amount * TOKENS[cargo].unitPriceGold`; fee = `max(1, floor(reward / 10))`.
  - `accept` checks: mission open; pilot owns ship; crew are listed on the market (or owned by the pilot, share 0); crew count ≤ ship.crewSlots; total hired share ≤ 50; pilot GOLD ≥ fee (escrowed to `escrow:<id>`); pilot FUEL ≥ `minFuel(distance, crew)`.
  - `complete` validates telemetry, then posts ONE atomic ledger event: fee escrow → `settlement`; FUEL `fuelSpent` → `burn`; GOLD reward minted split pilot/crew-owners; cargo `delivered` minted to `settlement` account; then advances `Settlement.deliver`.
  - `fail`: escrowed fee → `settlement`, mission → `failed`.

- [ ] **Step 1: Write the failing test**

`server/test/missions.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '../src/ledger.js';
import { Settlement, type Stage } from '../src/settlement.js';
import { CrewMarket } from '../src/crew.js';
import { DevFleet, devFixtures } from '../src/fleet.js';
import { MissionEngine } from '../src/missions.js';

const stages: Stage[] = [{ index: 0, name: 'Dock', needs: { LOG: 100 } }];

let db: Database.Database;
let ledger: Ledger;
let engine: MissionEngine;
let market: CrewMarket;

beforeEach(() => {
  db = new Database(':memory:');
  ledger = new Ledger(db);
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);
  market = new CrewMarket(db, fleet);
  engine = new MissionEngine(db, ledger, new Settlement(db, stages), market, fleet);
  // fund alice: 100 GOLD, 200 FUEL
  ledger.post('seed', [
    { account: 'mint', token: 'GOLD', amount: -100 },
    { account: 'wallet:alice', token: 'GOLD', amount: 100 },
    { account: 'mint', token: 'FUEL', amount: -200 },
    { account: 'wallet:alice', token: 'FUEL', amount: 200 },
  ]);
});

describe('mission generation', () => {
  it('generates missions from settlement needs with priced rewards', () => {
    const [m] = engine.generate(1);
    expect(m.cargo).toBe('LOG');
    expect(m.rewardGold).toBe(m.amount * 1); // LOG price
    expect(m.feeGold).toBe(Math.max(1, Math.floor(m.rewardGold / 10)));
    expect(m.status).toBe('open');
  });
});

describe('accept', () => {
  it('escrows the fee and activates the mission', () => {
    market.list('crew-1', 'bob', 15);
    const [m] = engine.generate(1);
    const active = engine.accept(m.id, 'alice', 'ship-1', ['crew-1']);
    expect(active.status).toBe('active');
    expect(ledger.balance(`escrow:${m.id}`, 'GOLD')).toBe(m.feeGold);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(100 - m.feeGold);
  });
  it('rejects a ship the pilot does not own', () => {
    const [m] = engine.generate(1);
    expect(() => engine.accept(m.id, 'alice', 'ship-2', [])).toThrow(/ship/);
  });
  it('rejects unlisted crew belonging to someone else', () => {
    const [m] = engine.generate(1);
    expect(() => engine.accept(m.id, 'alice', 'ship-1', ['crew-2'])).toThrow(/crew/);
  });
  it('rejects crew over the ship slots', () => {
    market.list('crew-2', 'carol', 10);
    market.list('crew-3', 'carol', 10);
    market.list('crew-1', 'bob', 10);
    const [m] = engine.generate(1);
    expect(() =>
      engine.accept(m.id, 'alice', 'ship-1', ['crew-1', 'crew-2', 'crew-3']),
    ).toThrow(/slots/);
  });
  it('rejects insufficient fuel', () => {
    ledger.post('drain fuel', [
      { account: 'wallet:alice', token: 'FUEL', amount: -200 },
      { account: 'burn', token: 'FUEL', amount: 200 },
    ]);
    const [m] = engine.generate(1);
    expect(() => engine.accept(m.id, 'alice', 'ship-1', [])).toThrow(/fuel/i);
  });
});

describe('complete', () => {
  it('pays pilot and crew owners, burns fuel, feeds the settlement — atomically', () => {
    market.list('crew-1', 'bob', 15);
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', ['crew-1']);
    const goldBefore = ledger.balance('wallet:alice', 'GOLD');
    const fuelBefore = ledger.balance('wallet:alice', 'FUEL');

    const delivered = Math.min(20, m.amount); // ship-1 cargo = 20
    const payout = engine.complete(m.id, {
      durationS: m.distance / 10 + 1, // ship-1 engine = 10
      fuelSpent: m.distance, // no-skill minimum is fine (skill only lowers it)
      cargoDelivered: delivered,
    });

    const share = Math.floor((payout.rewardGold * 15) / 100);
    expect(payout.crewShares).toEqual([{ owner: 'bob', gold: share }]);
    expect(payout.delivered).toBe(delivered);
    expect(ledger.balance('wallet:bob', 'GOLD')).toBe(share);
    expect(ledger.balance('wallet:alice', 'GOLD')).toBe(goldBefore + payout.rewardGold - share);
    expect(ledger.balance('wallet:alice', 'FUEL')).toBe(fuelBefore - m.distance);
    expect(ledger.balance('settlement', 'GOLD')).toBe(m.feeGold);
    expect(ledger.balance('settlement', 'LOG')).toBe(delivered);
    expect(ledger.balance(`escrow:${m.id}`, 'GOLD')).toBe(0);
    expect(engine.get(m.id)?.status).toBe('done');
  });

  it('reward is proportional to delivered cargo, not mission amount', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    const delivered = Math.min(20, m.amount);
    const payout = engine.complete(m.id, {
      durationS: m.distance / 10 + 1,
      fuelSpent: m.distance,
      cargoDelivered: delivered,
    });
    expect(payout.rewardGold).toBe(delivered * 1);
  });

  it('rejects impossible telemetry and keeps the mission active', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    expect(() =>
      engine.complete(m.id, { durationS: 0.01, fuelSpent: 0, cargoDelivered: 5 }),
    ).toThrow(/rejected/);
    expect(engine.get(m.id)?.status).toBe('active');
  });
});

describe('fail', () => {
  it('forfeits the fee to the settlement', () => {
    const [m] = engine.generate(1);
    engine.accept(m.id, 'alice', 'ship-1', []);
    engine.fail(m.id);
    expect(ledger.balance('settlement', 'GOLD')).toBe(m.feeGold);
    expect(ledger.balance(`escrow:${m.id}`, 'GOLD')).toBe(0);
    expect(engine.get(m.id)?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/missions.js`.

- [ ] **Step 3: Write the implementation**

`server/src/missions.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Ledger, type Leg } from './ledger.js';
import { Settlement } from './settlement.js';
import { CrewMarket } from './crew.js';
import type { FleetSource, CrewMember } from './fleet.js';
import { TOKENS, type TokenId } from './tokens.js';
import { validateRun, minFuel, type Telemetry } from './validation.js';

export interface Mission {
  id: string;
  cargo: TokenId;
  amount: number;
  origin: string;
  distance: number;
  rewardGold: number;
  feeGold: number;
  status: 'open' | 'active' | 'done' | 'failed';
  pilot?: string;
  shipId?: string;
  crewIds?: string[];
}

export interface Payout {
  rewardGold: number;
  crewShares: { owner: string; gold: number }[];
  fuelBurned: number;
  delivered: number;
  stageCompleted: boolean;
}

const ORIGINS = ['Isla Verde', 'Ironspire', 'Woodhaven', 'Runefall'];

export class MissionEngine {
  constructor(
    private db: Database.Database,
    private ledger: Ledger,
    private settlement: Settlement,
    private market: CrewMarket,
    private fleet: FleetSource,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `);
  }

  private save(m: Mission): void {
    this.db
      .prepare('INSERT INTO missions (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(m.id, JSON.stringify(m));
  }

  get(id: string): Mission | undefined {
    const row = this.db.prepare('SELECT data FROM missions WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Mission) : undefined;
  }

  open(): Mission[] {
    const rows = this.db.prepare('SELECT data FROM missions').all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Mission).filter((m) => m.status === 'open');
  }

  generate(count: number): Mission[] {
    const needs = Object.entries(this.settlement.remainingNeeds()) as [TokenId, number][];
    if (needs.length === 0) return [];
    const out: Mission[] = [];
    for (let i = 0; i < count; i++) {
      const [cargo, remaining] = needs[i % needs.length];
      const amount = Math.max(1, Math.min(remaining, 5 + Math.floor(Math.random() * 16))); // 5..20 units
      const rewardGold = amount * TOKENS[cargo].unitPriceGold;
      const m: Mission = {
        id: randomUUID(),
        cargo,
        amount,
        origin: ORIGINS[Math.floor(Math.random() * ORIGINS.length)],
        distance: 50 + Math.floor(Math.random() * 101), // 50..150
        rewardGold,
        feeGold: Math.max(1, Math.floor(rewardGold / 10)),
        status: 'open',
      };
      this.save(m);
      out.push(m);
    }
    return out;
  }

  private resolveCrew(pilot: string, crewIds: string[]): { member: CrewMember; sharePct: number }[] {
    return crewIds.map((id) => {
      const member = this.fleet.getCrew(id);
      if (!member) throw new Error(`unknown crew ${id}`);
      if (member.owner === pilot) return { member, sharePct: 0 }; // own crew fly free
      const listing = this.market.getListing(id);
      if (!listing) throw new Error(`crew ${id} is not listed for hire`);
      return { member, sharePct: listing.sharePct };
    });
  }

  accept(id: string, wallet: string, shipId: string, crewIds: string[]): Mission {
    const m = this.get(id);
    if (!m || m.status !== 'open') throw new Error(`mission ${id} is not open`);
    const ship = this.fleet.getShip(shipId);
    if (!ship || ship.owner !== wallet) throw new Error(`wallet ${wallet} does not own ship ${shipId}`);
    if (crewIds.length > ship.crewSlots) {
      throw new Error(`crew exceeds ship slots (${ship.crewSlots})`);
    }
    const crew = this.resolveCrew(wallet, crewIds);
    const totalShare = crew.reduce((s, c) => s + c.sharePct, 0);
    if (totalShare > 50) throw new Error(`total crew share ${totalShare}% exceeds 50%`);
    const fuelNeed = minFuel(m.distance, crew.map((c) => c.member));
    if (this.ledger.balance(`wallet:${wallet}`, 'FUEL') < fuelNeed) {
      throw new Error(`insufficient FUEL: need at least ${fuelNeed}`);
    }
    // fee escrow (throws InsufficientFunds if pilot lacks GOLD)
    this.ledger.post(`fee escrow ${m.id}`, [
      { account: `wallet:${wallet}`, token: 'GOLD', amount: -m.feeGold },
      { account: `escrow:${m.id}`, token: 'GOLD', amount: m.feeGold },
    ]);
    const active: Mission = { ...m, status: 'active', pilot: wallet, shipId, crewIds };
    this.save(active);
    return active;
  }

  complete(id: string, telemetry: Telemetry): Payout {
    const m = this.get(id);
    if (!m || m.status !== 'active' || !m.pilot || !m.shipId) {
      throw new Error(`mission ${id} is not active`);
    }
    const ship = this.fleet.getShip(m.shipId)!;
    const crew = this.resolveCrew(m.pilot, m.crewIds ?? []);
    const verdict = validateRun(
      { distance: m.distance, missionAmount: m.amount },
      ship,
      crew.map((c) => c.member),
      telemetry,
    );
    if (!verdict.ok) throw new Error(`run rejected: ${verdict.reason}`);

    const delivered = Math.floor(telemetry.cargoDelivered);
    const rewardGold = delivered * TOKENS[m.cargo].unitPriceGold;
    const fuelBurned = Math.ceil(telemetry.fuelSpent);
    const crewShares = crew
      .filter((c) => c.sharePct > 0)
      .map((c) => ({ owner: c.member.owner, gold: Math.floor((rewardGold * c.sharePct) / 100) }));
    const pilotGold = rewardGold - crewShares.reduce((s, c) => s + c.gold, 0);

    const legs: Leg[] = [
      // fee: escrow → settlement
      { account: `escrow:${m.id}`, token: 'GOLD', amount: -m.feeGold },
      { account: 'settlement', token: 'GOLD', amount: m.feeGold },
      // fuel burn
      { account: `wallet:${m.pilot}`, token: 'FUEL', amount: -fuelBurned },
      { account: 'burn', token: 'FUEL', amount: fuelBurned },
      // reward mint, split
      { account: 'mint', token: 'GOLD', amount: -rewardGold },
      { account: `wallet:${m.pilot}`, token: 'GOLD', amount: pilotGold },
      ...crewShares.map((c) => ({
        account: `wallet:${c.owner}`,
        token: 'GOLD' as TokenId,
        amount: c.gold,
      })),
      // cargo mint into the settlement's account
      { account: 'mint', token: m.cargo, amount: -delivered },
      { account: 'settlement', token: m.cargo, amount: delivered },
    ];
    this.ledger.post(`mission complete ${m.id}`, legs);

    const { stageCompleted } = this.settlement.deliver(m.cargo, delivered);
    this.save({ ...m, status: 'done' });
    return { rewardGold, crewShares, fuelBurned, delivered, stageCompleted };
  }

  fail(id: string): void {
    const m = this.get(id);
    if (!m || m.status !== 'active') throw new Error(`mission ${id} is not active`);
    this.ledger.post(`mission failed ${m.id}`, [
      { account: `escrow:${m.id}`, token: 'GOLD', amount: -m.feeGold },
      { account: 'settlement', token: 'GOLD', amount: m.feeGold },
    ]);
    this.save({ ...m, status: 'failed' });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/missions.ts server/test/missions.test.ts && git commit -m "feat(server): mission engine with escrow, atomic payouts, crew shares"
```

---

### Task 10: HTTP API + dev boot

**Files:**
- Create: `server/src/app.ts`
- Create: `server/src/index.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `function buildApp(opts?: { dbPath?: string }): FastifyInstance` — wires Ledger, DevFleet(devFixtures), Grants, Settlement(DEFAULT_STAGES), CrewMarket, MissionEngine on one SQLite db (`:memory:` default; file path for `index.ts`).
  - Dev auth: wallet address read from the `x-wallet` request header (documented as replaced by signature auth in the chain-gateway plan). Requests without it get 401.
  - Routes:
    - `POST /login` → `{ wallet, ships, crew, granted }` (runs `grantShipOwner`)
    - `GET /balances` → `{ GOLD, FUEL, LOG, MINERAL, FURNITURE, FIRERUNE }` for the caller
    - `GET /missions` → open missions; `POST /missions/generate { count }` → new missions (dev/admin)
    - `POST /missions/:id/accept { shipId, crewIds }` → mission
    - `POST /missions/:id/complete { telemetry }` → payout
    - `POST /missions/:id/fail` → `{ ok: true }`
    - `GET /settlement` → `{ stage, received, remainingNeeds, completedStages }`
    - `GET /crew/market` → listings; `POST /crew/list { crewId, sharePct }`; `POST /crew/unlist { crewId }`
    - `POST /admin/airdrop { wallets, amount }` → `{ credited }`
  - Domain errors map to HTTP 400 with `{ error: message }`.

- [ ] **Step 1: Write the failing test**

`server/test/app.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';

type App = ReturnType<typeof buildApp>;
let app: App;
beforeEach(() => {
  app = buildApp();
});

const asAlice = { 'x-wallet': 'alice' };

describe('api', () => {
  it('401s without a wallet header', async () => {
    const res = await app.inject({ method: 'GET', url: '/balances' });
    expect(res.statusCode).toBe(401);
  });

  it('login grants the ship owner once', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.granted).toBe(true);
    expect(body.ships[0].id).toBe('ship-1');
    const again = await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    expect(again.json().granted).toBe(false);
  });

  it('full mission round trip over HTTP', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const gen = await app.inject({
      method: 'POST', url: '/missions/generate', headers: asAlice, payload: { count: 1 },
    });
    const [m] = gen.json();

    const acc = await app.inject({
      method: 'POST', url: `/missions/${m.id}/accept`, headers: asAlice,
      payload: { shipId: 'ship-1', crewIds: [] },
    });
    expect(acc.statusCode).toBe(200);

    const done = await app.inject({
      method: 'POST', url: `/missions/${m.id}/complete`, headers: asAlice,
      payload: { telemetry: { durationS: m.distance / 10 + 1, fuelSpent: m.distance, cargoDelivered: Math.min(20, m.amount) } },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().delivered).toBeGreaterThan(0);

    const bal = await app.inject({ method: 'GET', url: '/balances', headers: asAlice });
    expect(bal.json().GOLD).toBeGreaterThan(0);

    const s = await app.inject({ method: 'GET', url: '/settlement', headers: asAlice });
    expect(s.json().received.LOG ?? s.json().received[m.cargo]).toBeGreaterThan(0);
  });

  it('domain errors come back as 400 with a message', async () => {
    await app.inject({ method: 'POST', url: '/login', headers: asAlice });
    const res = await app.inject({
      method: 'POST', url: '/missions/nope/accept', headers: asAlice,
      payload: { shipId: 'ship-1', crewIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not open/);
  });

  it('airdrops fuel', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/airdrop', headers: asAlice,
      payload: { wallets: ['alice', 'bob'], amount: 10 },
    });
    expect(res.json().credited).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/skyharbour/server && npm test`
Expected: FAIL — cannot find module `../src/app.js`.

- [ ] **Step 3: Write the implementation**

`server/src/app.ts`:
```ts
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { Ledger } from './ledger.js';
import { DevFleet, devFixtures } from './fleet.js';
import { Grants } from './grants.js';
import { Settlement, DEFAULT_STAGES } from './settlement.js';
import { CrewMarket } from './crew.js';
import { MissionEngine } from './missions.js';
import { TOKENS, type TokenId } from './tokens.js';
import type { Telemetry } from './validation.js';

export function buildApp(opts: { dbPath?: string } = {}) {
  const db = new Database(opts.dbPath ?? ':memory:');
  const ledger = new Ledger(db);
  const { ships, crew } = devFixtures();
  const fleet = new DevFleet(ships, crew);
  const grants = new Grants(db, ledger, fleet);
  const settlement = new Settlement(db, DEFAULT_STAGES);
  const market = new CrewMarket(db, fleet);
  const missions = new MissionEngine(db, ledger, settlement, market, fleet);

  const app = Fastify();

  app.addHook('onRequest', async (req, reply) => {
    const wallet = req.headers['x-wallet'];
    if (typeof wallet !== 'string' || wallet.length === 0) {
      return reply.code(401).send({ error: 'missing x-wallet header (dev auth)' });
    }
    (req as unknown as { wallet: string }).wallet = wallet;
  });

  app.setErrorHandler((err, _req, reply) => {
    reply.code(400).send({ error: err.message });
  });

  const walletOf = (req: unknown): string => (req as { wallet: string }).wallet;

  app.post('/login', async (req) => {
    const wallet = walletOf(req);
    const granted = grants.grantShipOwner(wallet);
    return { wallet, ships: fleet.shipsOf(wallet), crew: fleet.crewOf(wallet), granted };
  });

  app.get('/balances', async (req) => {
    const wallet = walletOf(req);
    const out: Partial<Record<TokenId, number>> = {};
    for (const id of Object.keys(TOKENS) as TokenId[]) {
      out[id] = ledger.balance(`wallet:${wallet}`, id);
    }
    return out;
  });

  app.get('/missions', async () => missions.open());

  app.post('/missions/generate', async (req) => {
    const { count } = req.body as { count: number };
    return missions.generate(count);
  });

  app.post('/missions/:id/accept', async (req) => {
    const { id } = req.params as { id: string };
    const { shipId, crewIds } = req.body as { shipId: string; crewIds: string[] };
    return missions.accept(id, walletOf(req), shipId, crewIds ?? []);
  });

  app.post('/missions/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const { telemetry } = req.body as { telemetry: Telemetry };
    return missions.complete(id, telemetry);
  });

  app.post('/missions/:id/fail', async (req) => {
    const { id } = req.params as { id: string };
    missions.fail(id);
    return { ok: true };
  });

  app.get('/settlement', async () => ({
    stage: settlement.currentStage() ?? null,
    received: settlement.received(),
    remainingNeeds: settlement.remainingNeeds(),
    completedStages: settlement.completedStages(),
  }));

  app.get('/crew/market', async () => market.listings());

  app.post('/crew/list', async (req) => {
    const { crewId, sharePct } = req.body as { crewId: string; sharePct: number };
    return market.list(crewId, walletOf(req), sharePct);
  });

  app.post('/crew/unlist', async (req) => {
    const { crewId } = req.body as { crewId: string };
    market.unlist(crewId, walletOf(req));
    return { ok: true };
  });

  app.post('/admin/airdrop', async (req) => {
    const { wallets, amount } = req.body as { wallets: string[]; amount: number };
    return { credited: grants.airdropFuel(wallets, amount) };
  });

  return app;
}
```

`server/src/index.ts`:
```ts
import { buildApp } from './app.js';

const app = buildApp({ dbPath: process.env.SKYHARBOUR_DB ?? 'skyharbour.db' });
const port = Number(process.env.PORT ?? 8420);

app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`skyharbour economy core listening on :${port}`);
});
```

- [ ] **Step 4: Run tests, then boot smoke**

Run: `cd ~/skyharbour/server && npm test`
Expected: all pass.

Run: `cd ~/skyharbour/server && npx tsx src/index.ts & sleep 2 && curl -s -X POST -H 'x-wallet: alice' localhost:8420/login && kill %1`
Expected: JSON with `"granted":true` and alice's ship.

- [ ] **Step 5: Commit**

```bash
cd ~/skyharbour && git add server/src/app.ts server/src/index.ts server/test/app.test.ts && git commit -m "feat(server): HTTP API wiring the economy core end to end"
```

---

## Self-review notes

- Spec coverage: ledger (§4/§7), grants + airdrop (§6 as amended), settlement (§5/§6), crew market + shares (§5), missions + atomic payout + escrow + fuel sink (§5/§6), validation (§7), API surface for the future client (§4). **Deliberately out of this plan** (per plan header): Solana chain gateway + claim flow + signature login (plan 2), Three.js client + dapp UI (plan 3).
- Types cross-checked: `Leg`, `TokenId`, `Ship`, `CrewMember`, `Telemetry`, `Mission`, `Payout` signatures match across tasks.
- Reward pays on **delivered** units (a ship smaller than the mission amount earns proportionally) — this is intentional and tested.
