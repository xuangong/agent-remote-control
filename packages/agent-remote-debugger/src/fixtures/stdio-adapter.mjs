import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Test-only adapter: the fixture runtime communicates exclusively over stdin/stdout. */
export function createAdapter() {
  let session;
  return {
    descriptor: { providerId: 'stdio-fixture', displayName: 'STDIO fixture' },
    async createSession(config) {
      if (session) throw new Error('Unexpected second native creation');
      const child = spawn(process.execPath, [fileURLToPath(new URL('./stdio-agent.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
      const pending = new Map();
      const queue = [];
      let wake;
      let ended = false;
      let sequence = 0;
      const closed = new Promise(resolve => child.once('exit', resolve));
      const fail = error => { ended = true; wake?.(); for (const item of pending.values()) item.reject(error); pending.clear(); };
      child.once('error', fail);
      child.once('exit', () => fail(new Error('Fixture runtime exited')));
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        const message = JSON.parse(line);
        if (message.type === 'event') { queue.push(message.value); wake?.(); }
        else { const item = pending.get(message.id); pending.delete(message.id); if (message.error) item?.reject(new Error(message.error)); else item?.resolve(message.value); }
      });
      const call = (method, ...args) => new Promise((resolve, reject) => {
        if (ended) { reject(new Error('Fixture ended')); return; }
        const id = ++sequence; pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
      });
      session = {
        capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: false, sessionSettings: true, interactions: { question: false, planApproval: false, toolApproval: true } },
        async *observe() { while (!ended || queue.length) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; }); } },
        sendMessage: text => call('sendMessage', text),
        cancel: () => call('cancel'),
        setSessionSetting: (id, value) => call('setSessionSetting', id, value),
        respondToInteraction: (id, response) => call('respondToInteraction', id, response),
        runtimeInfo: () => call('runtimeInfo'),
        async dispose() { child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 1500); try { await closed; } finally { clearTimeout(timer); } },
      };
      await call('start', config);
      return session;
    },
    async resumeSession() { throw new Error('Fixture resume not supported'); },
  };
}
