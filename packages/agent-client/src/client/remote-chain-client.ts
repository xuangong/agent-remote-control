import { isBoardWriteResult, isBotChain, type BoardItemEdit, type BoardPlanEdit, type BoardWriteResult, type ChainAction, type ChainView } from '@orchardworks/agent-remote-protocol';
import { withMessageKey } from '../presentation/locale-choice.js';

/** The account's chains and the person's decisions on them (bots design 7). Decisions are never retried automatically. */
export class RemoteChainClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(new URL(`v1/remote/chains${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), {
      signal: AbortSignal.timeout(45000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const value = await response.json() as { error?: string };
    if (!response.ok) throw value.error === undefined ? withMessageKey(new Error('The audit is unavailable.'), 'client.error.auditUnavailable') : new Error(value.error);
    return value;
  }
  async list(): Promise<ChainView> {
    const value = await this.request('') as Partial<ChainView>;
    if (!Array.isArray(value.chains) || !value.chains.every(isBotChain) || !value.names || typeof value.names !== 'object' || !Array.isArray(value.paused))
      throw withMessageKey(new Error('The audit is unavailable.'), 'client.error.auditUnavailable');
    return { chains: value.chains, names: value.names, paused: value.paused, thresholds: value.thresholds ?? {} };
  }
  async act(action: ChainAction): Promise<void> { await this.request('/action', action); }
  /** The person edits a standing bot's items and plan note; the answer says what a stale edit overwrote. */
  async writeBoard(botId: string, edit: { items?: readonly BoardItemEdit[]; plan?: BoardPlanEdit }): Promise<BoardWriteResult> {
    const value = await this.request('/action', { action: 'update_board', botId, ...edit });
    if (!isBoardWriteResult(value)) throw withMessageKey(new Error('The audit is unavailable.'), 'client.error.auditUnavailable');
    return value;
  }
}
