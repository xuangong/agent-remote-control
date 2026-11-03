import { createHostedRelay, hostedAuthFromEnv, hostedRecordEncodingCosts, PortableTeamResourceStore, type HostedAuthEnvironment, type HostedRecordKind, type RelayScheduler } from '@orchardworks/agent-remote-hosted';
import { createStateCommitLog } from './state-commit-log.js';
import { SqliteTeamResourceStorage } from './team-resource-storage.js';
import { createHmac } from 'node:crypto';
import { SqliteRelayStore } from './storage.js';
import { SqliteDiagnosticStore } from './diagnostic-storage.js';
import { WorkerRelaySocket } from './socket.js';
import { WorkerPreviewSocket } from './preview-socket.js';

export interface RelayEnvironment extends HostedAuthEnvironment {
  AGENT_REMOTE_PREVIEW_URL?: string;
  AGENT_REMOTE_PREVIEW_DOMAIN?: string;
  /** Milliseconds that access confirmed before an account authority outage stays usable; defaults to 15 minutes. */
  AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS?: string;
  AGENT_REMOTE_RELAY_URL: string;
  AGENT_REMOTE_SIGNING_SECRET: string;
  RELAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  CF_VERSION_METADATA?: { id: string };
}

const STATE_CACHE_VERIFY_EVERY = 500;
/** One private object owns all authenticated namespaces and their shared-Host relationships. */
export class RelayObject {
  private core: ReturnType<typeof createHostedRelay> | undefined;
  private readonly ready: Promise<void>;
  private recoveryRequired = false;
  private readonly runtimeInstanceId = crypto.randomUUID();
  private replacingCore = false;
  constructor(private readonly context: DurableObjectState, private readonly env: RelayEnvironment) {
    this.ready = context.blockConcurrencyWhile(async () => {
      try { this.initialize('runtime_start'); } catch { /* Invalid persisted configuration remains unavailable without exposing it. */ }
    });
  }
  private initialize(startReason: 'runtime_start' | 'core_recovery') {
    const auth = hostedAuthFromEnv(this.env);
    let log: ReturnType<typeof createStateCommitLog> | undefined;
    // A complete encoding checks each record cache every so many commits; a difference is logged and that encoding used.
    const verification = (cache: 'store' | 'capacity') => ({ verifyEvery: STATE_CACHE_VERIFY_EVERY, onMismatch: (kinds: HostedRecordKind[]) => log?.mismatch(cache, kinds) });
    const storage = new SqliteRelayStore(this.context.storage, auth, { cache: verification('store') });
    log = createStateCommitLog({ runtimeInstanceId: this.runtimeInstanceId, ...(this.env.CF_VERSION_METADATA?.id ? { workerVersionId: this.env.CF_VERSION_METADATA.id } : {}) }, storage.loaded);
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
    this.core = createHostedRelay({ ...auth, ...(this.env.AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS ? { authorityOutageGraceMs: Number(this.env.AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS) } : {}), previewOrigin: this.env.AGENT_REMOTE_PREVIEW_URL, previewDomain: this.env.AGENT_REMOTE_PREVIEW_DOMAIN, storage, successionEnrollment: true, diagnosticStorage: new SqliteDiagnosticStore(this.context.storage, auth),
      teamResources: namespace => new PortableTeamResourceStore({ storage: new SqliteTeamResourceStorage(this.context.storage, createHmac('sha256', auth.secret).update(JSON.stringify([auth.origin, auth.issuer, namespace])).digest('hex')) }),
      successionEncodingCosts: hostedRecordEncodingCosts(auth, verification('capacity')), onStateCommit: metrics => log!.commit(metrics),
      diagnosticContext: { runtimeInstanceId: this.runtimeInstanceId, workerVersionId: this.env.CF_VERSION_METADATA?.id, startReason }, scheduler, clientAddress: request => request.headers.get('cf-connecting-ip') ?? 'unknown' });
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (!this.core || this.recoveryRequired) return unavailable();
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const preview = await this.core.preparePreviewUpgrade(request);
      if (preview) {
        if (preview instanceof Response) return preview;
        const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
        server.accept();
        // Tunnel frames have end-to-end credit. Browser application sockets have no drain signal.
        const socket = new WorkerPreviewSocket(server, new URL(request.url).pathname === '/ws/preview-tunnel' ? Number.MAX_SAFE_INTEGER : undefined);
        try { preview.accept(socket); } catch { socket.close(1011, 'Preview connection failed'); }
        return new Response(null, { status: 101, webSocket: client, headers: preview.protocol ? { 'sec-websocket-protocol': preview.protocol } : {} });
      }
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
      if (!this.core) { this.recoveryRequired = false; this.initialize('core_recovery'); }
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
