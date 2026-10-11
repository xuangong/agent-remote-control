import type { NativeMessage } from './v2-native.js';
import type { OpenCodeTransport } from './transport.js';

/** A cursor encodes ordering in v2; sending order with cursor is invalid. */
export async function nativeHistoryPage(transport: OpenCodeTransport, sessionID: string, cursor?: string, limit = 200) {
  const page = await transport.request(() => transport.client.message.list({ sessionID, limit, ...(cursor ? { cursor } : { order: 'desc' as const }) }));
  const next = page.data.length === limit ? page.cursor.next ?? undefined : undefined;
  if (next === cursor && next) throw new Error('OpenCode history pagination did not advance.');
  return { messages: [...page.data].reverse(), nextCursor: next, startsAtBeginning: !next };
}

/** Bounded complete reads establish first-prompt identity across page boundaries. */
export async function nativeHistory(transport: OpenCodeTransport, sessionID: string): Promise<NativeMessage[]> {
  const pages: NativeMessage[][] = [], ids = new Set<string>(), seen = new Set<string>();
  const deadline = Date.now() + 10000;
  let cursor: string | undefined;
  for (let index = 0; index < 50 && Date.now() < deadline; index++) {
    const page = await nativeHistoryPage(transport, sessionID, cursor);
    for (const message of page.messages) {
      if (ids.has(message.id)) throw new Error('OpenCode history changed during pagination.');
      ids.add(message.id);
    }
    pages.push(page.messages);
    // Native sequence order is authoritative; clocks and client-selected IDs are not.
    if (!page.nextCursor) return pages.reverse().flat();
    if (seen.has(page.nextCursor)) throw new Error('OpenCode history pagination did not advance.');
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error('OpenCode source history exceeds the bounded read budget.');
}
