export const ARMS: string[];
export const CONDITIONS: Array<[string, string]>;
export function usable<T extends { journalServed?: boolean }>(arm: string, samples: T[]): T[];
export function figure(values: Array<number | null | undefined>, minimum: number): string;
export function rowSurvival(samples: Array<{ rows?: { total: number; alive: number }; rowlessStates?: number }>): { n: number; rows: number; rekeyed: number; rowlessMax: number };
export function composerKept(sample: { composerBefore?: { text: string; selectionStart: number; selectionEnd: number }; composerAfter?: { text: string; selectionStart: number; selectionEnd: number }; composerUnchanged?: boolean }): boolean;
export function replacementResult(samples: Array<Record<string, unknown>>): { pass: boolean; forced: number; rows: number; rekeyed: number; rowlessMax: number; composerChanged: number; focusLost: number; anchorLost: number; anchorShiftMaxPx: number };
export function summarize(directory: string, p0Directory?: string): string;
