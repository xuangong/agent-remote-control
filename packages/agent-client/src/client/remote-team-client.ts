import { isTeam, type Team, type TeamAction, type TeamAskRequest, type TeamCreate } from '@orchardworks/agent-remote-protocol';
import { withMessageKey } from '../presentation/locale-choice.js';

/** Mutations retain caller-owned identities and are never automatically retried. */
export class RemoteTeamClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(new URL(`v1/remote/teams${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), {
      signal: AbortSignal.timeout(45000), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const value = await response.json(); if (!response.ok) throw value.error === undefined ? withMessageKey(new Error('Team service is unavailable.'), 'client.error.teamUnavailable') : new Error(value.error); return value;
  }
  async list(): Promise<Team[]> {
    const value = await this.request('') as { teams?: unknown };
    if (!Array.isArray(value.teams) || !value.teams.every(isTeam)) throw withMessageKey(new Error('Invalid Team catalog.'), 'client.error.invalidTeamCatalog'); return value.teams;
  }
  async create(input: TeamCreate): Promise<Team> { const value = await this.request('/create', input); if (!isTeam(value)) throw withMessageKey(new Error('Invalid Team creation response.'), 'client.error.invalidTeamCreation'); return value; }
  /** The person mentions a bot from a conversation; the bot answers in its answer session for it, which this returns. */
  async ask(input: TeamAskRequest): Promise<Team> { const value = await this.request('/ask', input); if (!isTeam(value) || !value.ask) throw withMessageKey(new Error('Invalid ask response.'), 'client.error.invalidTeamAsk'); return value; }
  async action(input: TeamAction): Promise<Team> { const value = await this.request('/action', input); if (!isTeam(value) || value.id !== input.teamId) throw withMessageKey(new Error('Invalid Team action response.'), 'client.error.invalidTeamAction'); return value; }
}
