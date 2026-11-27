/** Public navigation identity, never an authorization credential. */
export interface ControllerLocation {
  windowId?: string;
  hostId?: string;
  previewId?: string;
  previewPath?: string;
  previewChallenge?: string;
  agentId?: string;
  providerId?: string;
  nativeSessionId?: string;
  parentNativeSessionId?: string;
  sessionIntent?: 'history';
  keepOriginal?: boolean;
  /** What the page should do with the session once the person confirms; a link without it only opens the session. */
  sessionUse?: SessionUse;
}
/** Making the session a bot, optionally named. */
export type SessionUse = { kind: 'bot'; name?: string };
const MAX_USE_TEXT = 256;
const fields = { window: 'windowId', host: 'hostId', agent: 'agentId', provider: 'providerId', session: 'nativeSessionId', parent: 'parentNativeSessionId', preview: 'previewId', path: 'previewPath', challenge: 'previewChallenge' } as const;

export function readControllerLocation(query: URLSearchParams): ControllerLocation {
  const result: ControllerLocation = {};
  for (const [key, field] of Object.entries(fields)) {
    const values = query.getAll(key);
    if (!values.length) continue;
    const value = values[0]!;
    if (values.length !== 1 || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) ||
      (key === 'window' && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) ||
      ((key === 'host' || key === 'provider') && !/^[A-Za-z0-9_-]{1,256}$/.test(value)) ||
      (key === 'challenge' && !/^[A-Za-z0-9_-]{43}$/.test(value)) ||
      (key === 'preview' && !/^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error('Invalid session link.');
    result[field] = value;
  }
  if (query.has('intent')) {
    const values = query.getAll('intent');
    if (values.length !== 1 || values[0] !== 'history') throw new Error('Invalid session intent.');
    result.sessionIntent = 'history';
  }
  const use = readSessionUse(query);
  if (use) result.sessionUse = use;
  if (query.has('keepOriginal')) {
    const values = query.getAll('keepOriginal');
    if (values.length !== 1 || values[0]!.length > 4096 || /[\u0000-\u001f\u007f]/.test(values[0]!)) throw new Error('Invalid original-session option.');
    result.keepOriginal = true;
  }
  if ((result.nativeSessionId || result.providerId || result.parentNativeSessionId) &&
    !(result.nativeSessionId && result.providerId && result.hostId)) throw new Error('Incomplete session link.');
  if (result.sessionUse && (result.sessionIntent || result.keepOriginal)) throw new Error('A session use cannot combine with a history intent.');
  if ((result.sessionIntent || result.keepOriginal || result.sessionUse) && !(result.hostId && result.providerId && result.nativeSessionId)) throw new Error('Incomplete session link.');
  if (result.previewId || result.previewPath || result.previewChallenge) {
    if (!result.hostId || !result.previewId || !result.previewPath || result.agentId || result.providerId || result.nativeSessionId || result.parentNativeSessionId) throw new Error('Invalid preview link.');
    const prefix = '/p/' + result.previewId + '/';
    const path = result.previewPath;
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || !new URL(prefix.slice(0, -1) + path, 'https://preview.invalid').pathname.startsWith(prefix)) throw new Error('Invalid preview path.');
  }
  return result;
}

function readSessionUse(query: URLSearchParams): SessionUse | undefined {
  const text = (key: string) => {
    const values = query.getAll(key);
    if (!values.length) return undefined;
    const value = values[0]!;
    if (values.length !== 1 || !value || value.length > MAX_USE_TEXT || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid session use.');
    return value;
  };
  const kinds = query.getAll('as');
  if (!kinds.length) {
    if (query.has('name')) throw new Error('Invalid session use.');
    return undefined;
  }
  if (kinds.length !== 1 || kinds[0] !== 'bot') throw new Error('Invalid session use.');
  const name = text('name');
  return name === undefined ? { kind: 'bot' } : { kind: 'bot', name };
}

export function controllerPath(location: ControllerLocation): string {
  const query = new URLSearchParams();
  for (const [key, field] of Object.entries(fields)) if (location[field]) query.set(key, location[field]!);
  if (location.sessionIntent !== undefined) query.set('intent', location.sessionIntent);
  if (location.keepOriginal) query.set('keepOriginal', '1');
  if (location.sessionUse) {
    query.set('as', location.sessionUse.kind);
    if (location.sessionUse.name !== undefined) query.set('name', location.sessionUse.name);
  }
  readControllerLocation(query);
  return query.size ? `/?${query}` : '/';
}

/** Login returns only to the controller root and recognized identity fields. */
export function validControllerPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32768 || !(value === '/' || value.startsWith('/?'))) return false;
  try { return controllerPath(readControllerLocation(new URLSearchParams(value.slice(2)))) === value; }
  catch { return false; }
}
