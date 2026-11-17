import { readdirSync, readFileSync } from 'node:fs';

import { parseTranscript, serializeTranscript, type Seam, type Transcript } from './transcript.js';

/** The committed transcripts, one directory per seam: `uplink` for S2 and `session-wire` for S3. */
export const transcriptDirectories: Record<Seam, string> = { S2: 'uplink', S3: 'session-wire' };

const root = new URL('../transcripts/', import.meta.url);
const directoryOf = (seam: Seam): URL => new URL(`${transcriptDirectories[seam]}/`, root);

export const transcriptNames = (seam: Seam): string[] =>
  readdirSync(directoryOf(seam)).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length)).sort();

export const readTranscript = (seam: Seam, name: string): Transcript => parseTranscript(readFileSync(new URL(`${name}.jsonl`, directoryOf(seam)), 'utf8'));

/** The transcript as a file holds it without the line that says when it was recorded, so a replay at another commit compares equal. */
export const withoutStamp = (transcript: Transcript): string => serializeTranscript({ ...transcript, header: { ...transcript.header, recordedAt: '' } });
