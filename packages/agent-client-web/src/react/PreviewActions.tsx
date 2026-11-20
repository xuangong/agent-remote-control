import { useState } from 'react';
import { CopyTunnelUrl } from './CopyTunnelUrl.js';
import { useTranslate } from './locale.js';
import { errorWordsOr } from './localized-error.js';
import type { MessageKey, Translate } from '@orchardworks/agent-client';
import { type PinnedPreviewName, type PreviewPathMode, type PreviewRegistration, type PreviewRegistrationRequest } from '@orchardworks/agent-client';


export interface PreviewController {
  readonly registrations: readonly PreviewRegistration[];
  readonly pinnedNames?: readonly PinnedPreviewName[];
  readonly canManage: boolean;
  readonly routing?: 'subdomain' | 'path';
  register(agentId: string, request: PreviewRegistrationRequest): Promise<PreviewRegistration>;
  unregister(id: string, hostId?: string): Promise<void>;
  open(id: string, originalLoopbackUrl: string, sessionId?: string, remote?: { hostId: string; registration: PreviewRegistration }): Promise<string>;
  pinName?(id: string, pinned: boolean): Promise<void>;
  unpinName?(nameId: string): Promise<void>;
  getTunnelUrl?(id: string, originalLoopbackUrl: string): Promise<string>;
}

export function discoverLoopbackTargets(text: string): string[] {
  const pattern = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):\d{1,5}(?:\/[^\s<>'"`，。；：！？、（）【】「」『』“”‘’]*)?/gi;
  const found = new Map<string, string>();
  for (const match of text.matchAll(pattern)) {
    const value = trimUrlProse(match[0]);
    const normalized = /^https?:\/\//i.test(value) ? value : `http://${value}`;
    try {
      const url = new URL(normalized);
      if (Number(url.port) > 65535) continue;
      const key = `${url.protocol}//${url.hostname.toLowerCase()}:${url.port}${url.pathname}${url.search}${url.hash}`;
      if (!found.has(key)) found.set(key, url.toString().replace(/\/$/, value.endsWith('/') ? '/' : ''));
    } catch { /* Ignore malformed transcript text. */ }
  }
  return [...found.values()];
}

function trimUrlProse(candidate: string): string {
  let depth = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] === '(') depth += 1;
    else if (candidate[index] === ')') {
      // A Markdown link's closing delimiter is not part of its destination.
      if (depth === 0) return candidate.slice(0, index).replace(/[,.;!?]+$/, '');
      depth -= 1;
    }
  }
  return candidate.replace(/[,.;!?]+$/, '');
}

export function PreviewActions({ agentId, itemId, text, controller }: {
  readonly agentId: string; readonly itemId: string; readonly text: string; readonly controller: PreviewController;
}) {
  const t = useTranslate();
  const targets = discoverLoopbackTargets(text);
  if (targets.length === 0) return null;
  return <aside className="agent-preview-actions" aria-label={t('timeline.preview.local')}>
    {targets.map(target => <PreviewTarget key={target} agentId={agentId} itemId={itemId} target={target} controller={controller} />)}
  </aside>;
}

