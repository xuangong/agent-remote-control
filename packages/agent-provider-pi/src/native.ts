/** The provider id every observation of this adapter names. */
export const provider = 'pi';

export type Json = Record<string, unknown>;
export const record = (value: unknown): Json => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
export const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
export const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
