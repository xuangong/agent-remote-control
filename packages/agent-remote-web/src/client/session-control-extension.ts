import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';

export interface SessionTakeControlOptions {
  onRestoring?(): void;
  checkOnly?: boolean;
}

/** A guarantee from an implementation extension that no interruption was performed. */
export class SessionHandoffRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionHandoffRejectedError';
  }
}

/** An authorized endpoint resumes this binding; the client owns synchronization and control acquisition. */
export interface SessionControlExtension {
  /** Reject with SessionHandoffRejectedError only when no interruption occurred. All other failures are uncertain. */
  resumeNative(owner: NativeSessionOwner, options: { checkOnly: boolean; signal: AbortSignal }): Promise<void>;
}

export interface SessionHandoffState {
  readonly generation: string;
  readonly phase: 'taking' | 'checking' | 'restoring' | 'unknown' | 'failed';
  readonly message?: string;
}

/** Consumer/authority lifetime, independent of connection leases. Never stored in browser persistence. */
export class SessionHandoffScope {
  private readonly targets = new Map<string, SessionHandoff>();

  forTarget(target: string): SessionHandoff {
    let handoff = this.targets.get(target);
    if (!handoff) { handoff = new SessionHandoff(); this.targets.set(target, handoff); }
    return handoff;
  }
}

const scopes = new WeakMap<object, SessionHandoffScope>();

/** Reuse an authority object (normally the transport) or explicitly pass a scope across transport replacement. */
export function sessionHandoffScope(authority: object): SessionHandoffScope {
  let scope = scopes.get(authority);
  if (!scope) { scope = new SessionHandoffScope(); scopes.set(authority, scope); }
  return scope;
}

/** Process-local handoff policy shared by attached clients and pre-attachment consumers. */
export class SessionHandoff {
  private state?: SessionHandoffState;
  private running = false;
  private readonly retained = new Map<string, SessionHandoffState>();
  private readonly listeners = new Set<() => void>();

  getState(generation?: string): SessionHandoffState | undefined {
    return generation === undefined ? this.state : this.retained.get(generation);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(state?: SessionHandoffState): void {
    if (state) this.retained.set(state.generation, state);
    else if (this.state) this.retained.delete(this.state.generation);
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** Namespace the generation by target when one consumer opens multiple unbound sessions. */
  async run(generation: string, operation: (options: { checkOnly: boolean; onRestoring(): void }) => Promise<void>, options: SessionTakeControlOptions = {}): Promise<void> {
    if (this.running) throw Object.assign(new Error('Native control is already being requested.'), { code: 'native_control_in_progress' });
    const wasUnknown = this.getState(generation)?.phase === 'unknown';
    const checkOnly = wasUnknown || options.checkOnly === true;
    let restoring = false;
    this.running = true;
    this.publish({ generation, phase: checkOnly ? 'checking' : 'taking' });
    try {
      await operation({ checkOnly, onRestoring: () => {
        restoring = true;
        this.publish({ generation, phase: 'restoring' });
        options.onRestoring?.();
      } });
      this.publish();
    } catch (error) {
      const unknown = wasUnknown || restoring || !(error instanceof SessionHandoffRejectedError);
      this.publish({ generation, phase: unknown ? 'unknown' : 'failed', message: unknown
        ? 'Handoff is not confirmed. Check the session before trying again.'
        : error instanceof Error ? error.message : 'Could not take control. Try again when connected.' });
      throw error;
    } finally { this.running = false; }
  }
}
