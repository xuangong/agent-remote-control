import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface CodexWriterProcess { pid: number; identity: string }
async function command(file: string, args: string[]): Promise<string> {
  return (await execute(file, args, {timeout: 2500, maxBuffer: 2 * 1024 * 1024, env: {...process.env, LC_ALL: 'C'}})).stdout;
}

/** A native writer conflict alone is insufficient authority to terminate a process. */
export async function inspectUnixCodexWriter(lockPath: string): Promise<CodexWriterProcess | undefined> {
  const path = await realpath(lockPath);
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  const holders = await command(lsof, ['-nP', '-Fp', '--', path]);
  const pids = [...new Set(holders.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  if (pids.length !== 1 || pids[0]! <= 1 || pids[0] === process.pid) return;
  const pid = pids[0]!;
  const [details, executable, args, files, info] = await Promise.all([
    command('ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=']),
    command('ps', ['-ww', '-p', String(pid), '-o', 'comm=']),
    command('ps', ['-ww', '-p', String(pid), '-o', 'args=']),
    command(lsof, ['-nP', '-a', '-p', String(pid), '-Fftn']),
    stat(path),
  ]);
  if (Number(details.trim().split(/\s+/)[0]) !== process.getuid?.()) return;
  if (basename(executable.trim()) !== 'codex') return;
  // Never terminate a daemon, remote client, or a process owning other sessions.
  if (/(?:^|\s)(?:daemon(?:\s|$)|--remote(?:=|\s)|--listen(?:=|\s)(?!stdio:\/\/(?:\s|$)))/.test(args)) return;
  const locks = [...new Set(files.split('\n').filter(line => /^n.*\/thread-writer-locks\/[a-f\d-]{36}\.lock$/i.test(line)).map(line => line.slice(1)))];
  if (locks.length !== 1 || locks[0] !== path || files.includes('(LISTEN)')) return;
  return {pid, identity: JSON.stringify([pid, details.trim(), executable.trim(), args.trim(), info.dev, info.ino, info.birthtimeMs])};
}
