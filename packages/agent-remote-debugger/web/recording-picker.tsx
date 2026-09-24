import { useEffect, useRef, useState } from 'react';
import type { SessionRecording } from '../src/recording.js';
import type { RecordingDirectory } from '../src/recording-files.js';

export interface OpenedRecording { name: string; recording: SessionRecording }
export function RecordingPicker({ onOpen }: { onOpen(recording: OpenedRecording): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<RecordingDirectory>();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  async function load(value = '', file = false) {
    request.current?.abort();
    const controller = request.current = new AbortController();
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(file ? `/__ardb/files/open?path=${encodeURIComponent(value)}` : `/__ardb/files?directory=${encodeURIComponent(value)}`,
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Cannot read server files.');
      if (controller.signal.aborted) return;
      if (file) { onOpen(data); dialog.current?.close(); }
      else { setListing(data); setPath(data.directory); }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Cannot read server files.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <>
    <button type="button" className="ardb-open" onClick={() => { dialog.current?.showModal(); void load(listing?.directory); }}>Open recording</button>
    <dialog ref={dialog} className="ardb-file-picker" aria-label="Open server recording" onClose={() => request.current?.abort()} onKeyDown={event => event.stopPropagation()}>
      <header><strong>Server recordings</strong><button type="button" aria-label="Close recording browser" onClick={() => dialog.current?.close()}>Close</button></header>
      <p>Browse files on the machine running ARDB.</p>
      <form onSubmit={event => { event.preventDefault(); void load(path, /\.(jsonl|ndjson)$/i.test(path)); }}>
        <input aria-label="Server path" disabled={busy} value={path} onChange={event => setPath(event.target.value)} placeholder="Directory or recording path" />
        <button type="submit" disabled={busy}>Go</button>
      </form>
      {error ? <p role="alert" className="ardb-file-error">{error}</p> : null}
      <button type="button" disabled={busy || !listing || listing.parent === listing.directory} onClick={() => void load(listing?.parent)}>Parent directory</button>
      <ul aria-label="Server files" aria-busy={busy}>
        {listing?.entries.map(entry => <li key={entry.path}><button type="button" disabled={busy} onClick={() => void load(entry.path, entry.type === 'recording')}><span aria-hidden="true">{entry.type === 'directory' ? '▸' : '▤'}</span>{entry.name}<small>{entry.type === 'directory' ? 'Folder' : 'JSONL'}</small></button></li>)}
      </ul>
      {busy ? <p role="status">Loading…</p> : listing?.entries.length === 0 ? <p>No folders or recordings here.</p> : null}
      {listing?.truncated ? <p>Directory listing is limited. Enter a more specific path.</p> : null}
    </dialog>
  </>;
}
