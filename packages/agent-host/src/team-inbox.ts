import { isTeam, type Team, type TeamMessage } from '@orchardworks/agent-remote-protocol';

type DeliveryStatus = Omit<TeamMessage, 'text' | 'resources'>;
type TeamRead = Team & { receipts?: DeliveryStatus[] };
const pageMessageLimit = 8, pageByteBudget = 48000, statusLimit = 32;

function teamResponse(value: unknown): TeamRead {
  if (!value || typeof value !== 'object') throw new Error('Invalid Team response.');
  const { receipts, ...team } = value as TeamRead;
  if (!isTeam(team) || receipts !== undefined && !Array.isArray(receipts)) throw new Error('Invalid Team response.');
  return value as TeamRead;
}

function deliveryOrder(left: Pick<TeamMessage, 'id' | 'createdAt'>, right: Pick<TeamMessage, 'id' | 'createdAt'>): number {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function deliveryStatus(message: DeliveryStatus) {
  return { id: message.id, from: message.from, to: message.to, status: message.status, createdAt: message.createdAt,
    ...(message.acceptance ? { acceptance: message.acceptance } : {}),
    ...(message.resolvedTarget ? { resolvedTarget: message.resolvedTarget } : {}),
    ...(message.error ? { error: message.error.slice(0, 256) } : {}),
  };
}

/** Whole incoming messages are the only bodies exposed by the agent-facing Team read. */
/** group: include the Call For Support group state, which only its coordinator reads. */
export function teamInbox(value: unknown, memberId: string, afterMessageId?: string, options: { group?: boolean } = {}) {
  const team = teamResponse(value), receipts = team.receipts ?? [];
  const incoming = team.messages.filter(message => message.to === memberId).sort(deliveryOrder);
  const cursor = afterMessageId ? [...incoming, ...receipts].find(message => message.id === afterMessageId && message.to === memberId) : undefined;
  if (afterMessageId && !cursor) throw new Error('Team inbox cursor expired or is not addressed to you. Call read_team without afterMessageId to restart.');
  const pending = cursor ? incoming.filter(message => deliveryOrder(message, cursor) > 0) : incoming;
  const messages: TeamMessage[] = [];
  let byteLength = 0;
  for (const message of pending) {
    const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (messages.length && (messages.length >= pageMessageLimit || byteLength + size > pageByteBudget)) break;
    messages.push(message); byteLength += size;
  }
  const hasMore = messages.length < pending.length;
  const statuses = team.messages.filter(message => message.to !== memberId).sort(deliveryOrder);
  return { id: team.id, title: team.title, status: team.status, revision: team.revision, source: team.source,
    members: team.members, createdAt: team.createdAt, updatedAt: team.updatedAt,
    messages, inboxCount: incoming.length, hasMore, ...(hasMore ? { nextAfterMessageId: messages.at(-1)!.id } : {}),
    messageStatuses: statuses.slice(-statusLimit).map(deliveryStatus), messageStatusCount: statuses.length,
    receipts: receipts.slice(-statusLimit).map(deliveryStatus), receiptCount: receipts.length,
    ...(options.group && team.callForSupport ? { callForSupport: team.callForSupport } : {}),
  };
}

/** Progress and responsibility updates return the affected member without repeating inbox contents. */
export function teamMemberUpdate(value: unknown, memberId: string) {
  const team = teamResponse(value), member = team.members.find(member => member.id === memberId);
  if (!member) throw new Error('Team member was not returned.');
  return { id: team.id, title: team.title, status: team.status, revision: team.revision, member };
}
