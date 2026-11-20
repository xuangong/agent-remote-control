/**
 * What an assistant is doing, in one sentence (I3 plan, section 4.3). One pure rule over the facts a list row, the top bar and
 * the details panel already hold; the first matching state wins:
 * needs you, host offline, failed, ended, resting, working, waiting to send, idle, unknown.
 *
 * - Never speaks of connections: an unknown or offline activity alone is `unknown` or `host_offline`, never "working".
 * - Control notices (terminal in control, other controller, read only, agent unavailable) are the composer's words and do not
 *   change the state.
 */
import type { AgentStatus } from '@orchardworks/agent-remote-protocol';
import type { SessionNotice } from '../client/session-presentation.js';
import { translator, type Translate } from './messages.js';

export interface AssistantFacts {
  /** The session's activity; a superset of the shared session states. */
  readonly activity: AgentStatus | 'unknown' | 'offline';
  readonly host?: { readonly online: boolean; readonly name?: string };
  readonly asleep: boolean;
  /** An outbox entry waits for the session. */
  readonly waitingToSend: boolean;
  /** The session's business notice, when its replica is open. */
  readonly notice?: SessionNotice;
  readonly replyPreview?: string;
}

export type AssistantState = 'needs_you' | 'working' | 'waiting_to_send' | 'failed' | 'ended' | 'host_offline' | 'resting' | 'idle' | 'unknown';
/** The avatar's moods; the same words the web client's avatar takes. */
export type AssistantMood = 'idle' | 'working' | 'needs_you' | 'resting';
export interface AssistantStatus { readonly state: AssistantState; readonly sentence: string; readonly mood: AssistantMood }

const MOODS: Readonly<Record<AssistantState, AssistantMood>> = {
  needs_you: 'needs_you', working: 'working', resting: 'resting',
  waiting_to_send: 'idle', failed: 'idle', ended: 'idle', host_offline: 'idle', idle: 'idle', unknown: 'idle',
};

const preview = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

function stateOf(facts: AssistantFacts): AssistantState {
  const { activity, notice } = facts;
  if (activity === 'waiting') return 'needs_you';
  if (notice?.kind === 'host_offline' || facts.host?.online === false || activity === 'offline') return 'host_offline';
  if (activity === 'failed' || notice?.kind === 'failed' || notice?.kind === 'unavailable') return 'failed';
  if (activity === 'closed' || notice?.kind === 'ended') return 'ended';
  if (facts.asleep) return 'resting';
  if (activity === 'running' || activity === 'starting') return 'working';
  if (facts.waitingToSend) return 'waiting_to_send';
  return activity === 'idle' ? 'idle' : 'unknown';
}

function sentenceOf(state: AssistantState, facts: AssistantFacts, t: Translate): string {
  switch (state) {
    case 'needs_you': return t('assistant.needsYou');
    case 'host_offline': {
      const host = facts.notice?.kind === 'host_offline' && facts.notice.hostName || facts.host?.name;
      return host ? t('assistant.hostOffline', { host }) : t('assistant.hostOfflineUnnamed');
    }
    case 'failed': return t('assistant.failed');
    case 'ended': return t('assistant.ended');
    case 'resting': return t('assistant.resting');
    case 'working': return t('assistant.working');
    case 'waiting_to_send': return t('assistant.waitingToSend');
    case 'idle': return preview(facts.replyPreview) || t('assistant.ready');
    case 'unknown': return preview(facts.replyPreview);
  }
}

export function assistantStatus(facts: AssistantFacts, t: Translate = translator('en')): AssistantStatus {
  const state = stateOf(facts);
  return { state, sentence: sentenceOf(state, facts, t), mood: MOODS[state] };
}

/**
 * A state in one or two words, for lists that roll several assistants up (a Window and its views in Window mode's list,
 * the panes of the Window overview); the assistant view says the sentence. Quiet states have no word.
 */
export function assistantStateWord(state: AssistantState, t: Translate = translator('en')): string | undefined {
  switch (state) {
    case 'needs_you': return t('state.needsYou');
    case 'working': return t('state.working');
    case 'failed': return t('state.failed');
    case 'host_offline': return t('state.hostOffline');
    default: return undefined;
  }
}
