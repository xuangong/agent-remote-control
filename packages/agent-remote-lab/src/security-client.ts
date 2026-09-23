import { controllerPath, readControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { signInReturnKey } from '@orchardworks/agent-remote-hosted/access-page';

export interface BrowserSession { id: string; label: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean; sessionCount?: number; activity?: number[] }
export interface BrowserSessions { sessions: BrowserSession[]; authenticatedAt: number | null; recentAuthentication: boolean }
export interface SecurityEvent { id: string; at: number; action: string; outcome: string; hostId?: string }
export class SecurityError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) { super(message); }
}
export function needsReauthentication(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'reauthentication_required';
}
function sessionTarget(): string {
  try { return controllerPath(readControllerLocation(new URLSearchParams(window.location.search))); }
  catch { return '/'; }
}
export function reauthenticationUrl(): string {
  const query = new URLSearchParams(sessionTarget().slice(2));
  return '/auth/login?reauthenticate=1' + (query.size ? '&' + query.toString() : '');
}
export function rememberReauthenticationTarget(): void {
  try { sessionStorage.setItem(signInReturnKey, sessionTarget()); } catch { /* Navigation also carries the canonical target. */ }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
async function request(path: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  let value: unknown;
  try { value = await response.json(); } catch { throw new SecurityError('The security service returned an invalid response.', undefined, response.status); }
  if (!response.ok) throw new SecurityError(response.status === 401 ? 'Your browser session has expired.' : 'The security action could not be completed. Try again.', record(value) && typeof value.code === 'string' ? value.code : undefined, response.status);
  return value;
}
export async function browserSessions(signal?: AbortSignal): Promise<BrowserSessions> {
  const value = await request('/auth/sessions', signal);
  if (!record(value) || !Array.isArray(value.sessions) || typeof value.recentAuthentication !== 'boolean' ||
    !(value.authenticatedAt === null || timestamp(value.authenticatedAt)) || !value.sessions.every(item => record(item) &&
      typeof item.id === 'string' && typeof item.label === 'string' && timestamp(item.createdAt) && timestamp(item.lastSeenAt) && timestamp(item.expiresAt) && typeof item.current === 'boolean' && (item.sessionCount === undefined || (Number.isInteger(item.sessionCount) && (item.sessionCount as number) > 0)) && (item.activity === undefined || (Array.isArray(item.activity) && item.activity.length <= 8 && item.activity.every(timestamp))))) throw new SecurityError('The browser session list is invalid.');
  return value as unknown as BrowserSessions;
}
export async function securityAudit(signal?: AbortSignal): Promise<SecurityEvent[]> {
  const value = await request('/auth/audit', signal);
  if (!record(value) || !Array.isArray(value.events) || !value.events.every(item => record(item) && typeof item.id === 'string' && timestamp(item.at) && typeof item.action === 'string' && typeof item.outcome === 'string' && (item.hostId === undefined || typeof item.hostId === 'string'))) throw new SecurityError('The security activity list is invalid.');
  return value.events as SecurityEvent[];
}
export async function revokeBrowserSession(id: string, signal?: AbortSignal): Promise<{ current: boolean }> {
  const value = await request('/auth/sessions/revoke', signal, { id });
  if (!record(value) || value.ok !== true || typeof value.current !== 'boolean') throw new SecurityError('The sign-out result could not be confirmed. Refresh the browser list before trying again.');
  return { current: value.current };
}
export async function revokeAllBrowserSessions(signal?: AbortSignal): Promise<void> {
  const value = await request('/auth/sessions/revoke-all', signal, {});
  if (!record(value) || value.ok !== true) throw new SecurityError('The sign-out result could not be confirmed.');
}
