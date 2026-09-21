# Choosing a Host execution environment

Controllers report a small environment snapshot when they start. Native installations
and the Docker Controller use the same detector. In the Hosts selector, enter multiple
keywords to narrow the available environments, for example `online linux chromium`,
`mac zsh`, or `vscode`. All keywords must match. Host and provider names also match.
Only detected software matches software keywords; a missing or unknown browser does
not qualify. Selection always uses the Host ID, even when names are identical.
Filtering never silently changes the currently selected Host.

The selected Host shows a compact, horizontally scrollable summary. Detection details
show missing and unknown results, the collection time, and the source of the primary
shell. Offline Hosts retain their last report. Restart the Controller to refresh the
snapshot after installing software. Hosts that do not report this metadata show
`Environment unknown` and remain selectable.

## Local inspection

```sh
agent-remote-controller environment
```

This prints JSON without requiring a Relay, pairing key, provider credentials, or a
running daemon. It probes the invoking process environment; a supervised Controller
uses its resolved service environment when registering, which may have a different
PATH. No browsers, shells, or editors are launched by detection.

The report includes:

- Execution OS, OS/kernel release, CPU architecture, and Linux distribution name.
- WSL and container indicators, independently: a container under WSL can have both.
- Unix account login shell, falling back to `SHELL`; available common shells.
- Windows `ComSpec` as an environment-derived shell hint, plus available CMD,
  Windows PowerShell, and PowerShell 7. This is not a claim to know the user's
  preferred Windows Terminal profile.
- Chrome, Chromium, Firefox, Edge, Brave, and macOS Safari in standard installation
  locations and executable search paths.
- VS Code or VS Code Insiders CLI, including `AGENT_HOST_VSCODE` overrides.

The detector checks a bounded set of standard locations and up to 32 absolute PATH
entries. Each asynchronous probe has a deadline. Inaccessible or timed-out paths are
unknown, not absent. `Not found` means no match in those checked locations; custom
installations and browser bundles inside automation caches may not be discovered.
Container markers are best-effort indicators, not isolation or security guarantees.

Installed software does not imply a running GUI, browser automation, a logged-in
browser profile, a working VS Code tunnel, or permission to use a tool. Provider
capabilities and execution policies are unchanged. Only the Controller's execution
environment is reported: a macOS Docker installation reports Linux inside its
container, not the Mac's desktop applications. Windows/WSL fixture coverage does not
establish native Windows Controller runtime support.

No raw environment variables, credentials, usernames, local executable paths, browser
profiles, or account data are included. A Host's existing owner/shared-access rules
also protect its environment description.

## Wire and rollout

`HostEnvironment` is an optional, bounded field of Host uplink `register` messages.
The Relay validates it, persists the latest report, and returns it in the existing
Host listing. No additional subscription, polling loop, or native-provider protocol
is added. An incoming registration without metadata clears the previous report so
an older or reconfigured Controller cannot inherit stale environment claims.

Deploy the updated Relay before updating Controllers: new Relays accept registrations
without metadata, but older strict-schema Relays reject the new registration field.
The same metadata is advertised during managed-Codex enrollment and normal operation.
