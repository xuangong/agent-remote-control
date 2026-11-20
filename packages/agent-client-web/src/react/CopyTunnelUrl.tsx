import { useState } from 'react';
import { useTranslate } from './locale.js';

export function CopyTunnelUrl({ getUrl, disabled }: {
  readonly getUrl: () => Promise<string>; readonly disabled?: boolean;
}) {
  const t = useTranslate();
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
      setFailure(t(url ? 'timeline.tunnel.copyFailed' : 'timeline.tunnel.unavailable'));
    } finally { setPending(false); }
  }

  return <>
    <button className="agent-preview-copy" type="button" disabled={disabled || pending}
      title={t('timeline.tunnel.hint')}
      onClick={() => void copy()}>{t(pending ? 'timeline.tunnel.copying' : 'timeline.tunnel.copy')}</button>
    {copied ? <small role="status">{t('common.copied')}</small> : null}
    {failure ? <p role="alert">{failure}</p> : null}
    {fallbackUrl ? <input className="agent-preview-copy-url" aria-label={t('timeline.tunnel.url')} readOnly value={fallbackUrl}
      onFocus={event => event.currentTarget.select()} /> : null}
  </>;
}
