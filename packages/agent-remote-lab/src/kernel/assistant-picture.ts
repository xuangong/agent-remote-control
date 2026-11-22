import { botViews, type BotPicture, type WindowGroup, type WindowGroupEdit, type WindowGroupOperation, type WindowOperation } from '@orchardworks/agent-remote-protocol';
import { avatarWith, distinctAvatar } from '@orchardworks/agent-client-web/theme';
import { rankInPlace } from './assistant-groups.js';

/** The shape and colour of every assistant of the account: a bot's stored picture, or the avatar its view id generates. */
export function takenAvatars(groups: readonly WindowGroup[]): Array<{ shape: BotPicture['shape']; color: string }> {
  return groups.flatMap(group => botViews(group).map(view => {
    const { shape, color } = avatarWith(view.id, group.bots?.members[view.id]?.picture);
    return { shape, color };
  }));
}

/** The picture a new assistant is created with: its own generated avatar unless another assistant of the account already has that shape and colour. */
export function newAssistantPicture(viewId: string, groups: readonly WindowGroup[]): BotPicture {
  const { shape, color, gaze } = distinctAvatar(viewId, takenAvatars(groups));
  return { shape, color, gaze };
}

/**
 * The group operation that applies `operation` to `group` and gives the assistant it creates a picture of its own, making the
 * group a section first when it is not one. An operation that creates no view is returned as it is.
 */
export function withNewAssistantPicture(group: WindowGroup, groups: readonly WindowGroup[], operation: WindowOperation): WindowGroupOperation {
  const edits: WindowGroupEdit[] = operation.type === 'batch' ? [...operation.operations] : [operation];
  const created = edits.find(edit => edit.type === 'view.create' && !group.window.views.some(view => view.id === edit.view.id));
  if (created?.type !== 'view.create') return operation;
  const picture = newAssistantPicture(created.view.id, groups);
  return { type: 'batch', operations: [
    ...(group.bots ? [] : [{ type: 'bots.add', rank: rankInPlace(groups, group.window.id) } as const]), ...edits,
    { type: 'bot.update', viewId: created.view.id, details: { picture } }] };
}
