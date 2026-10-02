/** Product navigation metadata. This is not native ancestry or a Session View event. */
export interface SourceRelation {
  id: string;
  kind: 'side' | 'ask';
  sourceNativeSessionId: string;
  createdAt: string;
  /** Missing fields in legacy state mean linked at revision zero. */
  linked?: boolean;
  revision?: number;
}
export interface RelatedSession {
  hostId: string;
  providerId: string;
  nativeSessionId: string;
  agentId: string;
  title: string;
}
export interface SessionRelation extends Omit<SourceRelation, 'sourceNativeSessionId'> {
  source: RelatedSession;
  target: RelatedSession;
}
export interface SessionRelationUpdate {
  hostId: string;
  providerId: string;
  nativeSessionId: string;
  sourceNativeSessionId: string;
  id: string;
  linked: boolean;
  expectedRevision: number;
}
export function validSourceRelation(value: unknown): value is SourceRelation {
  if (!value || typeof value !== 'object') return false;
  const item = value as SourceRelation;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 512
    && (item.kind === 'side' || item.kind === 'ask')
    && (item.linked === undefined || typeof item.linked === 'boolean')
    && (item.revision === undefined || Number.isSafeInteger(item.revision) && item.revision >= 0)
    && typeof item.sourceNativeSessionId === 'string' && item.sourceNativeSessionId.length > 0 && item.sourceNativeSessionId.length <= 4096
    && typeof item.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.createdAt) && Number.isFinite(Date.parse(item.createdAt));
}
export function validSessionRelationUpdate(value: unknown): value is SessionRelationUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ['hostId', 'providerId', 'nativeSessionId', 'sourceNativeSessionId', 'id'].every(key =>
    typeof item[key] === 'string' && item[key].length > 0 && item[key].length <= (key === 'id' ? 512 : 4096))
    && typeof item.linked === 'boolean' && typeof item.expectedRevision === 'number'
    && Number.isSafeInteger(item.expectedRevision) && item.expectedRevision >= 0 && item.expectedRevision < Number.MAX_SAFE_INTEGER;
}
