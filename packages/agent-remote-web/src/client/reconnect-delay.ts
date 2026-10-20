/**
 * Spreads a reconnect delay over its upper half so clients that lost the same
 * Relay connection do not all retry at the same instant. Never exceeds the input.
 */
export function equalJitter(delayMs: number, random: () => number = Math.random): number {
  return delayMs / 2 + Math.min(Math.max(random(), 0), 1) * delayMs / 2;
}
