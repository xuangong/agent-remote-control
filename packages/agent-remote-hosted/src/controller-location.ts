/** Public navigation identity, never an authorization credential. */
export interface ControllerLocation {
  hostId?: string;
  previewId?: string;
  previewPath?: string;
  agentId?: string;
  providerId?: string;
  nativeSessionId?: string;
  parentNativeSessionId?: string;
}
const fields = { host: 'hostId', agent: 'agentId', provider: 'providerId', session: 'nativeSessionId', parent: 'parentNativeSessionId', preview: 'previewId', path: 'previewPath' } as const;

export function readControllerLocation(query: URLSearchParams): ControllerLocation {
  const result: ControllerLocation = {};
  for (const [key, field] of Object.entries(fields)) {
    const values = query.getAll(key);
    if (!values.length) continue;
    const value = values[0]!;
    if (values.length !== 1 || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) ||
      ((key === 'host' || key === 'provider') && !/^[A-Za-z0-9_-]{1,256}$/.test(value)) ||
      (key === 'preview' && !/^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error('Invalid session link.');
    result[field] = value;
  }
  if ((result.nativeSessionId || result.providerId || result.parentNativeSessionId) &&
    !(result.nativeSessionId && result.providerId && result.hostId)) throw new Error('Incomplete session link.');
  if (result.previewId || result.previewPath) {
    if (!result.hostId || !result.previewId || !result.previewPath || result.agentId || result.providerId || result.nativeSessionId || result.parentNativeSessionId) throw new Error('Invalid preview link.');
    const prefix = '/p/' + result.previewId + '/';
    const path = result.previewPath;
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || !new URL(prefix.slice(0, -1) + path, 'https://preview.invalid').pathname.startsWith(prefix)) throw new Error('Invalid preview path.');
  }
  return result;
}

export function controllerPath(location: ControllerLocation): string {
  const query = new URLSearchParams();
  for (const [key, field] of Object.entries(fields)) if (location[field]) query.set(key, location[field]!);
  readControllerLocation(query);
  return query.size ? `/?${query}` : '/';
}

/** Login returns only to the controller root and recognized identity fields. */
export function validControllerPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32768 || !(value === '/' || value.startsWith('/?'))) return false;
  try { return controllerPath(readControllerLocation(new URLSearchParams(value.slice(2)))) === value; }
  catch { return false; }
}
