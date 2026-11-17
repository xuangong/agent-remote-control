export interface SeededRandom {
  next(): number;
  int(low: number, high: number): number;
  pick<T>(list: readonly T[]): T;
}
export function seededRandom(seed: number): SeededRandom;
