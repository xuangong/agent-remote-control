import { sideNavigationSource, sideLinkVisible, type SessionFork } from './session-forks.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

export interface DirectorySessionLink { target: SessionEntry; kinds: Array<'Ask' | 'Side'> }

/** Navigation links remain separate from the provider's native parent relationships. */
export function directorySessionLinks(sides: readonly SessionFork[], asks: readonly SessionFork[], known: readonly SessionEntry[]): Map<string, Map<string, DirectorySessionLink>> {
  const metadata = new Map(known.map(entry => [sessionKey(entry), entry]));
  const links = new Map<string, Map<string, DirectorySessionLink>>();
  for (const [records, kind] of [[asks, 'Ask'], [sides, 'Side']] as const) {
    for (const record of records) {
      if (kind === 'Side' && record.mode !== 'reference') continue;
      const target = record.target;
      const source = kind==='Side' ? sideNavigationSource(record) : record.source;
      if (!target || (kind === 'Side' ? !sideLinkVisible(record) : record.linked === false) || (kind==='Ask' && target.providerId !== source.providerId)
        || (target.hostId ?? 'local') !== (source.hostId ?? 'local')) continue;
      const sourceKey = sessionKey(source);
      const targetKey = sessionKey(target);
      if (sourceKey === targetKey) continue;
      const targets = links.get(sourceKey) ?? new Map<string, DirectorySessionLink>();
      links.set(sourceKey, targets);
      const existing = targets.get(targetKey);
      if (existing) { if (!existing.kinds.includes(kind)) existing.kinds.push(kind); }
      else {
        const observed = metadata.get(targetKey);
        const title = observed?.title && observed.title !== target.nativeSessionId ? observed.title : target.title;
        targets.set(targetKey, { target: { ...target, ...observed, title }, kinds: [kind] });
      }
    }
  }
  return links;
}
