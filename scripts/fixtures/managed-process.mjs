import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const [mode, log, role] = process.argv.slice(2);
const record = (event) => appendFileSync(log, event + '\n');
setInterval(() => {}, 1000);
if (role === 'child') {
  process.on('SIGTERM', () => { record('child-term'); });
  process.on('message', () => { record('child-clean'); process.exit(0); });
  process.send('ready');
} else {
  const child = spawn(process.execPath, [import.meta.filename, mode, log, 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.once('message', () => console.log(JSON.stringify({ childPid: child.pid })));
  process.on('SIGTERM', () => {
    record('parent-term');
    if (mode === 'graceful') { child.send('close'); child.once('exit', () => process.exit(0)); }
    else if (mode === 'orphan') process.exit(0);
  });
}
