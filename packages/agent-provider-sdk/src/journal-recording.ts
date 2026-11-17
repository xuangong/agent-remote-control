import type { ProviderObservation, ProviderStreamItem } from './index.js';

/**
 * What a real native runtime did for one scenario: the observations of the live run, and the history observations of the same native
 * session opened again. An adapter's recorder writes them; the Controller's continuity tests read them.
 */
export interface JournalRecording { live: ProviderObservation[]; reread: ProviderObservation[] }

/** The observations a journal is built from; usage and runtime snapshots are not recorded. */
export const journalObservation = (item: ProviderStreamItem): item is ProviderObservation => item.type === 'observation'
  && ['timeline', 'interaction_requested', 'interaction_resolved', 'interaction_invalidated', 'turn_started', 'turn_completed', 'turn_failed', 'turn_canceled'].includes(item.event.type);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * What a recording says about identities and delivery, with ids masked and repeated snapshots of one item counted once. A line for
 * which `late` is true moves to the end, for items whose place among their neighbours varies from run to run.
 */
export function recordingShape(recording: JournalRecording, late: (line: string) => boolean = () => false): string[] {
  const lines = (observations: ProviderObservation[], side: string) => observations.map(({ delivery, event, itemIdentity }) => {
    const item = event.type === 'timeline' ? event.item.type : event.type === 'interaction_resolved' ? 'resolved' : '';
    return `${side} ${delivery} ${event.type} ${item} ${JSON.stringify(itemIdentity ?? null)}`.replace(UUID, '<id>');
  });
  const all = [...lines(recording.live, 'live'), ...lines(recording.reread, 'reread')].filter((line, at, every) => line !== every[at - 1]);
  return [...all.filter(line => !late(line)), ...all.filter(late)];
}

/** One observation per line, so a fixture is read and compared as a list of events. */
export const serializeRecording = (recording: JournalRecording): string =>
  `{\n${(['live', 'reread'] as const).map(side => ` "${side}": [\n${recording[side].map(observation => `  ${JSON.stringify(observation)}`).join(',\n')}\n ]`).join(',\n')}\n}\n`;
