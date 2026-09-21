import type { ResourceBinding, ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';

export interface MarkdownResourceContext {
  readonly scopeKey: string;
  readonly bindings: readonly ResourceBinding[];
  readonly resources: AgentReplicaState['resources'];
  readonly resolveResource: (locator: string, sourceLocator?: string) => Promise<ResourceBinding>;
  readonly requestResource: (binding: ResourceBinding) => Promise<void | ResourceResponseState>;
}

interface ResourceResolution { promise: Promise<ResourceBinding>; binding?: ResourceBinding }
const resolutions = new Map<string, ResourceResolution>();
const requests = new Map<string, Promise<void | ResourceResponseState>>();
const MAX_CACHE_ENTRIES = 256;

export function cachedLocalResourceBinding(context: MarkdownResourceContext, locator: string, sourceLocator?: string): ResourceBinding | undefined {
  return (sourceLocator === undefined ? context.bindings.find(binding => binding.locator === locator && binding.status === 'available') : undefined)
    ?? resolutions.get(JSON.stringify([context.scopeKey, sourceLocator ?? null, locator]))?.binding;
}

export async function loadLocalResource(
  context: MarkdownResourceContext,
  locator: string,
  sourceLocator?: string,
  onResolved?: (binding: ResourceBinding) => void,
  fresh = false,
): Promise<{ binding: ResourceBinding; detail?: AgentReplicaState['resources'][string] }> {
  const existing = !fresh && sourceLocator === undefined ? context.bindings.find(binding => binding.locator === locator && binding.status === 'available') : undefined;
  const resolveKey = JSON.stringify([context.scopeKey, sourceLocator ?? null, locator]);
  if (fresh) resolutions.delete(resolveKey);
  let resolution = existing ? { promise: Promise.resolve(existing), binding: existing } : resolutions.get(resolveKey);
  if (!resolution) {
    const created: ResourceResolution = { promise: context.resolveResource(locator, sourceLocator).then(binding => {
      if (binding.status !== 'available') resolutions.delete(resolveKey);
      else created.binding = binding;
      return binding;
    }).catch(error => { resolutions.delete(resolveKey); throw error; }) };
    resolution = created;
    cache(resolutions, resolveKey, resolution);
  }
  const binding = await resolution.promise;
  onResolved?.(binding);
  const detail = context.resources[binding.resourceId];
  if (detail?.status === 'unavailable' || (detail?.status === 'available' && 'contentBase64' in detail)) return { binding, detail };
  const requestKey = JSON.stringify([context.scopeKey, binding.resourceId]);
  let request = requests.get(requestKey);
  if (!request) {
    request = context.requestResource(binding);
    cache(requests, requestKey, request);
    void request.then(
      () => { if (requests.get(requestKey) === request) requests.delete(requestKey); },
      () => { if (requests.get(requestKey) === request) requests.delete(requestKey); },
    );
  }
  return { binding, detail: (await request) ?? context.resources[binding.resourceId] };
}

function cache<T>(entries: Map<string, T>, key: string, value: T): void {
  entries.set(key, value);
  while (entries.size > MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value as string);
}
