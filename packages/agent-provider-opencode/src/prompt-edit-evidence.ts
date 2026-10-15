import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentOperationRejectedError, type AgentNativeReadiness, type AgentNativeValidityToken, type AgentPromptEditEvidence } from '@orchardworks/agent-provider-sdk';
import { openCodeReadError, type OpenCodeTransport } from './transport.js';

function reject(reason: string): never { throw new AgentOperationRejectedError('prompt_edit_evidence_unavailable', reason); }

/** Read native facts independently of timeline projection and historical-setting evidence. */
export async function readPromptEditReadiness(transport: OpenCodeTransport, nativeId: string, expectedCwd: string, trackChildren?: (ids: Set<string>) => void): Promise<AgentNativeReadiness> {
  const parameters = { sessionID: nativeId }, location = { location: { directory: expectedCwd } };
  const [native, active, permissions, forms, inbox, permissionPage, formPage] = await Promise.all([
    transport.request(() => transport.client.session.get(parameters)),
    transport.request(() => transport.client.session.active()),
    transport.request(() => transport.client.permission.list(parameters)),
    transport.request(() => transport.client.session.form.list(parameters)),
    transport.request(() => transport.client.session.inbox.list(parameters)),
    transport.request(() => transport.client.permission.request.list(location)),
    transport.request(() => transport.client.form.list(location)),
  ]);
  if (!native || native.id !== nativeId || native.parentID || native.revert || !native.location?.directory
    || await realpath(resolve(native.location.directory)) !== expectedCwd || !active || typeof active !== 'object' || Array.isArray(active)
    || Object.values(active).some(value => !value || value.type !== 'running')
    || !Array.isArray(permissions) || !Array.isArray(forms) || !Array.isArray(inbox)
    || !Array.isArray(permissionPage?.data) || !Array.isArray(formPage?.data)) reject('OpenCode did not provide complete prompt-edit readiness facts.');
  const waiting = new Set([...permissionPage.data, ...formPage.data].map(value => {
    if (!value || typeof value.sessionID !== 'string') reject('OpenCode returned ambiguous child interaction state.');
    return value.sessionID;
  }));
  const pendingParents = [nativeId], childIds = new Set<string>();
  let activeChildren = 0, pages = 0;
  const deadline = Date.now() + 10_000;
  for (const parentID of pendingParents) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      if (++pages > 50 || Date.now() > deadline) reject('OpenCode child readiness exceeds its bounded read budget.');
      const page = await transport.request(() => transport.client.session.list({ parentID, limit: 200, ...(cursor ? { cursor } : {}) }));
      if (!page || !Array.isArray(page.data) || !page.cursor || page.data.length > 200) reject('OpenCode child readiness is incomplete.');
      for (const child of page.data) {
        if (!child || !child.id || child.parentID !== parentID || child.id === nativeId || childIds.has(child.id)) reject('OpenCode child readiness is ambiguous.');
        childIds.add(child.id); pendingParents.push(child.id);
        if (active[child.id] || waiting.has(child.id)) activeChildren++;
      }
      const next = page.cursor.next;
      if (next != null && (typeof next !== 'string' || !next)) reject('OpenCode child cursor is invalid.');
      cursor = page.data.length === 200 ? next ?? undefined : undefined;
      if (cursor && cursors.has(cursor)) reject('OpenCode child pagination did not advance.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  trackChildren?.(childIds);
  return { cwd: expectedCwd, idle: !active[nativeId], pendingInputs: inbox.length, pendingInteractions: permissions.length + forms.length, activeChildren };
}
interface Ports {
  transport: OpenCodeTransport;
  nativeId: string;
  cwd: string;
  readable(): boolean;
  local(): Pick<AgentNativeReadiness, 'idle' | 'pendingInputs' | 'pendingInteractions'>;
}
/** Tokens belong to one attachment and one fully settled native readback generation. */
export class OpenCodePromptEditEvidence implements AgentPromptEditEvidence {
  readonly version = 1 as const;
  private generation = 0;
  private baseline = -1;
  private inspections = 0;
  private children = new Set<string>();
  private readonly tokens = new WeakMap<object, number>();
  constructor(private readonly ports: Ports) {}
  observes(sessionId: unknown, parentId?: unknown): boolean { return this.inspections > 0 && typeof sessionId === 'string'
    || sessionId === this.ports.nativeId || parentId === this.ports.nativeId
    || typeof sessionId === 'string' && this.children.has(sessionId) || typeof parentId === 'string' && this.children.has(parentId); }
  invalidate(): void { this.generation++; this.baseline = -1; }
  private localReady(): boolean {
    const local = this.ports.local();
    return this.ports.readable() && local.idle && !local.pendingInputs && !local.pendingInteractions;
  }
  async inspectReadiness(): Promise<AgentNativeReadiness> {
    this.baseline = -1;
    if (!this.ports.readable()) reject('OpenCode prompt-edit attachment is closed or recovering.');
    const generation = this.generation;
    let native: AgentNativeReadiness;
    // An event may belong to a descendant whose identity has not been enumerated yet.
    this.inspections++;
    try { native = await readPromptEditReadiness(this.ports.transport, this.ports.nativeId, this.ports.cwd, ids => { this.children = ids; }); }
    catch (error) { throw openCodeReadError(error); }
    finally { this.inspections--; }
    if (!this.ports.readable() || generation !== this.generation) reject('OpenCode prompt-edit readiness changed during native readback.');
    const local = this.ports.local();
    const result = { ...native, idle: native.idle && local.idle, pendingInputs: native.pendingInputs + local.pendingInputs,
      pendingInteractions: native.pendingInteractions + local.pendingInteractions };
    if (result.idle && !result.pendingInputs && !result.pendingInteractions && !result.activeChildren) this.baseline = generation;
    return result;
  }
  captureValidity(): AgentNativeValidityToken {
    if (this.baseline !== this.generation || !this.localReady()) reject('OpenCode prompt-edit readiness has no current settled baseline.');
    const token = Object.freeze({}) as AgentNativeValidityToken;
    this.tokens.set(token, this.generation); return token;
  }
  isCurrent(token: AgentNativeValidityToken): boolean {
    return !!token && typeof token === 'object' && this.tokens.get(token) === this.generation && this.baseline === this.generation && this.localReady();
  }
}
