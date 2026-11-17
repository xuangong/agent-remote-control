import type { AgentInputPart, AgentSession } from '@orchardworks/agent-provider-sdk';
import { sessionReferencesAttachment, splitSessionExcerpts, withSessionReferenceNote, type SessionReferenceNote } from '@orchardworks/agent-remote-protocol';

export interface ReferenceNotes {
  /** The note the next input carries; none when the agent already knows the session's references. */
  pending(): Promise<SessionReferenceNote | undefined>;
  delivered(revision: number): Promise<void>;
}

/**
 * Tells a session's agent about changed references with its next input, whoever sends it: a page, the CLI, a Team or
 * a TPM. The note follows the sender's text and precedes any excerpts; a note that could not be prepared is left out
 * rather than holding the input back.
 */
export function withReferenceNotes(session: AgentSession, notes: ReferenceNotes): AgentSession {
  async function deliver<T>(send: (note: SessionReferenceNote | undefined) => Promise<T>): Promise<T> {
    const note = await notes.pending().catch(() => undefined);
    const result = await send(note);
    if (note) await notes.delivered(note.revision).catch(() => undefined);
    return result;
  }
  const withNote = (parts: readonly AgentInputPart[], note: SessionReferenceNote): AgentInputPart[] => {
    const attachment: AgentInputPart = { type: 'text', text: sessionReferencesAttachment(note) };
    const last = parts.at(-1);
    // Excerpts a page attached travel as the last text part; the note goes before them.
    const quoted = last?.type === 'text' && !splitSessionExcerpts(last.text).text.trim() && splitSessionExcerpts(last.text).excerpts.length > 0;
    return quoted ? [...parts.slice(0, -1), attachment, last!] : [...parts, attachment];
  };
  return new Proxy(session, {
    get(target, property) {
      if (property === 'sendMessage') return (text: string, ...rest: [never?]) => deliver(note => target.sendMessage(note ? withSessionReferenceNote(text, note) : text, ...rest));
      if (property === 'steer' && target.steer) return (text: string, ...rest: [never?]) => deliver(note => target.steer!(note ? withSessionReferenceNote(text, note) : text, ...rest));
      if (property === 'sendMessageContent' && target.sendMessageContent) {
        return (parts: readonly AgentInputPart[], ...rest: [never?]) => deliver(note => target.sendMessageContent!(note ? withNote(parts, note) : parts, ...rest));
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
