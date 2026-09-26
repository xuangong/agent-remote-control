export interface SessionBinding {
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly agentId: string;
  readonly parentNativeSessionId?: string;
}

export class SessionBindingError extends Error {
  readonly status: number;
  constructor(readonly code: 'session_binding_conflict' | 'host_closed', message: string) {
    super(message);
    this.name = 'SessionBindingError';
    this.status = code === 'host_closed' ? 503 : 409;
  }
}

/** Integrations own native attachment and disposal; this service owns identity and publication. */
export interface SessionBindingExtension {
  canonical?: boolean;
  attach(binding: SessionBinding): Promise<void>;
  discard?(binding: SessionBinding): Promise<void>;
}

export class SessionBindings {
  private readonly native = new Map<string, SessionBinding>();
  private readonly agents = new Map<string, SessionBinding>();
  private readonly pending = new Map<string, { binding: SessionBinding; promise: Promise<SessionBinding> }>();
  private readonly reservedAgents = new Map<string, string>();
  private closed = false;

  getByNative(providerId: string, nativeSessionId: string): SessionBinding | undefined { return this.native.get(key({ providerId, nativeSessionId })); }
  getByAgent(agentId: string): SessionBinding | undefined { return this.agents.get(agentId); }
  values(): IterableIterator<SessionBinding> { return this.agents.values(); }
  isPending(providerId: string, nativeSessionId: string): boolean { return this.pending.has(key({ providerId, nativeSessionId })); }
  isReserved(agentId: string): boolean { return this.reservedAgents.has(agentId) || this.agents.has(agentId); }

  async bind(request: SessionBinding, extension: SessionBindingExtension): Promise<SessionBinding> {
    if (this.closed) throw new SessionBindingError('host_closed', 'Session binding service is closed.');
    const identity = key(request);
    const existing = this.native.get(identity);
    const pending = this.pending.get(identity);
    const prior = existing ?? pending?.binding;
    if (prior && (prior.parentNativeSessionId !== request.parentNativeSessionId
      || extension.canonical === false && prior.agentId !== request.agentId)) {
      throw new SessionBindingError('session_binding_conflict', 'Native session identity or ownership conflicts with this binding.');
    }
    const binding: SessionBinding = prior ?? Object.freeze({ ...request });
    const publicTarget = this.agents.get(binding.agentId);
    const reservation = this.reservedAgents.get(binding.agentId);
    if (publicTarget && key(publicTarget) !== identity || reservation && reservation !== identity) {
      throw new SessionBindingError('session_binding_conflict', 'The public session identity is already reserved for a different native session.');
    }
    if (pending) return pending.promise;
    this.reservedAgents.set(binding.agentId, identity);
    const promise = Promise.resolve().then(async () => {
      if (this.closed) throw new SessionBindingError('host_closed', 'Session binding service is closed.');
      await extension.attach(binding);
      if (this.closed) {
        await extension.discard?.(binding);
        throw new SessionBindingError('host_closed', 'Session binding service closed during attachment.');
      }
      this.native.set(identity, binding);
      this.agents.set(binding.agentId, binding);
      return binding;
    }).finally(() => {
      this.pending.delete(identity);
      this.reservedAgents.delete(binding.agentId);
    });
    this.pending.set(identity, { binding, promise });
    return promise;
  }

  release(binding: SessionBinding): void {
    if (this.native.get(key(binding)) !== binding) return;
    this.native.delete(key(binding));
    this.agents.delete(binding.agentId);
  }

  close(): void { this.closed = true; }
}

function key(binding: Pick<SessionBinding, 'providerId' | 'nativeSessionId'>): string {
  return JSON.stringify([binding.providerId, binding.nativeSessionId]);
}
