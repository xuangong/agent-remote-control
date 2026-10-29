import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

const toolResults = (body: any) => new Map<string, { error: boolean; text: string }>((body.messages ?? [])
  .flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part?.type === 'tool_result')
  .map((part: any) => [part.tool_use_id, { error: !!part.is_error, text: typeof part.content === 'string' ? part.content : JSON.stringify(part.content) }]));

it('runs a read-only session whose tools and commands cannot write the workspace and never ask', async () => {
  let cwd = '';
  const fixture = await nativeFixture((body, response) => {
    const steps = [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: join(cwd, 'existing.txt') } },
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: join(cwd, 'existing.txt'), old_string: 'original', new_string: 'changed' } },
      { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: join(cwd, 'written.txt'), content: 'written\n' } },
      { type: 'tool_use', id: 'plan', name: 'EnterPlanMode', input: {} },
      { type: 'tool_use', id: 'shell-write', name: 'Bash', input: { command: 'echo shell > shell.txt', description: 'Write a file' } },
      { type: 'tool_use', id: 'git-write', name: 'Bash', input: { command: 'git commit --allow-empty -qm sneaky && echo committed', description: 'Commit' } },
      { type: 'tool_use', id: 'git-read', name: 'Bash', input: { command: 'git show HEAD:existing.txt', description: 'Read git' } },
      { type: 'tool_use', id: 'shell-read', name: 'Bash', input: { command: 'cat existing.txt', description: 'Read a file' } },
      { type: 'tool_use', id: 'scratch', name: 'Bash', input: { command: 'echo scratch > "$TMPDIR/read-only-scratch.txt" && echo scratch-ok', description: 'Write scratch' } },
    ];
    const done = toolResults(body).size;
    nativeReply(response, done < steps.length ? [steps[done]!] : [{ type: 'text', text: 'READ_ONLY_DONE' }]);
  });
  cwd = fixture.cwd;
  await writeFile(join(cwd, 'existing.txt'), 'original\n');
  execFileSync('git', ['init', '-q'], { cwd }); execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd });
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd, model: 'claude-sonnet-4-5-20250929', access: 'read_only' }, fixture.options);
  const events: AgentStreamEvent[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.sendMessage('Inspect the workspace.');
    await expect.poll(() => events.some(event => ['turn_completed', 'turn_failed', 'turn_canceled'].includes(event.type)), { timeout: 50_000 }).toBe(true);
    expect(events.find(event => event.type === 'turn_failed')).toBeUndefined();
    expect(events.some(event => event.type === 'interaction_requested')).toBe(false);
    expect(await readFile(join(cwd, 'existing.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(cwd, 'written.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'shell.txt'))).toBe(false);
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' }).trim()).toBe('1');
    const results = toolResults(fixture.bodies.at(-1));
    for (const id of ['edit', 'write', 'plan']) expect(results.get(id)).toMatchObject({ error: true });
    expect(results.get('git-write')?.text).not.toContain('committed');
    for (const id of ['read', 'git-read', 'shell-read']) expect(results.get(id)).toMatchObject({ error: false, text: expect.stringContaining('original') });
    expect(results.get('scratch')).toMatchObject({ error: false, text: expect.stringContaining('scratch-ok') });
    expect((await session.runtimeInfo()).planning).toEqual({ active: false });
  } finally { await session.dispose(); await pump.catch(() => {}); await fixture.close(); }
}, 60_000);
