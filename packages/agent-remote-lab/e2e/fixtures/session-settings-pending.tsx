import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentSessionSettingChange } from '@orchardworks/agent-remote-protocol';
import { AgentSessionSettings, type SessionControlView } from '../../../agent-remote-web/src/react/AgentSessionSettings.js';
import type { AgentReplicaState } from '../../../agent-remote-web/src/replica/types.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles';

const initialState: AgentReplicaState = { ...replicaState, agent: { ...replicaState.agent!, status: 'running',
  capabilities: { ...replicaState.agent!.capabilities, sessionSettings: true }, settingChanges: [],
  runtimeInfo: { ...replicaState.agent!.runtimeInfo, status: 'running', model: 'model-a', settings: [
    { id: 'model', category: 'model', label: 'Model', value: 'model-a', mutable: true, scope: 'session',
      options: [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }], description: 'The running task continues while the native runtime applies this selection.' },
    { id: 'approval', category: 'permissions', label: 'Approval policy', value: 'ask', mutable: true, scope: 'session',
      options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }], description: 'Native permission policy remains authoritative until confirmation.' },
  ] },
} };

function Surface({ name, state, onSelect }: { name: string; state: AgentReplicaState; onSelect(id: string, value: string): Promise<void> }) {
  const [view, setView] = useState<SessionControlView>();
  const [busy, setBusy] = useState(false);
  return <section className="agent-remote-surface" aria-label={name} style={{ padding: 16, minWidth: 0 }}>
    <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{name}</h2>
    <p style={{ margin: '0 0 20px', color: 'var(--agent-muted)' }}>Same session · Task running</p>
    <div className="agent-composer">
      <AgentSessionSettings state={state} disabled={false} busy={busy} view={view} onView={setView} onPendingChange={setBusy} onSelect={onSelect} />
      <textarea aria-label={`${name} draft`} defaultValue="Keep this task running." readOnly />
    </div>
  </section>;
}

function Fixture() {
  const [state, setState] = useState(initialState);
  const request = useRef(0);
  async function select(id: string, value: string) {
    const requestId = `setting-request-${++request.current}`;
    setState(previous => {
      const setting = previous.agent!.runtimeInfo.settings!.find(setting => setting.id === id)!;
      const change: AgentSessionSettingChange = { settingId: id, category: setting.category, label: setting.label,
        requestId, targetValue: value, confirmedValue: setting.value, status: 'pending',
        requestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30_000).toISOString() };
      return { ...previous, agent: { ...previous.agent!, settingChanges: [...(previous.agent!.settingChanges ?? []).filter(change => change.settingId !== id), change] } };
    });
  }
  function settle(id: string, confirmed: boolean) {
    setState(previous => {
      const agent = previous.agent!;
      const pending = agent.settingChanges?.find(change => change.settingId === id && change.status === 'pending');
      if (!pending) return previous;
      const settingChanges = confirmed ? agent.settingChanges!.filter(change => change !== pending)
        : agent.settingChanges!.map(change => change !== pending ? change : { ...change, status: 'timed_out' as const,
          message: `${pending.label} change was not confirmed in time. Current native value was retained.` });
      const settings = agent.runtimeInfo.settings!.map(setting => confirmed && setting.id === id ? { ...setting, value: pending.targetValue } : setting);
      return { ...previous, agent: { ...agent, settingChanges, runtimeInfo: { ...agent.runtimeInfo, settings,
        ...(confirmed && id === 'model' ? { model: pending.targetValue } : {}) } } };
    });
  }
  return <main style={{ maxWidth: 1100, margin: '0 auto', padding: 20, color: 'var(--agent-ink)', fontFamily: 'system-ui, sans-serif' }}>
    <h1 style={{ fontSize: 24, marginBottom: 8 }}>Shared session settings</h1>
    <p>Two settings surfaces share accepted requests and native state. Each surface tracks its own unread outcomes.</p>
    <section aria-label="Native outcome controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBlock: 20 }}>
      {[['model', 'model'], ['approval', 'permissions']].map(([id, label]) => <div key={id} style={{ display: 'flex', gap: 8 }}>
        <button style={{ minHeight: 44 }} onClick={() => settle(id!, true)}>Confirm {label}</button>
        <button style={{ minHeight: 44 }} onClick={() => settle(id!, false)}>Time out {label}</button>
      </div>)}
    </section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 20 }}>
      <Surface name="Primary view" state={state} onSelect={select} />
      <Surface name="Shared view" state={state} onSelect={select} />
    </div>
    <output data-testid="native-values" style={{ display: 'block', marginTop: 20, fontSize: 13 }}>Confirmed native values: {state.agent!.runtimeInfo.settings!.map(setting => `${setting.label}: ${setting.value}`).join(' · ')}</output>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
