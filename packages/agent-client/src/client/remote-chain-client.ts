import { isBotChain, type ChainAction, type ChainView } from '@orchardworks/agent-remote-protocol';
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
    return { chains: value.chains, names: value.names, paused: value.paused, kinds: value.kinds ?? {}, thresholds: value.thresholds ?? {} };
  }
  async act(action: ChainAction): Promise<void> { await this.request('/action', action); }
}
