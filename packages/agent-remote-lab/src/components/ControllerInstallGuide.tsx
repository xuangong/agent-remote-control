import { useState } from 'react';

const installers = [
  { name: 'Linux / macOS', command: 'curl -fsSL https://install.xianliao.de5.net | sh' },
  { name: 'Windows (PowerShell)', command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://wininstall.xianliao.de5.net | iex"' },
];

export function ControllerInstallGuide() {
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState<string>();
  async function copy(name: string, command: string) {
    try { await navigator.clipboard.writeText(command); setCopied(name); setFailed(undefined); }
    catch { setCopied(undefined); setFailed(name); }
  }
  return <section className="lab-controller-install-guide" aria-label="Install agent-remote-controller">
    <h3>Install agent-remote-controller</h3>
    <p className="lab-control-note">Generate a pairing key below, then run the command on the computer you want to connect. Enter the key when the installer asks.</p>
    {installers.map(({ name, command }) => <div className="lab-controller-install-command" key={name}>
      <div className="lab-directory-heading"><h4>{name}</h4>
        <button type="button" aria-label={`Copy ${name} install command`} onClick={() => void copy(name, command)}>{copied === name ? 'Copied' : 'Copy'}</button>
      </div>
      <pre tabIndex={0} aria-label={`${name} install command`}><code>{command}</code></pre>
      {failed === name ? <p className="lab-control-note" role="alert">Copy failed. Select and copy the command above.</p> : null}
    </div>)}
    <p className="lab-control-note">On Windows, run this in PowerShell. ExecutionPolicy Bypass applies only to the installer process.</p>
  </section>;
}
