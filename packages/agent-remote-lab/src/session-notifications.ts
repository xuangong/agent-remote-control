import type { SessionObservation } from './tracking-state.js';
import type { SessionEntry } from './session-tree.js';
import { sessionKey } from './session-tree.js';
import type { WorkbenchMode } from './workbench-mode.js';

type Reminder = 'idle' | 'waiting';
interface NotificationClickScope { mode: WorkbenchMode; lifetime: object }
interface DeliveredNotification { key: string; admission?: symbol; clickScope: NotificationClickScope }
const ledgerKey = 'agent-remote:notification-receipts';

async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Product attention follows live activity, independently of Track visibility/read receipts. */
export class SessionAttentionNotifications {
  private readonly observations = new Map<string, SessionObservation>();
  private readonly displayed = new Set<string>();
  private readonly routes = new Map<string, () => void>();
  private readonly notifications = new Map<Notification, DeliveredNotification>();
  private readonly defaultClickScope: NotificationClickScope = { mode: 'bot', lifetime: {} };
  private eligible: Map<string, symbol> | undefined;
  private disposed = false;
  constructor(private readonly scope: string, private readonly enabled: () => boolean,
    private readonly open: (session: SessionEntry) => void,
    private readonly clickScope: () => NotificationClickScope = () => this.defaultClickScope) {}

  setEligible(sessions: readonly SessionEntry[]): void {
    const keys = new Set(sessions.map(sessionKey));
    const next = new Map<string, symbol>();
    for (const key of keys) next.set(key, this.eligible?.get(key) ?? Symbol(key));
    this.eligible = next;
    for (const key of this.observations.keys()) if (!keys.has(key)) this.observations.delete(key);
    for (const [notification, delivered] of this.notifications) if (!this.acceptsClick(delivered)) {
      notification.close(); this.notifications.delete(notification);
    }
  }

  private accepts(key: string, admission?: symbol): boolean {
    return !this.disposed && (!this.eligible || this.eligible.has(key) && (!admission || this.eligible.get(key) === admission));
  }

  private acceptsClick(delivered: DeliveredNotification): boolean {
    const current = this.clickScope();
    return !this.disposed && this.enabled() && delivered.clickScope.lifetime === current.lifetime
      && delivered.clickScope.mode === current.mode
      && (current.mode === 'window' || this.accepts(delivered.key, delivered.admission));
  }

  setDisplayed(sessions: readonly SessionEntry[]): void {
    const keys = new Set(sessions.map(sessionKey));
    for (const [key, release] of this.routes) if (!keys.has(key)) { release(); this.routes.delete(key); }
    this.displayed.clear();
    for (const key of keys) {
      this.displayed.add(key);
      if (!this.routes.has(key) && navigator.locks && crypto.subtle) {
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        this.routes.set(key, release);
        void fingerprint(`${this.scope}:${key}`).then(id => {
          if (this.disposed || this.routes.get(key) !== release) return;
          // Displaying tabs hold a shared route. Background observers cannot claim it.
          return navigator.locks.request(`arc:notification-route:${id}`, { mode: 'shared' }, () => held);
        }).catch(() => { /* Notification delivery can still use its browser tag. */ });
      }
    }
  }

  async observe(session: SessionEntry, next: SessionObservation): Promise<void> {
    const key = sessionKey(session), previous = this.observations.get(key);
    if (!this.accepts(key)) return;
    if (!this.enabled()) { this.observations.delete(key); return; }
    if (next.connection !== 'ready' || !next.activity) return;
    const admission = this.eligible?.get(key);
    const clickScope = this.clickScope();
    this.observations.set(key, next);
    const visibleResult = next.background?.status === 'visible' && (next.background.id !== previous?.background?.id || previous?.background?.status !== 'visible');
    if (!previous?.activity || next.activity === previous.activity && !visibleResult) return;
    if (next.activity === 'idle' && next.background?.status === 'silent') return;
    if (previous.cursor?.epoch !== next.cursor?.epoch) return;
    const reminder: Reminder | undefined = next.activity === 'waiting' ? 'waiting'
      : (previous.activity === 'running' || visibleResult) && next.activity === 'idle' ? 'idle' : undefined;
    if (!reminder || !this.enabled() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // A cursor gives all observers the same identity without inventing a native turn ID.
    const identity = JSON.stringify([this.scope, key, reminder, next.cursor]);
    try {
      const id = crypto.subtle ? await fingerprint(identity) : identity;
      const deliver = () => {
        if (!this.accepts(key, admission) || !this.enabled() || this.clickScope().lifetime !== clickScope.lifetime || Notification.permission !== 'granted') return;
        let receipts: string[] = [];
        try {
          const stored: unknown = JSON.parse(localStorage.getItem(ledgerKey) ?? '[]');
          if (Array.isArray(stored)) receipts = stored.filter((item): item is string => typeof item === 'string');
          if (next.cursor && receipts.includes(id)) return;
        } catch { /* Browser tags still collapse active notifications if storage is blocked. */ }
        const notification = new Notification(reminder === 'waiting' ? 'Session needs your input' : 'Session completed', {
          body: session.title, tag: `arc:${id}`,
        });
        const delivered = { key, admission, clickScope };
        this.notifications.set(notification, delivered);
        notification.onclose = () => this.notifications.delete(notification);
        notification.onclick = () => {
          if (this.acceptsClick(delivered)) { window.focus(); this.open(session); }
          notification.close();
        };
        // Only opaque, bounded deduplication receipts are persisted; never message contents.
        if (next.cursor && crypto.subtle) try { localStorage.setItem(ledgerKey, JSON.stringify([...receipts, id].slice(-256))); } catch { /* Tag fallback. */ }
      };
      const once = () => navigator.locks ? navigator.locks.request('arc:notification-receipts', deliver) : deliver();
      if (this.displayed.has(key) || !navigator.locks || !crypto.subtle) await once();
      else {
        const route = await fingerprint(`${this.scope}:${key}`);
        await navigator.locks.request(`arc:notification-route:${route}`, { ifAvailable: true }, lock => lock ? once() : undefined);
      }
    } catch { /* Denial or unavailable platform delivery must never interrupt the session. */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const release of this.routes.values()) release();
    this.routes.clear(); this.observations.clear();
    for (const notification of this.notifications.keys()) notification.close();
    this.notifications.clear();
  }
}
