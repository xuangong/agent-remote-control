import type { LeaseAnswerTimes } from './lease-clock.js';

const relayNow = Date.UTC(2026, 10, 22, 12, 0, 0);
const http = (ms: number) => new Date(ms).toUTCString();
const minute = 60_000;

export interface LeaseClockVector { name: string; input: LeaseAnswerTimes; deadline: number }

/** One table for the rule: the Relay answers at `relayNow` with its own `Date` header. */
export const leaseClockVectors: LeaseClockVector[] = [
  { name: 'no Date header keeps the expiry', input: { expiresAt: relayNow + 15 * minute, relayDate: undefined, receivedAt: relayNow + 10 * minute }, deadline: relayNow + 15 * minute },
  { name: 'null Date header keeps the expiry', input: { expiresAt: relayNow + 15 * minute, relayDate: null, receivedAt: relayNow + 10 * minute }, deadline: relayNow + 15 * minute },
  { name: 'malformed Date header keeps the expiry', input: { expiresAt: relayNow + 15 * minute, relayDate: 'not a date', receivedAt: relayNow + 10 * minute }, deadline: relayNow + 15 * minute },
  { name: 'equal clocks keep the expiry', input: { expiresAt: relayNow + 15 * minute, relayDate: http(relayNow), receivedAt: relayNow }, deadline: relayNow + 15 * minute },
  { name: 'header truncated to the second keeps the expiry', input: { expiresAt: relayNow + 15 * minute, relayDate: http(relayNow), receivedAt: relayNow + 900 }, deadline: relayNow + 15 * minute },
  { name: 'device 4 s ahead is inside the tolerance', input: { expiresAt: relayNow + 15 * minute, relayDate: http(relayNow), receivedAt: relayNow + 4000 }, deadline: relayNow + 15 * minute },
  { name: 'device 4 s behind is inside the tolerance', input: { expiresAt: relayNow + 15 * minute, relayDate: http(relayNow), receivedAt: relayNow - 4000 }, deadline: relayNow + 15 * minute },
  { name: 'device 10 minutes ahead moves the deadline later', input: { expiresAt: relayNow + 15 * minute, relayDate: http(relayNow), receivedAt: relayNow + 10 * minute }, deadline: relayNow + 25 * minute },
  { name: 'device 10 minutes behind moves the deadline earlier', input: { expiresAt: relayNow + 15 * minute, relayDate: http(relayNow), receivedAt: relayNow - 10 * minute }, deadline: relayNow + 5 * minute },
  { name: 'a lease already ended on the Relay clock stays expired', input: { expiresAt: relayNow - minute, relayDate: http(relayNow), receivedAt: relayNow + 10 * minute }, deadline: relayNow - minute },
  { name: 'a lease ended on the Relay clock stays expired with equal clocks', input: { expiresAt: relayNow - 1000, relayDate: http(relayNow), receivedAt: relayNow }, deadline: relayNow - 1000 },
  { name: 'a lease ended on the Relay clock never ends after receipt on a slow device', input: { expiresAt: relayNow - 1000, relayDate: http(relayNow), receivedAt: relayNow - 10 * minute }, deadline: relayNow - 10 * minute },
  { name: 'a 2 minute lease with the device 10 minutes ahead is still 2 minutes long', input: { expiresAt: relayNow + 2 * minute, relayDate: http(relayNow), receivedAt: relayNow + 10 * minute }, deadline: relayNow + 12 * minute },
  { name: 'a 2 minute lease with the device 10 minutes behind is still 2 minutes long', input: { expiresAt: relayNow + 2 * minute, relayDate: http(relayNow), receivedAt: relayNow - 10 * minute }, deadline: relayNow - 8 * minute },
];
