export interface DiagnosticEntry { timestamp?: string; time?: string; event?: string; agentId?: string; reason?: string; bytes?: number; [field: string]: unknown }
export interface WindowCounts { windows: number; byReason: Record<string, number>; bytes: number[]; requests: { fill: number; older: number }; quotaRefusals: number }
export interface HoleCheck { nativeMessages: number; servedMessages: number; missing: Array<{ id: unknown; role: string; preview: string }> }
export interface MixStep { kind: string; windows: WindowCounts; holes?: HoleCheck }
export function percentile(values: number[], p: number): number | null;
export function stats(values: number[]): { n: number; p50: number | null; p95: number | null; max: number | null };
export function windowCounts(entries: DiagnosticEntry[], range?: { fromMs?: number; toMs?: number; agentId?: string }): WindowCounts;
export function answeredBy(entries: DiagnosticEntry[], open: { agentId: string; fromMs: number; toMs: number }): 'controller' | 'journal';
export function agentIdOfSocket(url: string): string | undefined;
export function controllerJournalEvents(entries: DiagnosticEntry[], range?: { fromMs?: number; toMs?: number }): Record<string, number>;
export function holeCheck(nativeEntries: Array<{ id?: unknown; role?: string; text?: string }>, servedTexts: string[]): HoleCheck;
export function mixThresholds(steps: MixStep[]): Record<string, number | boolean | null>;
