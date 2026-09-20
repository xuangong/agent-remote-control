import { useState } from 'react';
import { CopyTunnelUrl } from './CopyTunnelUrl.js';

import type { PreviewPathMode, PreviewRegistration, PreviewRegistrationRequest } from '../client/preview-client.js';

export interface PreviewController {
  readonly registrations: readonly PreviewRegistration[];
  readonly canManage: boolean;
  register(agentId: string, request: PreviewRegistrationRequest): Promise<PreviewRegistration>;
  unregister(id: string): Promise<void>;
  open(id: string, originalLoopbackUrl: string, sessionId?: string): Promise<string>;
  getTunnelUrl?(id: string, originalLoopbackUrl: string): Promise<string>;
}

export function discoverLoopbackTargets(text: string): string[] {
  const pattern = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):\d{1,5}(?:\/[^\s<>'"`]*)?/gi;
  const found = new Map<string, string>();
  for (const match of text.matchAll(pattern)) {
    const value = match[0].replace(/[),.;!?]+$/, '');
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

export function PreviewActions({ agentId, itemId, text, controller }: {
  readonly agentId: string; readonly itemId: string; readonly text: string; readonly controller: PreviewController;
}) {
  const targets = discoverLoopbackTargets(text);
  if (targets.length === 0) return null;
  return <aside className="agent-preview-actions" aria-label="Local previews">
    {targets.map(target => <PreviewTarget key={target} agentId={agentId} itemId={itemId} target={target} controller={controller} />)}
  </aside>;
}

function PreviewTarget({ agentId, itemId, target, controller }: {
  readonly agentId: string; readonly itemId: string; readonly target: string; readonly controller: PreviewController;
}) {
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
    catch (error) { setFailure(message(error, 'Preview registration failed. Check that the Controller is online and the target is reachable.')); }
    finally { setPending(false); }
  }
  async function open(): Promise<void> {
    if (!registration) return;
    setPending(true); setFailure(undefined);
    try { await controller.open(registration.id, target, agentId); }
    catch (error) { setFailure(message(error, 'Preview access could not be prepared. Retry after checking Host access.')); }
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
    catch (error) { setFailure(message(error, 'Preview could not be unregistered. Retry from the Host preview list.')); }
    finally { setPending(false); }
  }

  const state = registration?.pendingUnregister ? 'Unregister pending'
    : registration?.status === 'expired' ? 'Expired'
    : registration?.status === 'unregistered' ? 'Unregistered'
    : registration?.availability === 'controller_offline' ? 'Controller offline'
    : registration?.status === 'active' ? 'Registered' : undefined;
  return <div className="agent-preview-target">
    <code>{target}</code>
    {!registration || registration.status !== 'active' ? <>
      {state ? <span className="agent-preview-state">{state}</span> : null}
      <label>Path mode <select value={pathMode} disabled={pending} onChange={event => setPathMode(event.target.value as PreviewPathMode)}>
        <option value="strip">Root-mounted app</option><option value="preserve">Configured preview base</option>
      </select></label>
      <button type="button" disabled={pending || !controller.canManage} onClick={() => void register()}>{pending ? 'Registering…' : registration?.status === 'expired' ? 'Register again' : 'Open preview'}</button>
    </> : <>
      <span className="agent-preview-state">{state}</span>
      <button className="agent-preview-open" type="button" disabled={pending || registration.pendingUnregister || registration.availability !== 'online'} onClick={event => { event.currentTarget.focus({ preventScroll: true }); void open(); }}>{pending ? 'Opening…' : 'Open preview'}</button>
    </>}
    {controller.getTunnelUrl ? <CopyTunnelUrl disabled={pending || !controller.canManage || registration?.pendingUnregister || (registration?.status === 'active' && registration.availability !== 'online')}
      getUrl={getTunnelUrl} /> : null}
    {registration?.status === 'active' && controller.canManage ? <button type="button" disabled={pending || registration.pendingUnregister} onClick={() => void unregister()}>Unregister</button> : null}
    <small>{effectiveMode === 'preserve'
      ? `This app must be configured with /p/${registration?.id ?? '<registration-id>'}/ as its base. Register first to get the ID.`
      : 'Root paths are adapted for supported apps; arbitrary application URLs may still require configuration.'}</small>
    {failure ? <p role="alert">{failure}</p> : null}
  </div>;
}

function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }

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
