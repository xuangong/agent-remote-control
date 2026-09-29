/** Product navigation metadata. This is not native ancestry or a Session View event. */
export interface SourceRelation {
  id: string;
  kind: 'side' | 'ask';
  sourceNativeSessionId: string;
  createdAt: string;
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
export function validSourceRelation(value: unknown): value is SourceRelation {
  if (!value || typeof value !== 'object') return false;
  const item = value as SourceRelation;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 512
    && (item.kind === 'side' || item.kind === 'ask')
    && typeof item.sourceNativeSessionId === 'string' && item.sourceNativeSessionId.length > 0 && item.sourceNativeSessionId.length <= 4096
    && typeof item.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.createdAt) && Number.isFinite(Date.parse(item.createdAt));
}
