import type { AgentRereadBehaviour, ProviderObservation, ProviderStreamItem } from './index.js';

/**
 * What a real native runtime did for one scenario: the CLI it was made with, the observations of the live run, and the history observations
 * of the same native session opened again. An adapter's recorder writes them; the Controller's continuity tests read them. A recorded fact
 * holds for the CLI version that made it: every committed recording names it (`pnpm fixtures:check`), and the native checks fail while the
 * installed CLI is another (`pnpm test:native:<cli>`).
 */
export interface JournalRecording { cli?: RecordedCli; live: ProviderObservation[]; reread: ProviderObservation[] }

/** The CLI a recording was made with: its name, and the version it reported. */
export interface RecordedCli { name: string; version: string }

/** The observations a journal is built from; usage and runtime snapshots are not recorded. */
export const journalObservation = (item: ProviderStreamItem): item is ProviderObservation => item.type === 'observation'
  && ['timeline', 'interaction_requested', 'interaction_resolved', 'interaction_invalidated', 'turn_started', 'turn_completed', 'turn_failed', 'turn_canceled'].includes(item.event.type);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * What a recording says about identities and delivery, with ids masked and repeated snapshots of one item counted once, so a run of a
 * recorder is compared with the recording it made before. Lines move only as the journal's rules allow:
 * - a live-only item has no place among the others (the window decision compares it by key), so its lines follow the others of their
 *   side, sorted;
 * - for an adapter whose declared reread `order` is `siblings_unordered`, the lines of consecutive observations of one turn are sorted,
 *   since the siblings of a turn may come in any order.
 */
export function recordingShape(recording: JournalRecording, order: AgentRereadBehaviour['order'] = 'live'): string[] {
  const side = (observations: ProviderObservation[], name: string): string[] => {
    const lines = observations.map(({ delivery, event, itemIdentity }) => {
      const item = event.type === 'timeline' ? event.item.type : event.type === 'interaction_resolved' ? 'resolved' : '';
      return { turnId: 'turnId' in event ? event.turnId : undefined, liveOnly: itemIdentity?.liveOnly === true,
        line: `${name} ${delivery} ${event.type} ${item} ${JSON.stringify(itemIdentity ?? null)}`.replace(UUID, '<id>') };
    }).filter((entry, at, every) => entry.line !== every[at - 1]?.line);
    const native = lines.filter(({ liveOnly }) => !liveOnly);
    const shape: string[] = [];
    let turn: typeof native = [];
    const flush = () => { shape.push(...(order === 'siblings_unordered' ? turn.map(({ line }) => line).sort() : turn.map(({ line }) => line))); turn = []; };
    for (const entry of native) {
      if (turn.length > 0 && (entry.turnId === undefined || entry.turnId !== turn[0]!.turnId)) flush();
      turn.push(entry);
    }
    flush();
    return [...shape, ...lines.filter(({ liveOnly }) => liveOnly).map(({ line }) => line).sort()];
  };
  return [...side(recording.live, 'live'), ...side(recording.reread, 'reread')];
}

/** The CLI header first, then one observation per line, so a fixture is read and compared as a list of events. */
export const serializeRecording = (recording: JournalRecording): string =>
  `{\n${recording.cli ? ` "cli": ${JSON.stringify({ name: recording.cli.name, version: recording.cli.version })},\n` : ''}${(['live', 'reread'] as const).map(side => ` "${side}": [\n${recording[side].map(observation => `  ${JSON.stringify(observation)}`).join(',\n')}\n ]`).join(',\n')}\n}\n`;
