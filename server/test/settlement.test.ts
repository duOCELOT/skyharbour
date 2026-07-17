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
