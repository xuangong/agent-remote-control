import { describe, expect, it, vi } from 'vitest';
import type { SessionOperationAvailability, SessionOperationKind } from '@orchardworks/agent-remote-protocol';
import { sessionActions, type SessionActionFacts } from './session-actions.js';
import type { LabWorkbenchActions } from './session-workbench-props.js';

const kinds: readonly SessionOperationKind[] = ['send_message', 'queue_message', 'steer', 'cancel', 'set_planning', 'set_session_setting', 'execute_command', 'interaction_response'];
const operations = (refused: readonly SessionOperationKind[] = []) => Object.fromEntries(kinds.map(kind =>
  [kind, refused.includes(kind) ? { allowed: false, code: 'busy', reason: 'Refused.' } : { allowed: true }])) as Record<SessionOperationKind, SessionOperationAvailability>;
/** Every action a view can be given, each a distinct function so a row can tell which one it kept. */
const names = ['searchTimeline', 'loadSearchMatch', 'loadOlder', 'requestResource', 'resolveResource', 'deleteMessage', 'sendMessage', 'retryMessage', 'editPrompt',
  'cancel', 'setPlanning', 'setSessionSetting', 'executeCommand', 'respondToInteraction', 'uploadImage'] as const;
const supplied = Object.fromEntries(names.map(name => [name, vi.fn()])) as unknown as Required<Pick<LabWorkbenchActions, typeof names[number]>>;
const reading = ['deleteMessage', 'loadOlder', 'loadSearchMatch', 'requestResource', 'resolveResource', 'searchTimeline'];
const everything = Object.keys(supplied).sort();

/** Each row: the facts, and the names of the actions the view offers (an action offered is the one supplied). */
const vectors: ReadonlyArray<{ name: string; facts: Partial<SessionActionFacts> & { refused?: SessionOperationKind[]; synchronized?: boolean }; offered: string[] }> = [
  { name: 'a draft-only composer offers nothing, even when synchronized', facts: { draftOnly: true }, offered: [] },
  { name: 'a read-only view keeps only reading, history, resources and deleting', facts: { readOnly: true }, offered: reading },
  { name: 'a held view (Handoff, unconfirmed Window) reads like a read-only one', facts: { mutationBlocked: true }, offered: reading },
  { name: 'draft-only wins over read-only', facts: { draftOnly: true, readOnly: true }, offered: [] },
  { name: 'read-only wins over an unsynchronized session', facts: { readOnly: true, synchronized: false }, offered: reading },
  { name: 'an unsynchronized session offers only deleting a local message', facts: { synchronized: false }, offered: ['deleteMessage'] },
  { name: 'a synchronized session that allows everything offers every action', facts: {}, offered: everything },
  { name: 'a refused send takes retry and prompt edit, not sending itself', facts: { refused: ['send_message'] }, offered: everything.filter(name => !['retryMessage', 'editPrompt'].includes(name)) },
  { name: 'a refused cancel takes Stop', facts: { refused: ['cancel'] }, offered: everything.filter(name => name !== 'cancel') },
  { name: 'a refused planning switch takes the mode control', facts: { refused: ['set_planning'] }, offered: everything.filter(name => name !== 'setPlanning') },
  { name: 'a refused setting takes the settings', facts: { refused: ['set_session_setting'] }, offered: everything.filter(name => name !== 'setSessionSetting') },
  { name: 'a refused command takes running commands', facts: { refused: ['execute_command'] }, offered: everything.filter(name => name !== 'executeCommand') },
  { name: 'a refused interaction response takes answering', facts: { refused: ['interaction_response'] }, offered: everything.filter(name => name !== 'respondToInteraction') },
  { name: 'refusing queueing and steering takes nothing the view offers', facts: { refused: ['queue_message', 'steer'] }, offered: everything },
];

describe('the actions a conversation view offers', () => {
  it.each(vectors)('$name', ({ facts, offered }) => {
    const { refused, synchronized = true, ...flags } = facts;
    const result = sessionActions({ draftOnly: false, readOnly: false, mutationBlocked: false, ...flags, session: { synchronized, operations: operations(refused) } }, supplied);
    const kept = Object.entries(result).filter(([, action]) => action !== undefined).map(([name]) => name).sort();
    expect(kept).toEqual([...offered].sort());
    for (const name of kept) expect(result[name as keyof LabWorkbenchActions]).toBe(supplied[name as keyof typeof supplied]);
  });
});
