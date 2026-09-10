import { type Static, Type } from '@sinclair/typebox';

export const BORGEE_AGENT_REMOTE_PROTOCOL_VERSION = '1.4.0';
export const PROTOCOL_VERSION = BORGEE_AGENT_REMOTE_PROTOCOL_VERSION;

export const ProtocolVersionSchema = Type.Literal(BORGEE_AGENT_REMOTE_PROTOCOL_VERSION);
export type ProtocolVersionSchema = Static<typeof ProtocolVersionSchema>;
