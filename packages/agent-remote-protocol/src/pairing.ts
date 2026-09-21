import { Type, type Static } from '@sinclair/typebox';
export const PairingPurpose = Type.Union([Type.Literal('host-only'), Type.Literal('gateway-setup')]);
export type PairingPurpose = Static<typeof PairingPurpose>;
export function isPairingPurpose(value: unknown): value is PairingPurpose { return value === 'host-only' || value === 'gateway-setup'; }