function PreviewTarget({ agentId, itemId, target, controller }: {
  readonly agentId: string; readonly itemId: string; readonly target: string; readonly controller: PreviewController;
}) {
  const t = useTranslate();
  const [pathMode, setPathMode] = useState<PreviewPathMode>('strip');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const origin = loopbackOrigin(target);
  const candidates = controller.registrations
    .filter(item => loopbackOrigin(item.target) === origin)
    .sort((left, right) => lifecyclePriority(right) - lifecyclePriority(left) || right.revision - left.revision);
  const preferredLifecycle = candidates[0] && lifecyclePriority(candidates[0]);
  const registration = candidates.find(item => lifecyclePriority(item) === preferredLifecycle && item.pathMode === pathMode) ?? candidates[0];
  const effectiveMode = registration?.pathMode ?? pathMode;

  async function register(): Promise<void> {
    setPending(true); setFailure(undefined);
    try {
      const registered = await controller.register(agentId, { target, itemId, pathMode });
      if (pathMode === 'strip') await controller.open(registered.id, target, agentId);
    }
    catch (error) { setFailure(message(error, t, 'timeline.preview.registerFailed')); }
    finally { setPending(false); }
  }
  async function open(): Promise<void> {
    if (!registration) return;
    setPending(true); setFailure(undefined);
    try { await controller.open(registration.id, target, agentId); }
    catch (error) { setFailure(message(error, t, 'timeline.preview.accessFailed')); }
    finally { setPending(false); }
  }
  async function getTunnelUrl(): Promise<string> {
    setPending(true); setFailure(undefined);
    try {
      const selected = registration?.status === 'active' ? registration
        : await controller.register(agentId, { target, itemId, pathMode });
      return await controller.getTunnelUrl!(selected.id, target);
    } finally { setPending(false); }
  }
  async function unregister(): Promise<void> {
    if (!registration) return;
    setPending(true); setFailure(undefined);
    try { await controller.unregister(registration.id); }
    catch (error) { setFailure(message(error, t, 'timeline.preview.unregisterFailed')); }
    finally { setPending(false); }
  }

  const state = registration?.pendingUnregister ? t('timeline.preview.unregisterPending')
    : registration?.status === 'expired' ? t('timeline.preview.expired')
    : registration?.status === 'unregistered' ? t('timeline.preview.unregistered')
    : registration?.availability === 'controller_offline' ? t('timeline.preview.controllerOffline')
    : registration?.status === 'active' ? t('timeline.preview.registered') : undefined;
  return <div className="agent-preview-target">
    <code>{target}</code>
    {!registration || registration.status !== 'active' ? <>
      {state ? <span className="agent-preview-state">{state}</span> : null}
      {controller.routing !== 'subdomain' && <label>{t('timeline.preview.pathMode')} <select value={pathMode} disabled={pending} onChange={event => setPathMode(event.target.value as PreviewPathMode)}>
        <option value="strip">{t('timeline.preview.rootMounted')}</option><option value="preserve">{t('timeline.preview.configuredBase')}</option>
      </select></label>}
      <button type="button" disabled={pending || !controller.canManage} onClick={() => void register()}>{pending ? t('timeline.preview.registering') : registration?.status === 'expired' ? t('timeline.preview.registerAgain') : t('timeline.preview.open')}</button>
    </> : <>
      <span className="agent-preview-state">{state}</span>
      <button className="agent-preview-open" type="button" disabled={pending || registration.pendingUnregister || registration.availability !== 'online'} onClick={event => { event.currentTarget.focus({ preventScroll: true }); void open(); }}>{pending ? t('timeline.opening') : t('timeline.preview.open')}</button>
    </>}
    {controller.getTunnelUrl ? <CopyTunnelUrl disabled={pending || !controller.canManage || registration?.pendingUnregister || (registration?.status === 'active' && registration.availability !== 'online')}
      getUrl={getTunnelUrl} /> : null}
    {registration?.status === 'active' && controller.canManage ? <button type="button" disabled={pending || registration.pendingUnregister} onClick={() => void unregister()}>{t('timeline.preview.unregister')}</button> : null}
    {controller.routing !== 'subdomain' && <small>{effectiveMode === 'preserve'
      ? t('timeline.preview.baseNote', { id: registration?.id ?? '<registration-id>' })
      : t('timeline.preview.rootNote')}</small>}
    {failure ? <p role="alert">{failure}</p> : null}
  </div>;
}

function message(error: unknown, t: Translate, fallback: MessageKey): string { return errorWordsOr(error, t, fallback); }

function loopbackOrigin(source: string): string {
  const url = new URL(source);
  const host = url.hostname.toLowerCase();
  const canonicalHost = host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host) ? 'loopback' : host;
  return `${url.protocol}//${canonicalHost}:${url.port}`;
}

function lifecyclePriority(registration: PreviewRegistration): number {
  if (registration.status === 'active') return 2;
  return registration.status === 'expired' ? 1 : 0;
}
