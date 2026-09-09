import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentReplicaState } from '../replica/types.js';

export interface AgentComposerProps {
  state?: AgentReplicaState;
  sessionKey?: string;
  disabled?: boolean;
  draft?: string;
  onDraftChange?(text: string): void;
  onSendMessage?(text: string): Promise<void>;
  onSteer?(text: string): Promise<void>;
  onCancel?(): Promise<void>;
}

interface Draft {
  text: string;
  pending?: 'send' | 'steer' | 'cancel';
  feedback?: { kind: 'success' | 'error'; message: string };
}

export function AgentComposer({ state, sessionKey, disabled = false, draft: controlledDraft, onDraftChange, onSendMessage, onSteer, onCancel }: AgentComposerProps) {
  const drafts = useRef(new Map<string, Draft>());
  const agentId = sessionKey ?? state?.agent?.id ?? '';
  const currentAgent = useRef(agentId);
  currentAgent.current = agentId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const mounted = useRef(true);
  const focusRequested = useRef<string>();
  const [, refresh] = useState(0);
  let draft = drafts.current.get(agentId);
  if (!draft) {
    draft = { text: '' };
    drafts.current.set(agentId, draft);
  }
  const currentDraft = draft;
  if (controlledDraft !== undefined) currentDraft.text = controlledDraft;
  function setText(value: string): void { currentDraft.text = value; onDraftChange?.(value); }
  const { text, pending, feedback } = currentDraft;
  const capabilities = state?.agent?.capabilities;
  const ready = Boolean(state?.agent) && !disabled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => { composing.current = false; }, [agentId]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    if (focusRequested.current === agentId && !pending) {
      focusRequested.current = undefined;
      if (!input.closest('[hidden]')) input.focus({ preventScroll: true });
    }
  }, [agentId, text, pending]);

  async function run(kind: 'send' | 'steer' | 'cancel'): Promise<void> {
    const action = kind === 'send' ? onSendMessage : kind === 'steer' ? onSteer : onCancel;
    if (!action || currentDraft.pending || !ready || (kind !== 'cancel' && !currentDraft.text.trim())) return;
    if (kind === 'send' && !capabilities?.sendMessage || kind === 'steer' && !capabilities?.steer || kind === 'cancel' && (!capabilities?.cancel || !state?.agent?.activeTurn)) return;
    const submitted = currentDraft.text;
    currentDraft.pending = kind;
    currentDraft.feedback = undefined;
    refresh((value) => value + 1);
    try {
      if (kind === 'cancel') await onCancel!();
      else await (action as (value: string) => Promise<void>)(submitted.trim());
      if (kind !== 'cancel' && currentDraft.text === submitted) setText('');
      currentDraft.feedback = { kind: 'success', message: kind === 'send' ? 'Message sent.' : kind === 'steer' ? 'Steer sent.' : 'Turn cancellation requested.' };
      if (kind !== 'cancel' && currentAgent.current === agentId) focusRequested.current = agentId;
    } catch (error) {
      currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : 'Agent command failed.' };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
    event.preventDefault();
    void run('send');
  }

  return <section className="agent-composer" aria-label="Live provider controls" aria-busy={Boolean(pending)}>
    <label htmlFor="prompt-input" className="agent-visually-hidden">Message</label>
    <textarea
      ref={inputRef}
      id="prompt-input"
      data-testid="prompt-input"
      rows={2}
      value={text}
      onChange={(event) => { setText(event.target.value); currentDraft.feedback = undefined; refresh((value) => value + 1); }}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      disabled={!ready || capabilities?.sendMessage !== true || Boolean(pending)}
      placeholder={ready ? 'Message the Agent…' : 'Open or attach to an Agent first.'}
      aria-describedby="composer-hint"
    />
    <div className="agent-composer-actions">
      <p id="composer-hint" className="agent-composer-note">Enter to send · Shift+Enter for a new line</p>
      <div className="agent-composer-secondary-controls">
        <button type="button" data-testid="steer-submit" disabled={!ready || capabilities?.steer !== true || !text.trim() || Boolean(pending) || !onSteer} title={capabilities?.steer ? 'Steer the active turn' : 'Steer is unavailable for this Provider.'} onClick={() => void run('steer')}>{pending === 'steer' ? 'Steering…' : 'Steer'}</button>
        <button type="button" data-testid="cancel-submit" disabled={!ready || capabilities?.cancel !== true || !state?.agent?.activeTurn || Boolean(pending) || !onCancel} onClick={() => void run('cancel')}>{pending === 'cancel' ? 'Cancelling…' : 'Cancel turn'}</button>
      </div>
      <button type="button" data-testid="prompt-submit" disabled={!ready || capabilities?.sendMessage !== true || !text.trim() || Boolean(pending) || !onSendMessage} onClick={() => void run('send')}>{pending === 'send' ? 'Sending…' : 'Send message'}</button>
    </div>
    {!ready ? <p className="agent-composer-note">Open or attach to an Agent first.</p> : null}
    {feedback ? <p className="agent-composer-note" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p> : null}
  </section>;
}
