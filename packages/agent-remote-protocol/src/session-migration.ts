import { Type, type Static } from '@sinclair/typebox';
const Identity = Type.Object({ hostId: Type.String({ minLength: 1, maxLength: 512 }), providerId: Type.String({ minLength: 1, maxLength: 512 }), nativeSessionId: Type.String({ minLength: 1, maxLength: 4096 }), agentId: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false });
export const SessionMigration = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), from: Identity, to: Identity, createdAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export type SessionMigration = Static<typeof SessionMigration>;
