# Install a published Controller without a source checkout or administrator rights.
[CmdletBinding()]
param(
    [switch]$Clean, [switch]$Yes, [switch]$Foreground, [switch]$NoStart,
    [switch]$InstallCodex, [switch]$KeyStdin, [switch]$NonInteractive, [switch]$Help,
    [string]$Version, [string]$Server, [string]$Name, [string]$Providers = 'codex',
    [string]$KeyFile, [string]$Prefix = $env:AGENT_CONTROLLER_INSTALL_DIR,
    [string]$BinDir = $env:AGENT_CONTROLLER_BIN_DIR, [string]$StateDir = $env:AGENT_HOST_STATE_DIR
)

& {
    $ErrorActionPreference = 'Stop'
    if ($Help) {
        Write-Output @'
Usage: .\install.ps1 [-Version X.Y.Z] [-Yes] [-Clean] [options]
  -Clean                  Reinstall the runtime, retaining identity and configuration
  -Yes                    Approve an existing installation update (with -Clean: reinstall)
  -NonInteractive         Never prompt; existing installs default to cancellation
  -NoStart                Install only, without pairing or starting
  -Foreground             Keep the Controller in the foreground
  -Server URL             Relay origin (default: https://agents.xianliao.de5.net)
  -Name NAME              Host name (default: generated suggestion)
  -Providers LIST         codex, claude, copilot (default: codex)
  -KeyFile PATH           Read a one-time pairing key from a private file
  -KeyStdin               Read the key from stdin (download the script first)
  -Prefix PATH            Install directory (default: LOCALAPPDATA\agent-remote-controller)
  -BinDir PATH            Command directory (default: PREFIX\bin)
  -StateDir PATH          Existing or new Host state directory
  -InstallCodex           Install pinned Codex privately if absent from PATH
Requires Windows PowerShell 5.1+ or PowerShell 7, Node 22+, npm, curl.exe and tar.exe.
No administrator access, global npm installation or execution-policy change is needed.
Existing installations offer Update / Clean install / Cancel. Cancel is the default.
'@
        return
    }
    function Fail([string]$Message) { throw $Message }
    function Invoke-Native([string]$Executable, [string[]]$Arguments) {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) { Fail "Command failed: $([IO.Path]::GetFileName($Executable)) (exit $LASTEXITCODE)." }
    }
    function Prompt([string]$Label, [string]$Default) {
        if ($NonInteractive -or $KeyStdin -or [Console]::IsInputRedirected) { return $Default }
        $answer = Read-Host "$Label [$Default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        return $answer.Trim()
    }
    function Valid-Version([string]$Value) { return $Value -cmatch '\A(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\z' }
    function Full-Path([string]$Value) {
        if ($Value -match '[\r\n]' -or $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { Fail 'Use absolute Windows paths without newlines.' }
        return [IO.Path]::GetFullPath($Value)
    }
    function Fetch([string]$Url, [string]$Destination) {
        Invoke-Native 'curl.exe' @('--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '120', '--retry', '2', '--proto', '=https', '--proto-redir', '=https', $Url, '-o', $Destination)
    }
    function Publish-Directory([string]$Source, [string]$Destination) {
        for ($attempt = 0; ; $attempt++) {
            try { [IO.Directory]::Move($Source, $Destination); return }
            catch {
                if ($attempt -ge 10 -or (Test-Path -LiteralPath $Destination)) { throw }
                Start-Sleep -Milliseconds ([Math]::Min(250 * ($attempt + 1), 1000))
            }
        }
    }
    if ($env:OS -ne 'Windows_NT') { Fail 'This installer supports Windows. Use install.sh on macOS and Linux.' }
    if ($KeyFile -and $KeyStdin) { Fail 'Choose -KeyFile or -KeyStdin.' }
    if ($Version -and !(Valid-Version $Version)) { Fail 'Invalid release version.' }
    if ($Providers -cnotmatch '\A(codex|claude|copilot)(,(codex|claude|copilot))*\z') { Fail 'Unsupported providers.' }
    $stateExplicit = ![string]::IsNullOrEmpty($StateDir)
    $binExplicit = ![string]::IsNullOrEmpty($BinDir)
    if (!$Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA 'agent-remote-controller' }
    if (!$BinDir) { $BinDir = Join-Path $Prefix 'bin' }
    if (!$StateDir) { $StateDir = Join-Path $env:USERPROFILE '.agent-remote-control\agent-host' }
    $Prefix = Full-Path $Prefix; $BinDir = Full-Path $BinDir; $StateDir = Full-Path $StateDir
    $commandPath = Join-Path $BinDir 'agent-remote-controller.cmd'
    $existing = $null
    if (Test-Path -LiteralPath $commandPath) { $existing = $commandPath }
    elseif (!$binExplicit) {
        $found = Get-Command agent-remote-controller.cmd -ErrorAction SilentlyContinue
        if (!$found) { $found = Get-Command agent-remote-controller -ErrorAction SilentlyContinue }
        if ($found) { $existing = $found.Source }
    }
    $savedEnvironment = @{}
    foreach ($variable in @('AGENT_HOST_STATE_DIR', 'AGENT_HOST_SERVER', 'AGENT_HOST_REMOTE_KEY', 'AGENT_HOST_NAME', 'AGENT_HOST_PROVIDERS')) {
        $savedEnvironment[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process')
    }
    $stage = $null; $installStage = $null
    try {
        if ($existing) {
            if ($stateExplicit) { $env:AGENT_HOST_STATE_DIR = $StateDir }
            $checkArgs = @('update', '--check'); if ($Version) { $checkArgs += @('--version', $Version) }
            try { $check = (Invoke-Native $existing $checkArgs | Out-String) | ConvertFrom-Json }
            catch { Fail 'Cannot check this installation. Start its Controller first. Legacy Controllers need a one-time launcher upgrade. Existing files were not changed.' }
            if ($check.available -isnot [bool] -or $check.current -isnot [string] -or (($check.available -or $check.canClean) -and !(Valid-Version $check.version))) { Fail 'Invalid update check.' }
            if ($check.available) { Write-Host "Update available: $($check.current) -> $($check.version)" }
            else { Write-Host 'No compatible newer release.' }
            if ($Clean -and !$check.canClean) { Fail 'Clean install is unavailable for this launcher or release.' }
            if (!$check.available -and !$check.canClean) { return }
            Write-Host 'Updates restart the Controller after verification. Identity, settings and history are preserved. Private tasks may be interrupted; shared Codex daemon tasks continue.'
            Write-Host 'Choose Update to install a newer release, or Clean install to reinstall the runtime.'
            $answer = 'cancel'
            if ($Yes) { if ($Clean) { $answer = 'clean' } elseif ($check.available) { $answer = 'update' } }
            elseif ($Clean) { if ((Prompt 'Confirm clean install? yes/no' 'no') -match '^(y|yes)$') { $answer = 'clean' } }
            else { $answer = Prompt 'Choose Update / Clean install / Cancel' 'cancel' }
            $updateArgs = @('update', '--version', $check.version, '--yes')
            switch -Regex ($answer) {
                '^(u|update)$' { if (!$check.available) { Fail 'There is no newer compatible release. Choose Clean install to reinstall.' }; Invoke-Native $existing $updateArgs; break }
                '^(c|clean|clean install)$' { if (!$check.canClean) { Fail 'This launcher does not support clean install.' }; Invoke-Native $existing ($updateArgs + '--clean'); break }
                default { Write-Host 'Installation not changed.' }
            }
            return
        }
        if ((Test-Path -LiteralPath (Join-Path $StateDir 'connection.json')) -or (Test-Path -LiteralPath (Join-Path $StateDir 'daemon.json'))) { Fail 'This state directory already belongs to a Host. Locate its existing command and use -BinDir; do not create another identity.' }
        foreach ($tool in @('node.exe', 'curl.exe', 'tar.exe')) { if (!(Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "$tool is required. Install Node.js 22 or newer with npm first." } }
        $node = (Get-Command node.exe).Source
        $node = Invoke-Native $node @('-p', 'process.execPath')
        $nodeMajor = [int](Invoke-Native $node @('-p', "process.versions.node.split('.')[0]"))
        $arch = Invoke-Native $node @('-p', 'process.arch')
        if ($nodeMajor -lt 22) { Fail 'Node.js 22 or newer is required.' }
        $npm = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
        if (!(Test-Path -LiteralPath $npm)) { Fail 'npm is unavailable in this Node installation.' }
        $stage = Join-Path ([IO.Path]::GetTempPath()) ('arc-install-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage | Out-Null
        $repo = 'https://github.com/xuangong/agent-remote-control/releases'
        if (!$Version) {
            $location = Invoke-Native 'curl.exe' @('--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '30', '--proto', '=https', '--proto-redir', '=https', '-o', 'NUL', '-w', '%{url_effective}', "$repo/latest")
            $tagPrefix = "$repo/tag/controller-v"
            if (!$location.StartsWith($tagPrefix)) { Fail 'The latest GitHub release is not a stable Controller release.' }
            $Version = $location.Substring($tagPrefix.Length)
            if (!(Valid-Version $Version)) { Fail 'Invalid release tag.' }
        }
        Write-Host "Installing Controller $Version for win32-$arch..."
        Fetch "$repo/download/controller-v$Version/controller-release.json" (Join-Path $stage 'release.json')
        $release = Get-Content -Raw -LiteralPath (Join-Path $stage 'release.json') | ConvertFrom-Json
        $asset = "orchardworks-agent-remote-controller-$Version.tgz"
        if ($release.version -cne $Version -or $release.revision -isnot [string] -or $release.revision -cnotmatch '\A[a-f0-9]{40}\z' -or $release.sha256 -isnot [string] -or $release.sha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $release.asset -cne $asset -or $release.platforms -isnot [Array] -or $release.platforms -notcontains "win32-$arch" -or ($release.nodeMajor -isnot [int] -and $release.nodeMajor -isnot [long]) -or $release.nodeMajor -lt 22 -or $nodeMajor -lt $release.nodeMajor) { Fail 'Release manifest is invalid or does not support this platform or Node version.' }
        $archive = Join-Path $stage $asset
        Fetch "$repo/download/controller-v$Version/$asset" $archive
        $hash = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead($archive)
        try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $hash.Dispose() }
        if ($actual -cne $release.sha256) { Fail 'Controller package checksum mismatch. Nothing was installed.' }
        Push-Location -LiteralPath $stage
        try { $info = (Invoke-Native 'tar.exe' @('-xOf', $asset, 'package/build-info.json') | Out-String) | ConvertFrom-Json }
        finally { Pop-Location }
        if ($info.version -cne $Version -or $info.revision -cne $release.revision -or $info.dirty -isnot [bool] -or $info.dirty) { Fail 'Package identity does not match release.' }
        $key = $null
        if (!$NoStart) {
            if (!$Server) { $Server = Prompt 'Agents / Relay URL' 'https://agents.xianliao.de5.net' }
            $Server = $Server.TrimEnd('/')
            if ($Server -notmatch '\A(https://[^/?#@\s]+|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?)\z') { Fail 'Use an HTTPS Relay origin (HTTP only on loopback).' }
            if (!$Name) { $Name = Prompt 'Host name' ('sunny-seattle-' + [guid]::NewGuid().ToString('N').Substring(0, 6)) }
            if ($Name -cnotmatch '\A[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\z') { Fail 'Use a Host name of up to 80 letters, digits, dots, underscores or hyphens.' }
            Write-Host "Open $Server and sign in, then open Settings > Pair Agent Host (Pairing keys)."
            Write-Host 'Choose Host only, or Gateway token + CLI setup. Click Generate pairing key.'
            Write-Host 'Copy only the arc_... key. Each key enrolls one Host and expires after use.'
            if ($KeyFile) { $key = Get-Content -LiteralPath $KeyFile -TotalCount 1 }
            elseif ($KeyStdin) { $key = [Console]::ReadLine() }
            elseif ($NonInteractive -or [Console]::IsInputRedirected) { Fail 'No terminal available. Use -KeyFile, -KeyStdin or -NoStart.' }
            else {
                $secret = Read-Host 'One-time pairing key (hidden)' -AsSecureString
                $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
                try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
                finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secret.Dispose() }
            }
            if ($key -cnotmatch '\Aarc_[A-Za-z0-9_-]{43}\z') { Fail 'A valid one-time pairing key is required.' }
        }
        New-Item -ItemType Directory -Force -Path $Prefix, $BinDir | Out-Null
        $packageDir = Join-Path $Prefix "packages\$Version-$($release.revision)"
        if (Test-Path -LiteralPath $packageDir) { Fail 'This package is already installed. Use the existing command or website updates.' }
        $installStage = Join-Path $Prefix ('.install-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $installStage | Out-Null
        Invoke-Native $node @($npm, 'install', '--prefix', $installStage, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', $archive)
        $packageRoot = Join-Path $installStage 'node_modules\@orchardworks\agent-remote-controller'
        $installedInfo = Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'build-info.json') | ConvertFrom-Json
        if ($installedInfo.version -cne $Version -or $installedInfo.revision -cne $release.revision -or $installedInfo.dirty -isnot [bool] -or $installedInfo.dirty) { Fail 'Installed package identity does not match release.' }
        Invoke-Native $node @((Join-Path $packageRoot 'dist\launcher.js'), '--version')
        $nativeBin = Join-Path $Prefix 'native\node_modules\.bin'
        if ($InstallCodex -and !(Get-Command codex -ErrorAction SilentlyContinue)) {
            Invoke-Native $node @($npm, 'install', '--prefix', (Join-Path $Prefix 'native'), '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '@openai/codex@0.155.1')
        }
        if (!$NoStart) {
            foreach ($provider in $Providers.Split(',')) {
                if ($provider -eq 'codex' -and (Test-Path -LiteralPath (Join-Path $nativeBin 'codex.cmd'))) { continue }
                if (!(Get-Command $provider -ErrorAction SilentlyContinue)) { Fail "Install $provider first (use -InstallCodex for Codex), or use -NoStart." }
            }
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $packageDir) | Out-Null
        Publish-Directory $installStage $packageDir
        $installStage = $null
        $launcher = Join-Path $packageDir 'node_modules\@orchardworks\agent-remote-controller\dist\launcher.js'
        $wrapperPath = Join-Path $BinDir 'agent-remote-controller.cjs'
        $psPath = Join-Path $BinDir 'agent-remote-controller.ps1'
        if ((Test-Path -LiteralPath $wrapperPath) -or (Test-Path -LiteralPath $psPath) -or (Test-Path -LiteralPath $commandPath)) { Fail 'A command already exists in the selected directory; it was not overwritten.' }
        $settings = @{ launcher = $launcher; state = $StateDir; nativeBin = $nativeBin; nodeBin = (Split-Path $node) } | ConvertTo-Json -Compress
        $wrapper = @"
// Managed by Agent Remote Controller install.ps1. No credentials are stored here.
const settings = $settings;
const { spawn } = require('node:child_process');
const env = { ...process.env, AGENT_HOST_STATE_DIR: process.env.AGENT_HOST_STATE_DIR || settings.state };
env.PATH = settings.nativeBin + ';' + settings.nodeBin + ';' + (env.PATH || '');
const child = spawn(process.execPath, [settings.launcher, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
process.on('SIGINT', () => {});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
"@
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($wrapperPath, $wrapper, $encoding)
        $escapedNode = $node.Replace('%', '%%')
        [IO.File]::WriteAllText($commandPath, "@echo off`r`nsetlocal DisableDelayedExpansion`r`n`"$escapedNode`" `"%~dp0agent-remote-controller.cjs`" %*`r`nexit /b %errorlevel%`r`n", $encoding)
        $psNode = $node.Replace("'", "''"); $psWrapper = $wrapperPath.Replace("'", "''")
        [IO.File]::WriteAllText($psPath, "& '$psNode' '$psWrapper' @args`r`nexit `$LASTEXITCODE`r`n", (New-Object System.Text.UTF8Encoding($true)))
        Write-Host "Installed: $commandPath"
        if ($env:PATH.Split(';') -notcontains $BinDir) { Write-Host "Add this directory to your user PATH: $BinDir" }
        if ($NoStart) { Write-Host 'Installation complete. Pair and start when ready.'; return }
        $env:AGENT_HOST_STATE_DIR = $StateDir; $env:AGENT_HOST_SERVER = $Server
        $env:AGENT_HOST_NAME = $Name; $env:AGENT_HOST_PROVIDERS = $Providers; $env:AGENT_HOST_REMOTE_KEY = $key
        $key = $null
        if ($Foreground) { Write-Host 'Keep this process running to keep the Host online.'; Invoke-Native $node @($wrapperPath, 'foreground'); return }
        Invoke-Native $node @($wrapperPath, 'start')
        Remove-Item Env:AGENT_HOST_REMOTE_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:AGENT_HOST_SERVER -ErrorAction SilentlyContinue
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $status = & $node $wrapperPath status 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0 -and $status.Contains('uplink: registered')) { Write-Host "Host $Name is ready. Open $Server to use it."; return }
            Start-Sleep -Seconds 1
        }
        Fail "Controller was installed but registration is not confirmed. State was preserved; inspect: $commandPath status"
    }
    finally {
        $key = $null
        foreach ($variable in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($variable, $savedEnvironment[$variable], 'Process') }
        # Delete only directories created by this invocation, within their recorded parents.
        foreach ($entry in @(@{ Path = $stage; Parent = [IO.Path]::GetTempPath(); Prefix = 'arc-install-' }, @{ Path = $installStage; Parent = $Prefix; Prefix = '.install-' })) {
            if (!$entry.Path) { continue }
            $resolved = [IO.Path]::GetFullPath($entry.Path)
            $parent = [IO.Path]::GetFullPath($entry.Parent).TrimEnd('\') + '\'
            if (!$resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $resolved -Leaf).StartsWith($entry.Prefix)) { Fail 'Refusing cleanup outside the installer staging directory.' }
            try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { Write-Warning "Could not remove installer staging directory: $resolved" }
        }
    }
}
