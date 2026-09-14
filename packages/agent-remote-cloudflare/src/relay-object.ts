import { createHostedRelay, validateGatewayOrigin, type RelayScheduler } from '@borgee/agent-remote-hosted';
import { SqliteRelayStore } from './storage.js';
import { WorkerRelaySocket } from './socket.js';

export interface RelayEnvironment {
  AGENT_REMOTE_RELAY_URL: string;
  AGENT_REMOTE_ISSUER: string;
  AGENT_REMOTE_SIGNING_SECRET: string;
  RELAY: DurableObjectNamespace;
  ASSETS: Fetcher;
}

/** One private object owns all authenticated namespaces and their shared-Host relationships. */
export class RelayObject {
  private core: ReturnType<typeof createHostedRelay> | undefined;
  private readonly ready: Promise<void>;
  private recoveryRequired = false;
  private replacingCore = false;
  constructor(private readonly context: DurableObjectState, private readonly env: RelayEnvironment) {
    this.ready = context.blockConcurrencyWhile(async () => {
      try { this.initialize(); } catch { /* Invalid persisted configuration remains unavailable without exposing it. */ }
    });
  }
  private initialize() {
    const auth = { origin: validateGatewayOrigin(this.env.AGENT_REMOTE_RELAY_URL), issuer: validateGatewayOrigin(this.env.AGENT_REMOTE_ISSUER), secret: this.env.AGENT_REMOTE_SIGNING_SECRET };
    if (typeof auth.secret !== 'string' || new TextEncoder().encode(auth.secret).byteLength < 32) throw new Error('Relay configuration is invalid.');
    const storage = new SqliteRelayStore(this.context.storage, auth);
    const scheduler: RelayScheduler = {
      schedule: async deadline => {
        const current = await this.context.storage.getAlarm();
        // Preserve an earlier persisted wake-up, including a constructor woken by an alarm.
        if (current === null || deadline < current) await this.context.storage.setAlarm(deadline);
      },
      cancel: async () => {
        if (this.replacingCore) return;
        // The DO has no graceful shutdown. Core cancellation means failure: retain a recovery wake-up.
        this.recoveryRequired = true;
        await this.context.storage.setAlarm(Date.now() + 60_000);
      },
    };
    this.core = createHostedRelay({ ...auth, storage, scheduler });
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (!this.core || this.recoveryRequired) return unavailable();
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const prepared = await this.core.prepareUpgrade(request);
      if (prepared instanceof Response) return prepared;
      if (!prepared) return new Response(null, { status: 404 });
      const pair = new WebSocketPair();
      const client = pair[0]; const server = pair[1];
      const socket = new WorkerRelaySocket(server, this.context);
      server.accept();
      try { prepared.accept(socket); }
      catch { socket.close(1011, 'Relay connection failed'); }
      return new Response(null, { status: 101, webSocket: client });
    }
    return await this.core.fetch(request) ?? new Response(null, { status: 404 });
  }
  async alarm(): Promise<void> {
    await this.ready;
    try {
      if (this.recoveryRequired) await this.discardCore();
      if (!this.core) { this.recoveryRequired = false; this.initialize(); }
      await this.core!.refresh();
    } catch {
      // A failed core remains closed to traffic. A later alarm can restore the last atomic commit.
      this.recoveryRequired = true;
      await this.discardCore();
      await this.context.storage.setAlarm(Date.now() + 60_000);
      throw new Error('Relay refresh failed; background retry scheduled.');
    }
  }
  private async discardCore() {
    const failed = this.core; this.core = undefined; this.replacingCore = true;
    try { await failed?.close().catch(() => undefined); }
    finally { this.replacingCore = false; }
  }
}
function unavailable() { return Response.json({ error: 'Relay is unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
