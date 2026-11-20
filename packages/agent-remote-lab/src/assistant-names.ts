import { assistantName, assistantNames, translator, type NamedAssistant, type Translate } from '@orchardworks/agent-client';
import { botViews, type WindowGroup, type WindowGroupEdit, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';

/** A session as the account knows it, for an assistant that is in no group (a session of Bot mode's Other sessions). */
export interface NamedSession { readonly hostId?: string; readonly providerId: string; readonly nativeSessionId: string }

/** What names a view's assistant in the account: its group and view, the same on every device. */
export const viewAssistantKey = (groupId: string, viewId: string): string => `${groupId}/${viewId}`;
const sessionAssistantKey = (session: NamedSession): string => `session:${session.hostId ?? 'local'}/${session.providerId}/${session.nativeSessionId}`;

/** The names the assistants of an account are called by (`assistantNames`): every bot view of every group, Bot mode's rows and Window mode's tiles alike. */
export interface AccountNames {
  view(groupId: string, viewId: string): string;
  session(session: NamedSession): string;
}

/** The assistants of an account: every bot view of every group, with the name its details store. */
export function accountAssistants(groups: readonly WindowGroup[]): NamedAssistant[] {
  return groups.flatMap(group => botViews(group).map(view => {
    const name = group.bots?.members[view.id]?.name;
    return { key: viewAssistantKey(group.window.id, view.id), ...(name ? { name } : {}) };
  }));
}

export function accountNames(groups: readonly WindowGroup[], t: Translate = translator('en')): AccountNames {
  const assistants = accountAssistants(groups);
  const names = new Map(assistantNames(assistants, t));
  // An assistant the groups do not hold yet (a view being created, a session of Other sessions) is named among them.
  const of = (key: string) => names.get(key) ?? names.set(key, assistantName({ key }, assistants, t)).get(key)!;
  return { view: (groupId, viewId) => of(viewAssistantKey(groupId, viewId)), session: session => of(sessionAssistantKey(session)) };
}

/**
 * Every bot.update keeps the name its assistant is called by: the stored name when the new details leave it out, or the
 * generated one at the bot's first edit, which stores it. So a bot stored before names needs no migration, and the name
 * a reader sees is the one every device keeps.
 */
export function withAssistantNames(group: WindowGroup | undefined, operation: WindowGroupOperation, names: AccountNames): WindowGroupOperation {
  if (!group) return operation;
  const named = (edit: WindowGroupEdit): WindowGroupEdit => edit.type !== 'bot.update' || edit.details.name ? edit
    : { ...edit, details: { ...edit.details, name: group.bots?.members[edit.viewId]?.name ?? names.view(group.window.id, edit.viewId) } };
  return operation.type === 'batch' ? { ...operation, operations: operation.operations.map(named) } : named(operation);
}
