// `pnpm smoke [scenario ...] [--seed N] [--rounds N] [--page-rounds N]` and `pnpm smoke:quick`: run the smoke scenarios of
// packages/agent-e2e/smoke against this checkout's local instance. They run real CLIs and a real browser, so they are never part
// of `pnpm test`. The scenarios carry per-scenario deadlines; this wrapper adds the outer process deadline.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
// A full run takes about two hours, half an hour of it M8's soak; each scenario has its own deadline inside.
const outerDeadlineMs = (args.includes('--quick') ? 20 : 240) * 60_000;
const tsx = join(root, 'packages/agent-e2e/node_modules/tsx/dist/cli.mjs');
const child = spawn(process.execPath, [tsx, join(root, 'packages/agent-e2e/smoke/cli.ts'), ...args], { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32' });
const stop = signal => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
const deadline = setTimeout(() => { process.stderr.write(`The smoke run exceeded its ${outerDeadlineMs / 60_000} minute deadline.\n`); stop('SIGKILL'); }, outerDeadlineMs);
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('error', error => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(deadline); process.exitCode = code ?? 1; });
