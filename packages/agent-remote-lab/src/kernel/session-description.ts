import type { NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { translator, type SessionAttribution, type SessionDescription, type SessionDescriptionIdentity, type Translate } from '@orchardworks/agent-client';
import { currentForkSource, sideLinkVisible, sideNavigationSource, sideNavigationTarget, type SessionFork } from './session-forks.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

type DescribedSession = SessionDescriptionIdentity & { title?: string };

export interface DescribeSessionInput {
  session: DescribedSession;
  sessions?: readonly SessionEntry[];
  forks?: readonly SessionFork[];
  asks?: readonly SessionFork[];
  hostNames?: ReadonlyMap<string, string>;
  /** The words of the reader's language; English when absent. */
  t?: Translate;
}

interface SourceEvidence {
  session?: DescribedSession;
  nativeSessionId: string;
  providerId: string;
}

/** Project existing owners' records; this description never owns a relationship graph. */
export function describeSession({ session, sessions = [], forks = [], asks = [], hostNames, t = translator('en') }: DescribeSessionInput): SessionDescription {
  const known = new Map(sessions.map(entry => [sessionKey(entry), entry]));
  const currentKey = sessionKey(session);
  const current = { ...session, parentNativeSessionId: session.parentNativeSessionId ?? known.get(currentKey)?.parentNativeSessionId };
  const attributions = new Map<string, SessionAttribution>();
  const relatedIds = new Set<string>();
  const add = (row: SessionAttribution) => { if (!attributions.has(row.id)) attributions.set(row.id, row); };
  const matches = (target: DescribedSession | undefined) => !!target && sessionKey(target) === currentKey;
  const label = (target: DescribedSession): string => {
    const title = known.get(sessionKey(target))?.title?.trim();
    return title && title !== target.nativeSessionId ? title : target.title?.trim() || target.nativeSessionId;
  };
  const scopeDetail = (target: Pick<SessionDescriptionIdentity, 'hostId' | 'providerId'>) => [
    target.providerId !== session.providerId ? target.providerId : undefined,
    (target.hostId ?? 'local') !== (session.hostId ?? 'local') ? hostNames?.get(target.hostId ?? 'local') || target.hostId || 'local' : undefined,
  ].filter(Boolean).join(' · ');
  const addSession = (id: string, kind: string, name: string, target: DescribedSession, detail?: string, history = false) => {
    const entry = { ...known.get(sessionKey(target)), ...target };
    const explanation = [detail, scopeDetail(target)].filter(Boolean).join(' · ');
    add({ id, kind, label: name, value: label(target),
      ...(explanation ? { detail: explanation } : {}),
      target: { kind: 'session', ...identity(entry), ...(history ? { sessionIntent: 'history' as const } : {}) } });
  };
  const addRole = (role: string) => add({ id: `role:${role}`, kind: 'role', label: t('client.describe.role'), value: role });
  const addOrigin = (id: string, origin: SourceEvidence, effective: DescribedSession, kind: 'source' | 'role-origin' = 'source') => {
    if (origin.session && sessionKey(origin.session) === sessionKey(effective)) return;
    const name = kind === 'role-origin' ? t('client.describe.roleOrigin') : t('client.describe.originalSource');
    if (origin.session) addSession(id, kind, name, origin.session, kind === 'role-origin' ? t('client.describe.mainRoleSession') : t('client.describe.originalContextSource'), true);
    else add({ id, kind, label: name, value: origin.nativeSessionId,
      detail: t('client.describe.hostIdentityUnavailable', { provider: origin.providerId }) });
  };

  for (const [records, kind] of [[asks, 'ask'], [forks, 'side']] as const) {
    for (const record of records) {
      const target = sideNavigationTarget(record);
      if (!target) continue;
      const prefix = `${kind}:${sessionKey(target)}:${record.relationId ?? record.id}`;
      const source = currentForkSource(record);
      const original = forkOrigin(record);
      if (matches(record.target) && !matches(target)) {
        addRole(kind === 'ask' ? 'Ask' : record.mode === 'reference' ? 'Side' : 'Fork');
        if (original.session) addSession(`${prefix}:created-source`, 'source', t('client.describe.source'), original.session, t('client.describe.originalContextSource'), true);
        else add({ id: `${prefix}:created-source`, kind: 'source', label: t('client.describe.source'), value: original.nativeSessionId,
          detail: t('client.describe.hostIdentityUnavailable', { provider: original.providerId }) });
      }
      if (matches(target)) {
        addRole(kind === 'ask' ? 'Ask' : record.mode === 'reference' ? 'Side' : 'Fork');
        if (kind === 'ask') {
          addSession(`${prefix}:main`, 'main', t('client.describe.main'), source, undefined, record.sourceBinding?.kind === 'fixed');
          addOrigin(`${prefix}:origin`, original, source);
        } else if (record.mode === 'reference') {
          addSession(`${prefix}:source`, 'source', t('client.describe.source'), source, t('client.describe.sourceReference'), record.sourceBinding?.kind === 'fixed');
          addOrigin(`${prefix}:origin`, original, source);
          const navigation = sideNavigationSource(record);
          if (sideLinkVisible(record) && sessionKey(navigation) !== sessionKey(source)) {
            addSession(`${prefix}:navigation`, 'navigation-source', t('client.describe.navigationSource'), navigation, t('client.describe.navigationLink'));
          }
        } else {
          addSession(`${prefix}:source`, 'source', t('client.describe.source'), record.source, undefined, true);
          add({ id: `${prefix}:context`, kind: 'context', label: t('client.describe.context'), value: t('client.describe.fixedSnapshot'),
            detail: t('client.describe.snapshotDetail', { count: record.itemCount, time: record.capturedAt }) });
        }
      }
      const navigation = kind === 'ask' ? source : sideNavigationSource(record);
      const linked = kind === 'ask' ? record.linked !== false : sideLinkVisible(record);
      if (linked && matches(navigation) && !matches(target)) {
        const name = kind === 'ask' ? 'Ask' : record.mode === 'reference' ? 'Side' : 'Fork';
        const id = `${kind}:${sessionKey(target)}:${name}:related`;
        addSession(id, kind, name, target);
        relatedIds.add(id);
      }
    }
  }

  if (current.parentNativeSessionId && current.parentNativeSessionId !== current.nativeSessionId) {
    const parent = { hostId: current.hostId, providerId: current.providerId, nativeSessionId: current.parentNativeSessionId };
    addSession(`parent:${sessionKey(parent)}`, 'parent', t('client.describe.parent'), parent);
  }
  for (const child of known.values()) {
    if (child.parentNativeSessionId && matches({ ...child, nativeSessionId: child.parentNativeSessionId }) && !matches(child)) {
      addSession(`child:${sessionKey(child)}`, 'child', t('client.describe.child'), child);
    }
  }
  const related = [...attributions.values()].filter(row => relatedIds.has(row.id));
  for (const row of related) {
    if (row.target?.kind !== 'session') continue;
    const nativeId = row.target.nativeSessionId;
    const peers = related.filter(candidate => candidate.kind === row.kind && candidate.id !== row.id);
    if (!['Ask', 'Side', 'Fork', 'Source session', nativeId].includes(row.value) && !peers.some(candidate => candidate.value === row.value)) continue;
    let length = Math.min(8, nativeId.length);
    while (length < nativeId.length && peers.some(candidate => candidate.target?.kind === 'session'
      && candidate.target.nativeSessionId !== nativeId && candidate.target.nativeSessionId.slice(-length) === nativeId.slice(-length))) length++;
    attributions.set(row.id, { ...row, value: `${row.value === nativeId ? row.label : row.value} · ${nativeId.slice(-length)}` });
  }
  return { identity: identity(current), attributions: [...attributions.values()] };
}

function identity(session: SessionDescriptionIdentity): SessionDescriptionIdentity {
  return { ...(session.hostId === undefined ? {} : { hostId: session.hostId }), providerId: session.providerId,
    nativeSessionId: session.nativeSessionId, ...(session.parentNativeSessionId ? { parentNativeSessionId: session.parentNativeSessionId } : {}) };
}

function forkOrigin(record: SessionFork): SourceEvidence {
  if (!record.remote) return { session: record.source, nativeSessionId: record.source.nativeSessionId, providerId: record.source.providerId };
  const binding = record.sourceBinding;
  const origin = record.nativeSourceRef ?? (binding?.kind === 'fixed' ? binding.source : undefined);
  if (!origin) return { session: record.source, nativeSessionId: record.source.nativeSessionId, providerId: record.source.providerId };
  const locator = record.hostLocator;
  const consistent = binding?.kind !== 'fixed' || sameNativeRef(origin, binding.source);
  if (!locator || locator.controllerId !== origin.controllerId || !consistent) return origin;
  const source = { hostId: locator.hostId, providerId: origin.providerId, nativeSessionId: origin.nativeSessionId };
  return { ...origin, session: { ...source, ...(sessionKey(source) === sessionKey(record.source) ? { title: record.source.title } : {}) } };
}

function sameNativeRef(left: NativeSessionRef, right: NativeSessionRef): boolean {
  return left.controllerId === right.controllerId && left.providerId === right.providerId && left.nativeSessionId === right.nativeSessionId;
}
