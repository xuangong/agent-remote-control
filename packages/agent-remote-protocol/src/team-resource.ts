import { Type, type Static } from '@sinclair/typebox';

/** A file shared within a Team, stored by the Relay. */
export const TeamResource = Type.Object({ resourceId: Type.String({ minLength: 1, maxLength: 256 }), name: Type.String({ minLength: 1, maxLength: 255 }), mediaType: Type.String({ minLength: 1, maxLength: 255 }), byteLength: Type.Integer({ minimum: 0, maximum: 50 * 1024 * 1024 }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false });
export type TeamResource = Static<typeof TeamResource>;
