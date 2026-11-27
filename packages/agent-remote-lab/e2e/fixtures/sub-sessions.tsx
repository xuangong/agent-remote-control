// A bot's details with its sub-sessions (bots design 10): the real AssistantDetails, with the page's own directory over in-memory
// sub-sessions. Four sub-sessions work for the bot: one working, one waiting for the person, one idle and one ended. What the person
// chooses (Stop) is recorded on `window.taskActions` and moves the row to Ended. On a narrow screen the details are a sheet, as the
// Workbench shows them on a phone. The words follow the browser's language.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Team, TeamTask } from '@orchardworks/agent-remote-protocol';
import { LocaleProvider, TaskDirectoryContext } from '@orchardworks/agent-client-web/react';
import { bindLanguage } from '@orchardworks/agent-client-web/browser';
import { AssistantDetails } from '../../src/conversation/assistant/AssistantDetails.js';
import { taskDirectory } from '../../src/features/tasks/task-directory.js';
import '../../src/session-view-styles';
import './orchard-primitives.css';

const owner = { hostId: 'mac', providerId: 'claude', nativeSessionId: 'chief' };
const now = Date.now();
function subSession(id: string, title: string, task: Partial<TeamTask>): Team {
  const member = { hostId: 'mac', providerId: 'claude', responsibility: '', activity: 'idle' as const, summary: '', updatedAt: now };
  return { id, operationId: id, revision: 1, title, status: 'active', createdAt: now - 600_000, updatedAt: now - 60_000, source: { ...owner, title: 'Chief of staff' }, messages: [],
    members: [{ ...member, id: `${id}-w`, role: 'leader', name: title, creation: 'ready', nativeSessionId: `${id}-session` },
      { ...member, id: `${id}-o`, role: 'requester', name: 'Chief of staff', creation: 'ready', nativeSessionId: owner.nativeSessionId }],
    task: { title, brief: 'Collect it.', state: 'working', createdAt: now - 600_000, updatedAt: now - 60_000, ...task } as TeamTask } as Team;
}
const actions: Array<[string, string]> = (window as unknown as { taskActions: Array<[string, string]> }).taskActions = [];

function Fixture() {
  const [teams, setTeams] = useState<Team[]>([
    subSession('t_logs', 'Log reader', { currentStep: 'Reading the build logs' }),
    subSession('t_tests', 'Test runner', { state: 'idle', lastWork: { title: 'Run the unit tests', at: now - 3_600_000 }, result: { outcome: 'finished', text: 'All green.', at: now - 3_600_000 } }),
    subSession('t_notes', 'Release notes writer with a long working title', { state: 'needs_input', waiting: { reason: 'interaction', text: 'Run npm run notes?', since: now - 30_000 } }),
    subSession('t_old', 'Changelog check', { state: 'ended', result: { outcome: 'failed', text: 'The runner was offline.', at: now - 7_200_000 } }),
  ]);
  const directory = taskDirectory(teams, () => {}, async (taskId, action) => {
    actions.push([taskId, action]);
    setTeams(current => current.map(team => team.id !== taskId ? team : { ...team, task: { ...team.task!, state: 'ended' } as TeamTask }));
  });
  const tasks = directory.owned(owner);
  return <TaskDirectoryContext.Provider value={directory}>
    <AssistantDetails surface={innerWidth < 700 ? 'sheet' : 'panel'} onClose={() => {}}
      assistant={{ id: 'chief', name: 'Chief of staff', role: 'Plans the release', bots: [{ botId: 'b_' + '4'.repeat(32), name: 'Release tracker' }], tasks }} />
  </TaskDirectoryContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<LocaleProvider language={bindLanguage(document, localStorage, window)}>
  <main aria-label="Chief details" style={{ padding: 16, maxWidth: 420 }}><Fixture /></main>
</LocaleProvider>);
