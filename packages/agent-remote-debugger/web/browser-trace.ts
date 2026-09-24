import type { RemoteProtocolObservation } from '@orchardworks/agent-remote-web';

/** Best-effort metadata, separate from the public control and recovery protocol. */
export function createBrowserTrace() {
  const clientId = crypto.randomUUID();
  const queue: Record<string, unknown>[] = [];
  let dropped = 0;
  let flushing = false;
  const record = (value: Record<string, unknown>) => {
    if (queue.length === 64) { queue.shift(); dropped++; }
    queue.push({ clientId, timestamp: new Date().toISOString(), ...value });
  };
  const timer = setInterval(() => { void flush(); }, 250);
  async function flush() {
    if (flushing || !queue.length) return;
    flushing = true;
    const batch = queue.splice(0, 32);
    const lost = dropped; dropped = 0;
    if (lost) batch.unshift({ clientId, event: 'trace_dropped', dropped: lost });
    try {
      const response = await fetch('/__ardb/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error('Trace delivery failed');
    } catch { dropped += batch.length + lost; }
    finally { flushing = false; }
  }
  return {
    record,
    protocol(observation: RemoteProtocolObservation) {
      const payload = 'payload' in observation.message ? observation.message.payload as { requestId?: string } : undefined;
      record({ event: 'protocol', direction: observation.direction, channel: observation.channel, messageType: observation.message.type, requestId: payload?.requestId });
    },
    close() { clearInterval(timer); void flush(); },
  };
}
