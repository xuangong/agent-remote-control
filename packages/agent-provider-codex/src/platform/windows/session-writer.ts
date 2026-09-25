import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodexWriterProcess } from '../unix/session-writer.js';

// Restart Manager is used only to inspect file users, never to stop applications.
const inspectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ArcCodexFileUsers {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {
    public int Pid;
    public System.Runtime.InteropServices.ComTypes.FILETIME Started;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public uint Type;
    public uint Status;
    public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint count, string[] files, uint applications, IntPtr apps, uint services, IntPtr serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, ref uint reason);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  public static int[] Users(string[] paths) {
    if (paths.Length == 0) return new int[0];
    uint session;
    int result = RmStartSession(out session, 0, new StringBuilder(33));
    if (result != 0) throw new InvalidOperationException("Cannot inspect native writer.");
    try {
      result = RmRegisterResources(session, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, IntPtr.Zero);
      if (result != 0) throw new InvalidOperationException("Cannot register native locks.");
      uint needed, count = 0, reason = 0;
      result = RmGetList(session, out needed, ref count, null, ref reason);
      if (result == 0) return new int[0];
      if (result != 234 || needed > 1024) throw new InvalidOperationException("Native ownership unavailable.");
      ProcessInfo[] list = new ProcessInfo[needed]; count = needed;
      result = RmGetList(session, out needed, ref count, list, ref reason);
      if (result != 0) throw new InvalidOperationException("Native ownership changed.");
      int[] ids = new int[count];
      for (int i = 0; i < count; i++) ids[i] = list[i].Process.Pid;
      return ids;
    } finally { RmEndSession(session); }
  }
}
'@
$lock = Get-Item -LiteralPath $env:ARC_CODEX_WRITER_LOCK
$owners = @([ArcCodexFileUsers]::Users([string[]]@($lock.FullName)) | Select-Object -Unique)
if ($owners.Count -ne 1) { return }
$ownerId = $owners[0]
if ($ownerId -le 1 -or $ownerId -eq [int]$env:ARC_CODEX_CONTROLLER_PID) { return }
$native = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId"
if (-not $native -or $native.Name -ine 'codex.exe' -or -not $native.CommandLine) { return }
$sid = Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid
if ($sid.ReturnValue -ne 0 -or $sid.Sid -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { return }
if ($native.CommandLine -match '(?:^|\s)(?:daemon(?:\s|$)|--remote(?:=|\s)|--listen(?:=|\s)(?!stdio://(?:\s|$)))') { return }
$otherLocks = @(Get-ChildItem -LiteralPath $lock.DirectoryName -Filter '*.lock' | Where-Object { $_.FullName -ne $lock.FullName })
if ($otherLocks.Count -gt 1024) { return }
$otherUsers = @([ArcCodexFileUsers]::Users([string[]]@($otherLocks | ForEach-Object { $_.FullName })))
if ($otherUsers -contains $ownerId) { return }
$process = Get-Process -Id $ownerId
$identity = @($ownerId, $process.StartTime.ToUniversalTime().Ticks.ToString(), $native.ExecutablePath, $native.CommandLine, $lock.FullName, $lock.CreationTimeUtc.Ticks.ToString()) | ConvertTo-Json -Compress
@{ pid = $ownerId; identity = $identity } | ConvertTo-Json -Compress
`;

export async function inspectWindowsCodexWriter(lockPath: string): Promise<CodexWriterProcess | undefined> {
  const {stdout} = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspectScript, 'utf16le').toString('base64')], {
    timeout: 5000, windowsHide: true, maxBuffer: 128 * 1024,
    env: {...process.env, ARC_CODEX_WRITER_LOCK: lockPath, ARC_CODEX_CONTROLLER_PID: String(process.pid)},
  });
  if (!stdout.trim()) return;
  const value = JSON.parse(stdout);
  if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || typeof value.identity !== 'string') return;
  return {pid: value.pid, identity: value.identity};
}
