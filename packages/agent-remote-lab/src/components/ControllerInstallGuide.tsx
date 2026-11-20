import { useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const powershellQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const repositoryInstallers = 'https://raw.githubusercontent.com/xuangong/agent-remote-control/main';

export function ControllerInstallGuide({ serverUrl }: { serverUrl?: string }) {
  const t = useTranslate();
  const hosted = Boolean(document.querySelector('meta[name="agent-remote-auth"]'));
  const installerBase = hosted && serverUrl ? new URL(serverUrl).origin : repositoryInstallers;
  const installers = serverUrl ? [
    { name: 'Linux / macOS', command: `curl -fsSL ${shellQuote(installerBase + '/install.sh')} | sh -s -- --server ${shellQuote(serverUrl)}` },
    { name: 'Windows (PowerShell)', command: `& ([scriptblock]::Create((Invoke-RestMethod ${powershellQuote(installerBase + '/install.ps1')}))) -Server ${powershellQuote(serverUrl)}` },
  ] : [];
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState<string>();
  async function copy(name: string, command: string) {
    try { await navigator.clipboard.writeText(command); setCopied(name); setFailed(undefined); }
    catch { setCopied(undefined); setFailed(name); }
  }
  return <section className="lab-controller-install-guide" aria-label={t('hosts.install.label')}>
    <h3>{t('hosts.install.label')}</h3>
    <p className="lab-control-note">{t('hosts.install.intro')}</p>
    <p className="lab-control-note">{serverUrl ? <>{t('hosts.install.server')}<code>{serverUrl}</code></> : t('hosts.install.serverMissing')}</p>
    {installers.map(({ name, command }) => <div className="lab-controller-install-command" key={name}>
      <div className="lab-directory-heading"><h4>{name}</h4>
        <button type="button" aria-label={t('hosts.install.copyCommand', { name })} onClick={() => void copy(name, command)}>{copied === name ? t('common.copied') : t('common.copy')}</button>
      </div>
      <pre tabIndex={0} aria-label={t('hosts.install.command', { name })}><code>{command}</code></pre>
      {failed === name ? <p className="lab-control-note" role="alert">{t('hosts.install.copyFailed')}</p> : null}
    </div>)}
    <p className="lab-control-note">{t('hosts.install.windows')}</p>
  </section>;
}
