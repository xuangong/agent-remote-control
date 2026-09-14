import { showNewSession } from './session-navigation';
import { expect, test } from '@playwright/test';
import { createAgentHost, createClaudeSessionDirectory } from '@agent-remote-control/agent-remote-controller';
import { ClaudeAgentProvider } from '../../agent-provider-claude/dist/index.js';

test('uses Claude settings, plan review, skills and a read-only native child through the Host', async ({ page, request }, testInfo) => {
  const relayUrl = `http://127.0.0.1:${process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910}`;
  const invitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
  const inputs: string[] = [];
  let spawned = 0;
  let saved = false;
  let savedFollowup = false;
  const models = [{ value: 'fixture-a', displayName: 'Model A', description: 'Fixture model' }, { value: 'fixture-b', displayName: 'Model B', description: 'Fixture model' }];
  const selectedModels: string[] = [], permissionModes: string[] = [];
  let completeChild!: () => void;
  let continueChild!: () => void;
  let completeFollowup!: () => void;
  const childAnswer = { type: 'assistant' as const, uuid: 'child-answer', session_id: 'fixture', parent_tool_use_id: null, parent_agent_id: null,
    message: { id: 'child-answer', content: [{ type: 'text', text: 'CHILD_REVIEW_OK' }] } };
  const followup = { type: 'user' as const, uuid: 'child-followup', session_id: 'fixture', parent_tool_use_id: null, parent_agent_id: null,
    message: { content: 'CHILD_FOLLOWUP_PROMPT' } };
  const secondAnswer = { ...childAnswer, uuid: 'child-second-answer', message: { id: 'child-second-answer', content: [{ type: 'text', text: 'CHILD_FOLLOWUP_OK' }] } };
  const provider = new ClaudeAgentProvider({ catalog: { list: async () => [], info: async () => undefined, messages: async () => [], childMessages: async () => saved ? [
    { type: 'user', uuid: 'child-prompt', session_id: 'fixture', parent_tool_use_id: null, message: { content: 'CHILD_TASK_PROMPT' }, parent_agent_id: null }, childAnswer,
    ...(savedFollowup ? [followup, secondAnswer] : []),
  ] : [] },
    query({ prompt, options }) {
      spawned++;
      let closed = false;
      let wake: (() => void) | undefined;
      const frames: any[] = [];
      const id = options.sessionId!;
      const push = (frame: any) => { frames.push({ ...frame, session_id: id }); wake?.(); };
      completeChild = () => {
        saved = true;
        push({ type: 'system', subtype: 'task_notification', task_id: 'review', status: 'completed' });
      };
      continueChild = () => {
        push({ type: 'system', subtype: 'task_started', task_id: 'review', task_type: 'local_agent', spawn_depth: 1,
          is_backgrounded: true, tool_use_id: 'followup-call', description: 'Review implementation' });
        push({ ...secondAnswer, parent_tool_use_id: 'followup-call' });
      };
      completeFollowup = () => {
        savedFollowup = true;
        push({ type: 'system', subtype: 'task_notification', task_id: 'review', status: 'completed' });
      };
      void (async () => {
        for await (const message of prompt) {
          if (closed) return;
          inputs.push(String(message.message.content));
          if (message.message.content === 'Review the plan') {
            const result = await options.canUseTool!('ExitPlanMode', { plan: '# Native review\nExecute the verified plan.' }, { toolUseID: 'plan-review', signal: new AbortController().signal } as any);
            expect(result?.behavior).toBe('allow');
            push({ type: 'result', uuid: 'plan-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, usage: {}, total_cost_usd: 0 });
            continue;
          }
          push({ type: 'system', subtype: 'task_started', task_id: 'review', task_type: 'local_agent', spawn_depth: 1,
            is_backgrounded: true, tool_use_id: 'review-call', description: 'Review implementation', subagent_type: 'Explore' });
          push({ ...childAnswer, parent_tool_use_id: 'review-call' });
          push({ type: 'assistant', uuid: 'parent-answer', message: { id: 'parent-answer', content: [{ type: 'text', text: 'PARENT_REVIEW_OK' }] } });
          push({ type: 'result', uuid: 'skill-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, usage: {}, total_cost_usd: 0 });
        }
      })();
      return {
        async *[Symbol.asyncIterator]() { while (!closed) { if (frames.length) yield frames.shift(); else await new Promise<void>((resolve) => { wake = resolve; }); } },
        initializationResult: async () => ({ models }), interrupt: async () => {}, setPermissionMode: async (mode: string) => { permissionModes.push(mode); },
        supportedModels: async () => models, setModel: async (model: string) => { selectedModels.push(model); },
        reloadSkills: async () => ({ skills: [] }),
        supportedCommands: async () => [{ name: 'review-fixture', description: 'Review through a native child', argumentHint: '<request>' }],
        close() { closed = true; wake?.(); },
      } as any;
    } });
  const host = createAgentHost({ registrations: [{ adapter: provider, directory: createClaudeSessionDirectory(provider, [{ id: 'work', name: 'Fixture project', path: process.cwd() }]) }],
    installationId: `claude-discovery-${testInfo.project.name}`, name: 'Claude Discovery',
    uplink: { url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key } });
  try {
    await host.ready;
    await page.goto('/');
    await showNewSession(page);
    const context = testInfo.project.name === 'chromium-mobile' ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
    const providerSelect = context.getByTestId('provider-select');
    await expect(providerSelect.getByRole('option', { name: 'Claude Code · Claude Discovery · Online', exact: true })).toHaveCount(1);
    await providerSelect.selectOption({ label: 'Claude Code · Claude Discovery · Online' });
    await showNewSession(page);
    await context.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await page.getByTestId('session-model-button').click();
    await page.getByTestId('session-setting-model').selectOption('fixture-b');
    await expect(page.getByTestId('session-setting-model')).toHaveValue('fixture-b');
    expect(selectedModels).toEqual(['fixture-b']);
    await page.getByTestId('session-permissions-button').click();
    await page.getByTestId('session-setting-permissions').selectOption('acceptEdits');
    await expect(page.getByTestId('session-setting-permissions')).toHaveValue('acceptEdits');
    await page.getByRole('button', { name: 'Status', exact: true }).click();
    await page.getByRole('switch', { name: 'Planning mode' }).click();
    await expect(page.getByRole('switch', { name: 'Planning mode' })).toBeChecked();
    await page.getByRole('button', { name: 'Close session controls' }).click();
    await input.fill('Review the plan');
    await input.press('Enter');
    await expect(page.getByText('Execute the verified plan.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve and execute', exact: true }).click();
    await expect(page.getByText('Approved and resumed', { exact: true })).toBeVisible();
    expect(permissionModes).toEqual(['acceptEdits', 'plan', 'acceptEdits']);
    await input.fill('/review');
    await page.getByRole('option').filter({ hasText: '/review-fixture' }).click();
    await expect(page.getByRole('button', { name: 'View skill review-fixture' })).toBeVisible();
    await input.fill('Check the implementation');
    await input.press('Enter');
    await expect(page.locator('.agent-message-assistant').filter({ hasText: 'PARENT_REVIEW_OK' })).toBeVisible();
    expect(inputs).toEqual(['Review the plan', '/review-fixture Check the implementation']);
    await expect(page.locator('.agent-message-assistant').filter({ hasText: 'CHILD_REVIEW_OK' })).toHaveCount(0);
    await page.getByRole('button').filter({ hasText: 'Review implementation' }).first().click();
    await expect(page.locator('.agent-message-assistant').filter({ hasText: 'CHILD_REVIEW_OK' })).toBeVisible();
    completeChild();
    await expect(page.getByText('CHILD_TASK_PROMPT', { exact: true })).toBeVisible();
    continueChild();
    await expect(page.getByText('CHILD_FOLLOWUP_OK', { exact: true })).toBeVisible();
    completeFollowup();
    await expect(page.getByText('CHILD_FOLLOWUP_PROMPT', { exact: true })).toBeVisible();
    await expect(page.locator('.agent-message-user, .agent-message-assistant')).toHaveText([
      /CHILD_TASK_PROMPT/, /CHILD_REVIEW_OK/, /CHILD_FOLLOWUP_PROMPT/, /CHILD_FOLLOWUP_OK/,
    ]);
    await expect(page.getByTestId('prompt-submit')).toBeDisabled();
    expect(spawned).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('claude-child.png'), fullPage: true });
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByRole('region', { name: 'Chat sessions' }).getByRole('button').filter({ hasText: 'Parent' }).click();
    await expect(page.locator('.agent-message-assistant').filter({ hasText: 'PARENT_REVIEW_OK' })).toBeVisible();
    const nextInvitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
    await host.replaceUplink({ url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: nextInvitation.key });
    await page.getByRole('button').filter({ hasText: 'Review implementation' }).first().click();
    await expect(page.locator('.agent-message-assistant').filter({ hasText: 'CHILD_REVIEW_OK' })).toHaveCount(1);
    await expect(page.getByText('CHILD_TASK_PROMPT', { exact: true })).toHaveCount(1);
    await expect(page.getByText('CHILD_FOLLOWUP_PROMPT', { exact: true })).toHaveCount(1);
    await expect(page.getByText('CHILD_FOLLOWUP_OK', { exact: true })).toHaveCount(1);
    expect(spawned).toBe(1);
  } finally { await host.close(); }
});
