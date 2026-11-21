export const budgetPath: string;
export function legacyCounts(root: string): Record<string, number>;
export function overBudget(counts: Record<string, number>, budget: Record<string, number>): string[];
export function lowered(counts: Record<string, number>, budget: Record<string, number>): Record<string, number>;
export function lowerBudgets(root: string): boolean;
