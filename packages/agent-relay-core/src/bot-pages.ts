/**
 * A standing bot's pages, kept on its inbox next to its board: markdown documents the bot keeps for everyone of the account to
 * read. Only the bot writes them (whole-document rewrites); the page of a team shows as one card in its conversation and its chief's,
 * rendered from this record, so a rewrite updates the card in place.
 */
import { randomUUID } from 'node:crypto';
import { PAGES_PER_BOT, type Page, type TeamInbox } from '@orchardworks/agent-remote-protocol';
import type { Assistant, AssistantBrokerPorts } from './assistants.js';
import type { BotInboxes } from './inboxes.js';

const fail = (message: string): never => { throw new Error(message); };
/** What a bot writes of one page: no id creates a page. */
export interface PageEdit { title: string; contents: string; pageId?: string; team?: true }

/**
 * Writes one page on an inbox. A rewrite that changes nothing keeps the version and the time. At most one page of a bot is its team
 * page: marking another page moves the mark.
 */
export function writePage(box: TeamInbox, edit: PageEdit, now: number, newId: () => string = () => `pg_${randomUUID().replaceAll('-', '').slice(0, 12)}`): { page: Page; created: boolean } {
  const pages = box.pages ??= [];
  let page = edit.pageId ? pages.find(item => item.pageId === edit.pageId) ?? fail(`You have no page ${edit.pageId}; list your pages with read_page.`) : undefined;
  const created = !page;
  if (!page) {
    if (pages.length >= PAGES_PER_BOT) fail(`You keep ${PAGES_PER_BOT} pages at most; rewrite one of them (read_page lists them).`);
    page = { pageId: newId(), title: edit.title, contents: edit.contents, version: 1, updatedAt: now };
    pages.push(page);
  } else if (page.title !== edit.title || page.contents !== edit.contents || (edit.team && !page.team)) {
    page.title = edit.title; page.contents = edit.contents; page.version++; page.updatedAt = now;
  }
  if (edit.team) {
    for (const other of pages) if (other !== page) delete other.team;
    page.team = true;
  }
  return { page, created };
}

/** The pages of a bot with the contents left out, newest write first. */
export const pageList = (pages: readonly Page[]) => [...pages].sort((a, b) => b.updatedAt - a.updatedAt).map(({ contents: _contents, ...page }) => page);

/** The pages' calls on the inbox of a standing bot. */
export class BotPages {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly inboxes: BotInboxes) {}
  /** The bot's pages as they stand. */
  read(bot: Assistant): readonly Page[] { return this.inboxes.current(this.broker.ports.read(), bot)?.inbox?.pages ?? []; }
  async write(bot: Assistant, edit: PageEdit): Promise<{ page: Page; created: boolean }> {
    return this.broker.change(teams => {
      const now = this.broker.ports.now(), inbox = this.inboxes.prepare(teams, bot, now) ?? fail('Team capacity reached.');
      const written = writePage(inbox.inbox!, edit, now);
      inbox.revision++; inbox.updatedAt = now;
      return { page: { ...written.page }, created: written.created };
    });
  }
}
