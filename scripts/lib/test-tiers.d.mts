export type Tier = 'unit' | 'process' | 'native' | 'browser';
export function tierOf(file: string, project?: string): Tier;
export const realStackTiers: Set<string>;
export function countTiers(measured: readonly { tier: string; durationMs: number }[], warnMs?: number, failMs?: number): Record<string, { tests: number; over300ms: number; over1s: number }>;
