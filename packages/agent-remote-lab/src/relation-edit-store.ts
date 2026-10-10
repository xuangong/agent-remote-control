import type { SessionFork } from './session-forks.js';

export interface RelationEdit {
  operationId: string;
  linked: boolean;
  expectedRevision: number;
  expectedRoleRevision?: number;
  sourceNativeSessionId: string;
}
/** Full reader and authenticated Host mapping; legacy URL/relation-only records are not reused. */
export function relationEditScope(record: Pick<SessionFork,'target' | 'relationId' | 'hostLocator'>): string {
  if (!record.target || !record.relationId || !record.hostLocator) throw new Error('The shared side identity is incomplete. Refresh before trying again.');
  return JSON.stringify([record.hostLocator.hostId,record.hostLocator.controllerId,record.target.providerId,record.target.nativeSessionId,record.relationId]);
}
export class RelationEditStore {
  private readonly edits = new Map<string, RelationEdit>();
  private readonly prefix: string;
  constructor(url: URL) { this.prefix = `agent-remote-relation-edit:v2:${url.toString()}:`; }
  get(scope: string): RelationEdit | undefined {
    try {
      const value = JSON.parse(localStorage.getItem(this.prefix + scope) ?? 'null') as RelationEdit | null;
      if (!value) { this.edits.delete(scope); return; }
      if (value && typeof value.operationId === 'string' && value.operationId.length > 0 && typeof value.linked === 'boolean'
        && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 && typeof value.sourceNativeSessionId === 'string'
        && (value.expectedRoleRevision === undefined || Number.isSafeInteger(value.expectedRoleRevision) && value.expectedRoleRevision > 0)) {
        this.edits.set(scope, value); return value;
      }
    } catch { /* An unavailable record is never converted into a retry identity. */ }
  }
  set(scope: string, edit: RelationEdit): void {
    try { localStorage.setItem(this.prefix + scope, JSON.stringify(edit)); }
    catch { throw new Error('The side edit identity could not be saved. Free browser storage before continuing.'); }
    this.edits.set(scope, edit);
  }
  clear(scope: string, operationId: string): void {
    const persisted = JSON.parse(localStorage.getItem(this.prefix + scope) ?? 'null') as RelationEdit | null;
    if (persisted?.operationId !== operationId) { this.edits.delete(scope); return; }
    localStorage.removeItem(this.prefix + scope);
    this.edits.delete(scope);
  }
}
