import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Shared drafts: per account and session, the text the owner has typed but not sent, so it follows them to every
 * device. Text only; images and files stay on the device that holds them. An empty text is a draft that was cleared
 * (sent or erased), kept so a device that was away learns it too. The Relay gives each stored draft a revision that
 * only grows, so devices tell a newer draft from one they already have.
 */
/** The most UTF-8 bytes a draft's text may take; a longer draft stays on its device. */
export const SESSION_DRAFT_BYTES = 8192;
/** The most drafts an account keeps, cleared ones included; cleared ones go first, then the oldest. */
export const SESSION_DRAFT_LIMIT = 64;

const object = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const nativeId = Type.String({ minLength: 1, maxLength: 4096 });
const text = Type.String({ maxLength: SESSION_DRAFT_BYTES });
const encoder = new (globalThis as unknown as { TextEncoder: new () => { encode(value: string): Uint8Array } }).TextEncoder();

export const SessionDraftRequest = Type.Object({ hostId: identity, providerId: identity, nativeSessionId: nativeId, text }, object);
export type SessionDraftRequest = Static<typeof SessionDraftRequest>;
export const SessionDraft = Type.Object({ hostId: identity, providerId: identity, nativeSessionId: nativeId, text, revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, object);
export type SessionDraft = Static<typeof SessionDraft>;
export const SessionDrafts = Type.Object({ drafts: Type.Array(SessionDraft, { maxItems: SESSION_DRAFT_LIMIT }) }, object);
export type SessionDrafts = Static<typeof SessionDrafts>;

export const sessionDraftBytes = (value: string) => encoder.encode(value).length;
export const isSessionDraftRequest = (value: unknown): value is SessionDraftRequest => Value.Check(SessionDraftRequest, value) && sessionDraftBytes(value.text) <= SESSION_DRAFT_BYTES;
export const isSessionDraft = (value: unknown): value is SessionDraft => Value.Check(SessionDraft, value) && sessionDraftBytes(value.text) <= SESSION_DRAFT_BYTES;
export const isSessionDrafts = (value: unknown): value is SessionDrafts => Value.Check(SessionDrafts, value) && value.drafts.every(draft => sessionDraftBytes(draft.text) <= SESSION_DRAFT_BYTES);
