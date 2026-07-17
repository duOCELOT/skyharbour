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
