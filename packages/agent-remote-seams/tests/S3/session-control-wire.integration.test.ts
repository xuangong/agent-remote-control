// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AgentReplica, RemoteSessionClient, leaseView, type RemoteAgentTransport, type RemoteConnection, type RemoteServerMessage, type RemoteTransportListener } from '@orchardworks/agent-client';
import { installPageLifecycle } from '@orchardworks/agent-client/testing';
import { decodeServerMessage, type AgentSnapshot, type ClientMessage, type HistoryPage } from '@orchardworks/agent-remote-protocol';
import { framesOf, readTranscript, transcriptNames } from '@orchardworks/agent-remote-fixtures';

/**
 * S3, the `session_control` frames of the Relay's session wire read by the browser end: the recorded transcripts are the one fixture the
 * Relay's stream (`stream-control.ts`, replayed in `session-wire.integration.test.ts`) writes and the client reads. Every recorded
 * `session_control` and refusal frame passes the decoder the client's transport uses and gives the lease the client shows; the recorded
 * acquisition is then replayed into a real `RemoteSessionClient` over an in-memory transport.
 */
const names = transcriptNames('S3');
const toBrowser = (name: string) => framesOf(readTranscript('S3', name), 'relay->browser');
const decode = (message: unknown) => {
  const decoded = decodeServerMessage(JSON.stringify(message));
  if (decoded.status !== 'ok') throw new Error(`The client's decoder refused a recorded frame: ${JSON.stringify(decoded)}`);
  return decoded.value as RemoteServerMessage;
};

describe('S3 session control frames: the decoder and the lease of the client', () => {
  it('has session control frames to read', () => {
    expect(names.flatMap(toBrowser).filter(frame => (frame.message as { type: string }).type === 'session_control').length).toBeGreaterThan(5);
  });

  it.each(names)('%s: every session_control and protocol_error frame decodes, and the lease follows from access and owner', name => {
    for (const { message } of toBrowser(name)) {
      const type = (message as { type: string }).type;
      if (type !== 'session_control' && type !== 'protocol_error') continue;
      const decoded = decode(message);
      if (decoded.type !== 'session_control') continue;
      const { access, available, revision, nativeOwner, token } = decoded.payload;
      const lease = leaseView({ access, available, revision, nativeOwner });
      expect(lease.readOnly).toBe(access === 'read_only');
      expect(lease.native).toBe(nativeOwner !== undefined);
      if (access === 'control') expect(token).toEqual(expect.any(String));
      else expect(token).toBeUndefined();
      if (nativeOwner) expect(available).toBe(false);
    }
  });
});

class RecordedTransport implements RemoteAgentTransport {
  listener: RemoteTransportListener | undefined;
  readonly sent: ClientMessage[] = [];
  constructor(private readonly snapshot: AgentSnapshot) {}
  connect(_agentId: string, listener: RemoteTransportListener): RemoteConnection {
    this.listener = listener;
    return { send: message => { this.sent.push(message); }, close: () => undefined };
  }
  fetchSnapshot() { return Promise.resolve(this.snapshot); }
  fetchTimeline(agentId: string): Promise<HistoryPage> {
    return Promise.resolve({ protocolVersion: this.snapshot.protocolVersion, type: 'timeline_page', payload: {
      requestId: 'page', agentId, direction: 'tail', epoch: 'e', reset: false, staleCursor: false, gap: false, error: null,
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [] } });
  }
  onDiagnostic() { return () => undefined; }
  onProtocolMessage() { return () => undefined; }
  emit(message: RemoteServerMessage) { this.listener?.onMessage(message); }
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('S3 session control frames: a real client replays the recorded acquisition', () => {
  it('acquires control from the recorded lease, answers with the recorded request, and shows the lease the Relay named', async () => {
    installPageLifecycle();
    const frames = toBrowser('native-owner-refuses-send');
    const messages = frames.map(frame => frame.message as { type: string; payload?: any });
    const negotiated = messages.find(message => message.type === 'negotiated')!, snapshot = messages.find(message => message.type === 'agent_snapshot')!;
    const [initial, granted, owned] = messages.filter(message => message.type === 'session_control');
    if (!initial || !granted || !owned) throw new Error('The transcript lacks its three lease frames');
    const transport = new RecordedTransport(decode(snapshot) as AgentSnapshot);
    const replica = new AgentReplica();
    const client = new RemoteSessionClient(initial.payload.agentId, transport, replica, { requireSessionControl: true });
    try {
      client.start();
      transport.listener!.onOpen();
      transport.emit(decode(negotiated));
      transport.emit(decode(snapshot));
      const subscription = transport.sent.find(message => message.type === 'timeline_subscription');
      if (subscription?.type !== 'timeline_subscription') throw new Error('The client did not subscribe');
      transport.emit({ protocolVersion: subscription.protocolVersion, type: 'timeline_subscribed', payload: { requestId: subscription.payload.requestId, agentIds: [initial.payload.agentId] } });
      await settle();
      transport.emit(decode(initial));
      const request = transport.sent.find(message => message.type === 'session_control_request');
      if (request?.type !== 'session_control_request') throw new Error('The client did not ask for control');
      const recorded = readTranscript('S3', 'native-owner-refuses-send').lines.find(line => 'direction' in line && line.message && (line.message as { type: string }).type === 'session_control_request') as { message: { payload: Record<string, unknown> } };
      expect(request.payload).toMatchObject({ agentId: recorded.message.payload.agentId, revision: initial.payload.revision, action: recorded.message.payload.action });
      transport.emit(decode({ ...granted, payload: { ...granted.payload, requestId: request.payload.requestId } }));
      await settle();
      expect(leaseView(replica.getState().sessionControl).state).toBe('control');
      expect(JSON.stringify(replica.getState())).not.toContain(granted.payload.token);
      transport.emit(decode(owned));
      await settle();
      expect(leaseView(replica.getState().sessionControl)).toMatchObject({ state: 'native_cli', readOnly: true, native: true });
    } finally { client.stop(); }
  });
});
