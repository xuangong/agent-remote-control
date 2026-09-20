import { useState } from 'react';

export function CopyTunnelUrl({ getUrl, disabled }: {
  readonly getUrl: () => Promise<string>; readonly disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [fallbackUrl, setFallbackUrl] = useState<string>();

  async function copy() {
    setPending(true); setCopied(false); setFailure(undefined); setFallbackUrl(undefined);
    let url: string | undefined;
    let preparation: Promise<string> | undefined;
    try {
      preparation = getUrl().then(value => { url = value; return value; });
      // Safari needs the clipboard write to start within the click's user activation.
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const content = preparation.then(value => new Blob([value], { type: 'text/plain' }));
        void content.catch(() => {});
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })]);
      } else {
        await navigator.clipboard.writeText(await preparation);
      }
      setCopied(true);
    } catch {
      try { if (preparation) url = await preparation; } catch { /* Preparation failed before a URL was issued. */ }
      setFallbackUrl(url);
      setFailure(url ? 'Copy failed. Select and copy the URL below.' : 'Tunnel URL unavailable. Check the Host connection and retry.');
    } finally { setPending(false); }
  }

  return <>
    <button className="agent-preview-copy" type="button" disabled={disabled || pending}
      title="Copy a tunnel link. Sign in to Agent Remote to open it."
      onClick={() => void copy()}>{pending ? 'Copying…' : 'Copy tunnel URL'}</button>
    {copied ? <small role="status">Copied</small> : null}
    {failure ? <p role="alert">{failure}</p> : null}
    {fallbackUrl ? <input className="agent-preview-copy-url" aria-label="Tunnel URL" readOnly value={fallbackUrl}
      onFocus={event => event.currentTarget.select()} /> : null}
  </>;
}
