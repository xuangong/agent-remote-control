export interface PlannedSession { id: string; provider: string }
export interface ChurnAction { at: number; action: 'open' | 'fold' | 'sleep' | 'wake'; session: string }
export function planManySessions(options?: { seed?: number; sessionCount?: number; groupSize?: number; actions?: number; spacingMs?: number }): { seed: number; sessions: PlannedSession[]; group: string[]; plan: ChurnAction[] };
