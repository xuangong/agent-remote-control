import { isTeam, type Team, type TeamAction, type TeamCreate, type TeamDelete } from '@orchardworks/agent-remote-protocol';
import { withMessageKey } from '../presentation/locale-choice.js';

/** Mutations retain caller-owned identities and are never automatically retried. */
export class RemoteTeamClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(new URL(`v1/remote/teams${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), {
      signal: AbortSignal.timeout(45000), headers: { 'x-arc-team-recipients': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const value = await response.json(); if (!response.ok) throw value.error === undefined ? withMessageKey(new Error('Team service is unavailable.'), 'client.error.teamUnavailable') : new Error(value.error); return value;
  }
  async list(): Promise<Team[]> {
    const value = await this.request('') as { teams?: unknown };
    if (!Array.isArray(value.teams) || !value.teams.every(isTeam)) throw withMessageKey(new Error('Invalid Team catalog.'), 'client.error.invalidTeamCatalog'); return value.teams;
  }
  async create(input: TeamCreate): Promise<Team> { const value = await this.request('/create', input); if (!isTeam(value)) throw withMessageKey(new Error('Invalid Team creation response.'), 'client.error.invalidTeamCreation'); return value; }
  async action(input: TeamAction): Promise<Team> { const value = await this.request('/action', input); if (!isTeam(value) || value.id !== input.teamId) throw withMessageKey(new Error('Invalid Team action response.'), 'client.error.invalidTeamAction'); return value; }
  /** Removes an archived support group for good. */
  async delete(teamId: string): Promise<void> {
    const value = await this.request('/delete', { teamId } satisfies TeamDelete) as { teamId?: unknown; deleted?: unknown };
    if (value.teamId !== teamId || value.deleted !== true) throw withMessageKey(new Error('Invalid Team deletion response.'), 'client.error.invalidTeamDeletion');
  }
}
