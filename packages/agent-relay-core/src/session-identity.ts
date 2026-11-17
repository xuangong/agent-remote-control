/** Translate only public protocol addresses; native IDs, content and opaque cursors stay intact. */
export function sessionIdentityMessage(json: string, from: string, to: string, direction: 'client' | 'server'): string {
  if (from === to) return json;
  // Endpoints own protocol negotiation and content validation. The Relay only routes addresses.
  const message = JSON.parse(json);
  if (!message || typeof message !== 'object' || Array.isArray(message)) return json;
  const payload = message.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json;
  const address = (value: unknown): string => {
    if (value !== from) throw new Error('Session message targets another binding.');
    return to;
  };
  if ('agentId' in payload) payload.agentId = address(payload.agentId);
  else if ('agentIds' in payload) {
    if (!Array.isArray(payload.agentIds)) throw new Error('Invalid session subscription targets.');
    payload.agentIds = payload.agentIds.map(address);
  }
  else if (direction === 'server' && (message.type === 'agent_snapshot' || message.type === 'agent_update')) payload.id = address(payload.id);
  else return json;
  return JSON.stringify(message);
}

/**
 * A Controller built before item keys decodes `negotiate` with a strict schema and answers an unknown field with a protocol
 * error. The Relay answers the `itemKeys` flag itself (only a journal-served stream echoes it), so no Controller sees it.
 */
export function withoutItemKeysFlag(json: string): string {
  if (!json.includes('"itemKeys"')) return json;
  try {
    const message = JSON.parse(json);
    if (message?.type !== 'negotiate' || !('itemKeys' in message)) return json;
    delete message.itemKeys;
    return JSON.stringify(message);
  } catch { return json; }
}
