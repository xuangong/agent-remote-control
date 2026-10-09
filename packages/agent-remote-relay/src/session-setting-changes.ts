import { randomUUID } from 'node:crypto';
import type { AgentRuntimeInfo, AgentSession, AgentSessionSetting } from '@orchardworks/agent-provider-sdk';
import type { AgentSessionSettingChange } from '@orchardworks/agent-remote-protocol';

const SETTING_DEADLINE_MS = 30_000;
const READBACK_INTERVAL_MS = 1_000;
const READBACK_DEADLINE_MS = 5_000;

interface Intent {
  change: AgentSessionSettingChange;
  phase: 'queued' | 'applying' | 'pending' | 'deferred' | 'settled';
  deferredRuntime?: string;
  observedDifferentValue?: boolean;
  applied?: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns accepted intents, never native option interpretation or native state. */
export class SessionSettingChanges {
  private readonly intents = new Map<string, Intent>();
  private nativeRevision = 0;
  private applying = false;
  private closed = false;
  private refreshing = false;
  private cancelReadback?: () => void;
  private poll?: ReturnType<typeof setTimeout>;
  private runtime: AgentRuntimeInfo;

  constructor(private readonly options: {
    runtime: AgentRuntimeInfo;
    apply: NonNullable<AgentSession['setSessionSetting']>;
    refresh: () => Promise<void>;
    publish: (changes: AgentSessionSettingChange[]) => void;
    clock: () => Date;
  }) { this.runtime = options.runtime; }

  accept(setting: AgentSessionSetting, targetValue: string): void {
    const settingId = setting.id;
    const previous = this.intents.get(settingId);
    if (previous) clearTimeout(previous.timer);
    const requestedAt = this.options.clock();
    const change: AgentSessionSettingChange = {
      settingId, category: setting.category, label: setting.label, requestId: randomUUID(), targetValue,
      confirmedValue: this.runtime.settings?.find(setting => setting.id === settingId)?.value ?? previous?.change.confirmedValue ?? null,
      status: 'pending', requestedAt: requestedAt.toISOString(),
      deadlineAt: new Date(requestedAt.getTime() + SETTING_DEADLINE_MS).toISOString(),
    };
    const intent: Intent = { change, phase: 'queued', timer: setTimeout(() => this.expire(intent), SETTING_DEADLINE_MS) };
    intent.timer.unref?.();
    this.intents.set(settingId, intent);
    this.publish();
    void this.drain();
    this.scheduleReadback();
  }

  observe(runtime: AgentRuntimeInfo, nativeObservation = true): void {
    if (this.closed) return;
    this.runtime = runtime;
    if (nativeObservation) this.nativeRevision++;
    const fingerprint = JSON.stringify(runtime);
    for (const [id, intent] of this.intents) {
      const actual = runtime.settings?.find(setting => setting.id === id)?.value;
      if (actual !== undefined && actual !== null) intent.change.confirmedValue = actual;
      if (intent.change.status !== 'pending') continue;
      if ((intent.phase === 'applying' || intent.phase === 'pending') && actual !== undefined && actual !== null && actual !== intent.change.targetValue) intent.observedDifferentValue = true;
      if (this.confirm(intent)) continue;
      else if (intent.phase === 'deferred' && (nativeObservation || intent.deferredRuntime !== fingerprint)) {
        intent.phase = 'queued';
      }
    }
    this.publish();
    void this.drain();
  }

  hasUnsettledWork(): boolean { return this.applying || this.pending(); }

  private confirm(intent: Intent): boolean {
    // A native queued return to the original value needs an observed transition.
    // A matching baseline alone cannot acknowledge a newer intent.
    if (intent.phase !== 'pending' || !this.current(intent) || intent.change.status !== 'pending'
      || (!intent.applied && !intent.observedDifferentValue)
      || this.runtime.settings?.find(setting => setting.id === intent.change.settingId)?.value !== intent.change.targetValue) return false;
    clearTimeout(intent.timer);
    this.intents.delete(intent.change.settingId);
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.poll) clearTimeout(this.poll);
    this.cancelReadback?.();
    for (const intent of this.intents.values()) clearTimeout(intent.timer);
  }

  private current(intent: Intent): boolean { return !this.closed && this.intents.get(intent.change.settingId) === intent; }
  private pending(): boolean { return [...this.intents.values()].some(intent => intent.change.status === 'pending'); }
  private publish(): void {
    if (!this.closed) this.options.publish([...this.intents.values()].map(intent => ({ ...intent.change })));
  }

  private async drain(): Promise<void> {
    if (this.closed || this.applying) return;
    const intent = [...this.intents.values()].find(item => item.phase === 'queued' && item.change.status === 'pending');
    if (!intent) return;
    this.applying = true;
    intent.phase = 'applying';
    const baseline = this.runtime.settings?.find(setting => setting.id === intent.change.settingId)?.value;
    intent.observedDifferentValue = baseline !== undefined && baseline !== null && baseline !== intent.change.targetValue;
    intent.applied = false;
    const fingerprint = JSON.stringify(this.runtime);
    const nativeRevision = this.nativeRevision;
    try {
      const result = await this.options.apply(intent.change.settingId, intent.change.targetValue);
      if (this.current(intent) && intent.change.status === 'pending') {
        intent.phase = result?.status === 'deferred' ? 'deferred' : 'pending';
        intent.applied = result === undefined;
        if (intent.phase === 'deferred') {
          intent.deferredRuntime = fingerprint;
          if (nativeRevision !== this.nativeRevision) intent.phase = 'queued';
        }
      }
      if (this.confirm(intent)) this.publish();
      if (!this.closed) void this.readback();
    } catch (error) {
      if (this.current(intent) && intent.change.status === 'pending') {
        clearTimeout(intent.timer);
        intent.phase = 'settled';
        intent.change.status = 'failed';
        intent.change.message = error instanceof Error && error.message ? error.message : 'The setting could not be applied.';
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code) intent.change.code = error.code;
        this.publish();
      }
      if (!this.closed) void this.readback();
    } finally {
      this.applying = false;
      void this.drain();
    }
  }

  private expire(intent: Intent): void {
    if (!this.current(intent) || intent.change.status !== 'pending') return;
    intent.change.status = 'timed_out';
    intent.phase = 'settled';
    intent.change.message = 'The setting change timed out. Showing the last confirmed value.';
    this.publish();
    void this.readback();
  }

  private async readback(): Promise<void> {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    let finish!: () => void;
    const deadline = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, READBACK_DEADLINE_MS);
      timer.unref?.();
      finish = () => { clearTimeout(timer); resolve(); };
    });
    this.cancelReadback = finish;
    try { await Promise.race([this.options.refresh(), deadline]); }
    catch { /* The last confirmed value remains available when native readback fails. */ }
    finally { finish(); this.cancelReadback = undefined; this.refreshing = false; }
  }

  private scheduleReadback(): void {
    if (this.closed || this.poll || !this.pending()) return;
    this.poll = setTimeout(() => {
      this.poll = undefined;
      void this.readback();
      this.scheduleReadback();
    }, READBACK_INTERVAL_MS);
    this.poll.unref?.();
  }
}
