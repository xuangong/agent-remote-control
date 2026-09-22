import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

/** The job handle owns descendants even if the native process exits before them. */
export const windowsJobSource = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ControllerJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
    public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title; public uint X,Y,W,H,CX,CY,Fill,Flags;
    public short Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid,Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Limits l, uint s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr p, IntPtr t, bool inherit, uint flags, IntPtr env, string cwd, ref Startup s, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  public static int Run(string app, string args, string cwd, int ownerPid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ProcessInfo info = new ProcessInfo();
    IntPtr owner = IntPtr.Zero;
    try {
      owner = OpenProcess(0x100000, false, ownerPid);
      if (owner == IntPtr.Zero) throw new Win32Exception();
      Limits limits = new Limits(); limits.Basic.Flags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
      Startup startup = new Startup(); startup.Size = Marshal.SizeOf(startup);
      startup.Flags = 0x100; startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      if (!CreateProcess(app, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out info)) throw new Win32Exception();
      if (!AssignProcessToJobObject(job, info.Process)) { TerminateProcess(info.Process, 1); throw new Win32Exception(); }
      if (ResumeThread(info.Thread) == uint.MaxValue) throw new Win32Exception();
      uint ended = WaitForMultipleObjects(2, new IntPtr[] {info.Process, owner}, false, uint.MaxValue);
      if (ended == 1) return 1;
      if (ended != 0) throw new Win32Exception();
      uint code; if (!GetExitCodeProcess(info.Process, out code)) throw new Win32Exception();
      return (int)code;
    } finally {
      CloseHandle(job);
      if (owner != IntPtr.Zero) CloseHandle(owner);
      if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
      if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
    }
  }
}
`;

export function spawnWindowsJob(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  const quote = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  const script = '$ErrorActionPreference = "Stop"; Add-Type -TypeDefinition ' + literal(windowsJobSource)
    + '; exit [ControllerJob]::Run(' + literal(executable) + ',' + literal([executable, ...args].map(quote).join(' ')) + ',' + literal(options.cwd) + ',' + process.pid + ')';
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
