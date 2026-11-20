import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useTranslate } from './locale.js';
export type DownloadResource = (resourceId: string) => Promise<{ blob: Blob; name: string; sha256: string }>;
export const ResourceDownloadContext = createContext<DownloadResource | undefined>(undefined);
export function ResourceDownload({ resourceId, label, name, byteLength, sha256 }: { resourceId: string; label: string; name: string; byteLength: number; sha256: string }) {
  const t = useTranslate();
  const download = useContext(ResourceDownloadContext);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const owner = useRef({ resourceId, download });
  useEffect(() => { owner.current = { resourceId, download }; return () => { owner.current = { resourceId: '', download: undefined }; }; }, [resourceId, download]);
  async function save() {
    if (!download || busy) return; const selected = owner.current;
    setBusy(true); setError(undefined);
    try {
      const result = await download(resourceId);
      if (selected !== owner.current) return;
      if (result.blob.size !== byteLength || result.sha256 !== sha256) throw new Error(t('timeline.resource.integrity'));
      const url = URL.createObjectURL(result.blob); const link = document.createElement('a');
      link.href = url; link.download = name; link.hidden = true; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { if (selected === owner.current) setError(reason instanceof Error ? reason.message : t('timeline.resource.downloadFailed')); }
    finally { if (selected === owner.current) setBusy(false); }
  }
  return <span className="agent-resource-download">
    <button className="agent-image-tag" type="button" disabled={!download || busy} aria-label={t('timeline.resource.download', { label, name })} onClick={() => void save()}>[{label}] {busy ? t('timeline.resource.downloading') : name}</button>
    <small> {t('timeline.resource.bytes', { count: byteLength.toLocaleString() })}</small>
    {error ? <span role="alert">{error} <button type="button" onClick={() => void save()}>{t('timeline.resource.retry')}</button></span> : null}
  </span>;
}
