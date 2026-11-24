import { describe, expect, it } from 'vitest';
import { RemoteChainClient } from './remote-chain-client.js';

const bot = 'b_' + '1'.repeat(32);
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe('the person\'s board edit through the audit route', () => {
  it('posts the edit as an update_board action for the bot and returns what a stale edit overwrote', async () => {
    let sent: { url: string; body: unknown } | undefined;
    const client = new RemoteChainClient('https://relay.test/', (async (url: URL, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ items: [{ key: 1, version: 3, overwrote: [{ field: 'status', was: 'waiting', by: bot }] }] }));
    }) as never);
    const result = await client.writeBoard(bot, { items: [{ key: 1, version: 1, status: 'working' }] });
    expect(sent).toEqual({ url: 'https://relay.test/v1/remote/chains/action', body: { action: 'update_board', botId: bot, items: [{ key: 1, version: 1, status: 'working' }] } });
    expect(result.items[0]!.overwrote).toEqual([{ field: 'status', was: 'waiting', by: bot }]);
  });

  it('reports the Relay\'s refusal and refuses an answer that is not a write result', async () => {
    await expect(new RemoteChainClient('https://relay.test/', reply({ error: 'No item 9 on the board.' }, 409) as never).writeBoard(bot, {})).rejects.toThrow('No item 9');
    await expect(new RemoteChainClient('https://relay.test/', reply({ items: 'x' }) as never).writeBoard(bot, {})).rejects.toThrow();
  });
});
