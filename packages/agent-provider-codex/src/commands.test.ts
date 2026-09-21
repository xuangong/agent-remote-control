import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInteractionRequest, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function harness(restrictedNative = false) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-commands-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'prompts'));
  let skills = [{ name: 'inspect', description: 'Inspect workspace', path: '/work/skills/inspect/SKILL.md', enabled: true }];
  let rejectSetting = false;
  let rejectSkills = false;
  const native: Record<string, unknown> = { model: 'a', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } };
  const server = createScriptedAppServer({
    'thread/start': () => ({ thread: { id: 'commands' }, cwd: '/work', model: native.model, reasoningEffort: native.effort, approvalPolicy: native.approvalPolicy, sandbox: native.sandboxPolicy }),
    'skills/list': () => {
      if (rejectSkills) throw new Error('Native skills unavailable');
      return { data: [{ cwd: '/work', skills }, { cwd: '/other', skills: [{ name: 'foreign', path: '/other/SKILL.md', enabled: true }] }] };
    },
    'model/list': () => ({ data: [
      { model: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' },
      { model: 'b', displayName: 'B', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' },
    ] }),
    'collaborationMode/list': () => ({ data: [{ mode: 'plan', model: 'a' }, { mode: 'default', model: 'a' }] }),
    'configRequirements/read': () => ({ requirements: { allowedApprovalPolicies: ['on-request', 'never'], allowedSandboxModes: ['read-only', 'workspace-write'] } }),
    'thread/settings/update': (params) => {
      if (rejectSetting) throw new Error('Native refused setting');
      Object.assign(native, params);
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'commands', threadSettings: native } })}\n`);
      return {};
    },
    'turn/start': () => ({ turn: { id: 'turn' } }),
    'thread/compact/start': () => ({}),
  });
  const session = await new CodexAppServerProvider({ restrictedNative, spawn: () => server.child, env: { CODEX_HOME: home } }).createSession({ sessionId: 'local', cwd: '/work', planning: true });
  cleanup.push(() => session.dispose());
  const items: ProviderStreamItem[] = [];
  void (async () => { for await (const item of session.observe()) items.push(item); })();
  async function question() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const requests = items.flatMap((item) => item.type === 'observation' && item.event.type === 'interaction_requested' ? [item.event.request] : []);
    const request = requests.at(-1)!;
    expect(request.kind).toBe('question');
    return request as Extract<AgentInteractionRequest, { kind: 'question' }>;
  }
  return { home, session, server, question, rejectSkills: () => { rejectSkills = true; }, setSkills: (next: typeof skills) => { skills = next; }, rejectSetting: (value: boolean) => { rejectSetting = value; } };
}

describe('Codex provider commands', () => {
  it('exposes short descriptions and reads only current skill documentation without starting a turn', async () => {
    const h = await harness();
    const file = path.join(h.home, 'SKILL.md');
    const content = '# Inspect\nCheck the workspace. 中文';
    await writeFile(file, content);
    const metadata = { name: 'inspect', description: 'Full description', path: file, enabled: true,
      shortDescription: 'Legacy summary', interface: { shortDescription: 'Brief summary' } };
    h.setSkills([metadata]);
    const skill = (await h.session.listCommands!()).find(({ kind }) => kind === 'skill')!;
    expect(skill).toMatchObject({ shortDescription: 'Brief summary', description: 'Full description' });
    const result = await h.session.readResource!(skill.documentation!);
    expect(result.status).toBe('available');
    if (result.status === 'available') expect(new TextDecoder().decode(result.bytes)).toBe(content);
    expect(h.server.requests.some(({ method }) => method === 'turn/start')).toBe(false);
    h.setSkills([]);
    expect((await h.session.readResource!(skill.documentation!)).status).toBe('unavailable');
    expect((await h.session.readResource!('skill:%2Fetc%2Fhosts')).status).toBe('unavailable');
    h.setSkills([metadata]);
    await writeFile(file, 'x'.repeat(256 * 1024 + 1));
    expect((await h.session.readResource!(skill.documentation!)).status).toBe('unavailable');
    await rm(file);
    await symlink('/etc/hosts', file);
    expect((await h.session.readResource!(skill.documentation!)).status).toBe('unavailable');
  });

  it('refreshes enabled skills by cwd and safe custom prompts on every discovery', async () => {
    const h = await harness();
    await writeFile(path.join(h.home, 'prompts', 'review.md'), '---\ndescription: Review work\nargument-hint: changes\n---\nReview $ARGUMENTS');
    await writeFile(path.join(h.home, 'prompts', 'oversized.md'), 'x'.repeat(256 * 1024 + 1));
    await symlink('/etc/hosts', path.join(h.home, 'prompts', 'outside.md'));
    h.setSkills([
      { name: 'inspect', description: 'Inspect', path: '/work/inspect/SKILL.md', enabled: true },
      { name: 'inspect', description: 'Duplicate', path: '/work/duplicate/SKILL.md', enabled: true },
      { name: 'disabled', description: 'Disabled', path: '/work/disabled/SKILL.md', enabled: false },
    ]);
    expect(h.session.capabilities.commands).toBe(true);
    const listed = await h.session.listCommands!();
    expect(listed.map(({ name }) => name)).toEqual(['model', 'permissions', 'compact', 'inspect', 'prompts:review']);
    expect(listed.at(-1)).toMatchObject({ description: 'Review work', kind: 'prompt' });
    expect(listed.at(-1)!.inputHint).toContain('only $ARGUMENTS');
    expect(h.server.requests.find(({ method }) => method === 'skills/list')?.params).toEqual({ cwds: ['/work'], forceReload: true });
    h.setSkills([]);
    await rm(path.join(h.home, 'prompts', 'review.md'));
    expect((await h.session.listCommands!()).map(({ name }) => name)).toEqual(['model', 'permissions', 'compact']);
  });

  it('surfaces native discovery failure and rejects execution without submitting a turn', async () => {
    const h = await harness();
    const skill = (await h.session.listCommands!()).find(({ kind }) => kind === 'skill')!;
    h.rejectSkills();
    await expect(h.session.listCommands!()).rejects.toThrow('Native skills unavailable');
    await expect(h.session.executeCommand!(skill.id, 'inspect')).rejects.toThrow('Native skills unavailable');
    expect(h.server.requests.some(({ method }) => method === 'turn/start')).toBe(false);
  });

  it('keeps command identifiers and names unique across skills, built-ins, and prompts', async () => {
    const h = await harness();
    await writeFile(path.join(h.home, 'prompts', 'review.md'), 'Review');
    h.setSkills(['compact', 'skills:compact', 'prompts:review'].map((name) => ({ name, description: name, enabled: true, path: `/work/${name}/SKILL.md` })).concat([{ name: 'alias', description: 'Alias', enabled: true, path: '/work/compact/SKILL.md' }]));
    const commands = await h.session.listCommands!();
    expect(new Set(commands.map(({ name }) => name)).size).toBe(commands.length);
    expect(new Set(commands.map(({ id }) => id)).size).toBe(commands.length);
    expect(commands.filter(({ kind }) => kind === 'skill')).toHaveLength(3);
  });

  it('revalidates stale skills and sends native skill input with untouched arguments', async () => {
    const h = await harness();
    const skill = (await h.session.listCommands!()).find(({ kind }) => kind === 'skill')!;
    h.setSkills([]);
    await expect(h.session.executeCommand!(skill.id, 'check')).rejects.toThrow('unavailable');
    await expect(h.session.executeCommand!('skill:../../secret', '')).rejects.toThrow('unavailable');
    h.setSkills([{ name: 'inspect', description: 'Inspect', path: '/work/skills/inspect/SKILL.md', enabled: true }]);
    await h.session.executeCommand!(skill.id, '  check\n this  ');
    expect(h.server.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({ input: [
      { type: 'skill', name: 'inspect', path: '/work/skills/inspect/SKILL.md' },
      { type: 'text', text: '  check\n this  ', text_elements: [] },
    ], collaborationMode: { mode: 'plan' } });
    await expect(h.session.executeCommand!('compact', '')).rejects.toThrow('idle');
  });

  it('expands argument prompts from fresh bounded files and rejects unsupported placeholders', async () => {
    const h = await harness();
    const file = path.join(h.home, 'prompts', 'review.md');
    await writeFile(file, 'Review $ARGUMENTS');
    const prompt = (await h.session.listCommands!()).find(({ kind }) => kind === 'prompt')!;
    await writeFile(file, 'Review $NAME');
    await expect(h.session.executeCommand!(prompt.id, 'NAME=test')).rejects.toThrow('Unsupported');
    await writeFile(file, 'Current: $ARGUMENTS');
    await h.session.executeCommand!(prompt.id, '  a "b c"\n  ');
    expect(h.server.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({ input: [{ type: 'text', text: 'Current:   a "b c"\n  ', text_elements: [] }] });
  });

  it('opens model then effort choices, retries native rejection, and preserves Planning', async () => {
    const h = await harness();
    await h.session.executeCommand!('model', '');
    const model = await h.question();
    await expect(h.session.executeCommand!('compact', '')).rejects.toThrow('pending');
    await expect(h.session.sendMessage('Hello')).rejects.toThrow('pending');
    const response = { kind: 'question' as const, answers: [{ questionId: model.questions[0]!.questionId, selectedValues: ['b'] }] };
    h.rejectSetting(true);
    await expect(h.session.respondToInteraction(model.requestId, response)).rejects.toThrow('Native refused');
    expect((await h.session.runtimeInfo()).model).toBe('a');
    h.rejectSetting(false);
    await h.session.respondToInteraction(model.requestId, response);
    const effort = await h.question();
    expect(effort.questions[0]!.options.map(({ value }) => value)).toEqual(['low', 'high']);
    await h.session.respondToInteraction(effort.requestId, { kind: 'question', answers: [{ questionId: effort.questions[0]!.questionId, selectedValues: ['low'] }] });
    expect(await h.session.runtimeInfo()).toMatchObject({ model: 'b', planning: { active: true } });
    await h.session.executeCommand!('compact', '');
    expect(h.server.requests.filter(({ method }) => method === 'thread/compact/start')).toHaveLength(1);
    expect(h.server.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(0);
  });

  it('serializes commands and blocks competing setting or message operations during discovery', async () => {
    const h = await harness();
    const executing = h.session.executeCommand!('compact', '');
    await expect(h.session.executeCommand!('model', '')).rejects.toThrow('active');
    await expect(h.session.sendMessage('hello')).rejects.toThrow('active');
    await expect(h.session.setSessionSetting!('model', 'b')).rejects.toThrow('pending');
    await executing;
    await expect(h.session.executeCommand!('compact', 'unexpected')).rejects.toThrow('arguments');
  });

  it('opens native permission controls and enforces available selections', async () => {
    const h = await harness();
    await h.session.executeCommand!('permissions', '');
    const category = await h.question();
    await h.session.respondToInteraction(category.requestId, { kind: 'question', answers: [{ questionId: category.questions[0]!.questionId, selectedValues: ['sandbox'] }] });
    const sandbox = await h.question();
    expect(sandbox.questions[0]!.options.map(({ value }) => value)).toEqual(['readOnly', 'workspaceWrite']);
    await h.session.respondToInteraction(sandbox.requestId, { kind: 'question', answers: [{ questionId: sandbox.questions[0]!.questionId, selectedValues: ['readOnly'] }] });
    expect((await h.session.runtimeInfo()).settings?.find(({ id }) => id === 'sandbox')?.value).toBe('readOnly');
  });
});


it('prevents permission command escalation under the local native policy while preserving model menus', async () => {
  const h = await harness(true);
  expect((await h.session.listCommands!()).some(command => command.id === 'permissions')).toBe(false);
  await expect(h.session.executeCommand!('permissions', '')).rejects.toThrow(/locked/i);
  await expect(h.session.setSessionSetting!('approval', 'on-request')).rejects.toThrow(/locked/i);
  expect(h.server.requests.some(request => request.method === 'thread/settings/update')).toBe(false);
  await h.session.executeCommand!('model', ''); const question = await h.question();
  expect(question.questions[0]!.questionId).toBe('model');
  await h.session.respondToInteraction(question.requestId, {kind:'question', answers:[{questionId:'model', selectedValues:['b']}]});
  expect(h.server.requests.find(request => request.method === 'thread/settings/update')?.params).toMatchObject({model:'b'});
});

it('preserves whitespace-only skill arguments when starting native skill input', async () => {
  const h = await harness();
  const skill = (await h.session.listCommands!()).find(({ kind }) => kind === 'skill')!;
  await h.session.executeCommand!(skill.id, '  ');
  expect(h.server.requests.find(({ method }) => method === 'turn/start')?.params.input).toEqual([
    { type: 'skill', name: 'inspect', path: '/work/skills/inspect/SKILL.md' },
    { type: 'text', text: '  ', text_elements: [] },
  ]);
});
