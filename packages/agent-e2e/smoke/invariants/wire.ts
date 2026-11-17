import type { Frame, Marker, Transcript, WireMessage } from './types.js';

export const isFrame = (entry: Transcript[number]): entry is Frame => 'message' in entry;
export const isMarker = (entry: Transcript[number]): entry is Marker => 'marker' in entry;

export const frames = (transcript: Transcript): Frame[] => transcript.filter(isFrame);
export const markers = (transcript: Transcript, name?: Marker['marker']): Marker[] =>
  transcript.filter(isMarker).filter(entry => name === undefined || entry.marker === name);

export const received = (transcript: Transcript, type?: string): Frame[] =>
  frames(transcript).filter(frame => frame.direction === 'relay->browser' && (type === undefined || frame.message.type === type));
export const sent = (transcript: Transcript, type?: string): Frame[] =>
  frames(transcript).filter(frame => frame.direction === 'browser->relay' && (type === undefined || frame.message.type === type));

export const payloadOf = (message: WireMessage): Record<string, any> => message.payload ?? {};
export const agentOf = (message: WireMessage): string => String(payloadOf(message).agentId ?? '');

/** Splits the transcript at the given marker times; returns the frames of each interval, the first one before the first marker. */
export function intervalsBetween(transcript: Transcript, boundaries: Marker[]): Frame[][] {
  const edges = boundaries.map(marker => marker.n).sort((a, b) => a - b);
  const result: Frame[][] = Array.from({ length: edges.length + 1 }, () => []);
  for (const frame of frames(transcript)) {
    let at = 0;
    while (at < edges.length && frame.n > edges[at]!) at += 1;
    result[at]!.push(frame);
  }
  return result;
}
