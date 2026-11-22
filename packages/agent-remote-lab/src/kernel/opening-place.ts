/**
 * Where Bot mode opens. A tab keeps its own place across a reload (session storage); a new window or the installed app, which has no tab
 * record, opens at the device's last place (local storage), as a desktop app returns to the chat it showed. Both records hold the same
 * shape: a locator and whether the list showed, never connection state. Pure: the hook reads and writes the records.
 */
import { decodeBotPlace, type BotPlace } from './workbench-mode.js';

export interface SavedBotPlace { readonly place?: BotPlace; readonly rosterVisible: boolean }

/** The device's record of the last Bot-mode place, under a content prefix, so clearing conversations clears it too. */
export const lastBotPlaceKey = (scope: string) => `agent-remote:recovery:${scope}:last-bot-place`;

/** The place a page opens on: the tab's readable record, else the device's, else the list with nothing chosen. */
export function openingBotPlace(tab: unknown, device: unknown): SavedBotPlace {
  for (const saved of [tab, device]) {
    if (!saved || typeof saved !== 'object') continue;
    const record = saved as { place?: unknown; rosterVisible?: unknown };
    const place = decodeBotPlace(record.place);
    // A record whose place cannot be read is passed over; one that names no place is the list, which the tab keeps.
    if (!place && record.place !== undefined && record.place !== null) continue;
    return { ...(place ? { place } : {}), rosterVisible: typeof record.rosterVisible === 'boolean' ? record.rosterVisible : true };
  }
  return { rosterVisible: true };
}
