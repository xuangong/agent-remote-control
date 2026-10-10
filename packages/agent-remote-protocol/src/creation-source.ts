/** Request provenance for a same-Host normalized snapshot; it grants no source tools. */
export interface CreationSource { readonly providerId: string; readonly nativeSessionId: string }
export function isCreationSource(value: unknown): value is CreationSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return Object.keys(source).length === 2 && Object.keys(source).every(key => key === 'providerId' || key === 'nativeSessionId')
    && [source.providerId, source.nativeSessionId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id));
}
