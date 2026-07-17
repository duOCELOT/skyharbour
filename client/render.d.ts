export function escapeHtml(s: unknown): string;
export function renderTicker(bal: Record<string, number>): string;
export function renderManifest(bal: Record<string, number>): string;
export function renderHangar(ships: { id: string; owner?: string; engine: number; cargo: number; crewSlots: number; hull: number; currentHull?: number }[]): string;
export function renderBoard(missions: any[]): string;
export function renderGhostRuns(missions: any[]): string;
export function renderSettlement(state: any): string;
export function renderPanel(bal: Record<string, number>, settlementState: any, ship?: { id: string; hull: number; currentHull?: number } | null): string;
export function renderCrewMarket(listings: any[], ownCrew: any[]): string;
