import { useState } from 'react';

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const powershellQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const repositoryInstallers = 'https://raw.githubusercontent.com/xuangong/agent-remote-control/main';

export function ControllerInstallGuide({ serverUrl }: { serverUrl?: string }) {
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
  return <section className="lab-controller-install-guide" aria-label="Install agent-remote-controller">
    <h3>Install agent-remote-controller</h3>
    <p className="lab-control-note">Generate a pairing key below, then run the command on the computer you want to connect. Enter the key when the installer asks.</p>
    <p className="lab-control-note">{serverUrl ? <>Pairing server: <code>{serverUrl}</code></> : 'Generate a pairing key to see installation commands for its server.'}</p>
    {installers.map(({ name, command }) => <div className="lab-controller-install-command" key={name}>
      <div className="lab-directory-heading"><h4>{name}</h4>
        <button type="button" aria-label={`Copy ${name} install command`} onClick={() => void copy(name, command)}>{copied === name ? 'Copied' : 'Copy'}</button>
      </div>
      <pre tabIndex={0} aria-label={`${name} install command`}><code>{command}</code></pre>
      {failed === name ? <p className="lab-control-note" role="alert">Copy failed. Select and copy the command above.</p> : null}
    </div>)}
    <p className="lab-control-note">On Windows, run this in PowerShell. The installer downloads the published Controller from GitHub Releases.</p>
  </section>;
}
