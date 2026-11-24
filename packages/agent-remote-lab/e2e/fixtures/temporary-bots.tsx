// A chief's details with its temporary bots (bots design 10): the real AssistantDetails, with the page's own task directory over in-memory
// tasks. Three temporary bots work for the chief: one for each choice the person has (Stop, Mark done, Keep as a bot). What the person
// chooses is recorded on `window.taskActions` and changes the rows the next render lists: a stopped or finished bot moves to Done, a kept
// one joins the chief's staff. On a narrow screen the details are a sheet, as the Workbench shows them on a phone. The words follow the
// browser's language.
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
function temporaryBot(id: string, title: string, task: Partial<TeamTask>): Team {
  const member = { hostId: 'mac', providerId: 'claude', responsibility: '', activity: 'idle' as const, summary: '', updatedAt: now };
  return { id, operationId: id, revision: 1, title, status: 'active', createdAt: now - 600_000, updatedAt: now - 60_000, source: { ...owner, title: 'Chief of staff' }, messages: [],
    members: [{ ...member, id: `${id}-w`, role: 'leader', name: title, creation: 'ready', nativeSessionId: `${id}-session` },
      { ...member, id: `${id}-o`, role: 'requester', name: 'Chief of staff', creation: 'ready', nativeSessionId: owner.nativeSessionId }],
    task: { title, brief: 'Collect it.', state: 'working', createdAt: now - 600_000, updatedAt: now - 60_000, ...task } as TeamTask } as Team;
}
const actions: Array<[string, string]> = (window as unknown as { taskActions: Array<[string, string]> }).taskActions = [];

function Fixture() {
  const [teams, setTeams] = useState<Team[]>([
    temporaryBot('t_logs', 'Log reader', {}),
    temporaryBot('t_tests', 'Test runner', {}),
    temporaryBot('t_notes', 'Release notes writer with a long working title', { state: 'needs_input', waiting: { reason: 'question', text: 'Which branch has the notes?', since: now - 30_000 } }),
  ]);
  const [staff, setStaff] = useState<Array<{ botId: string; name: string }>>([{ botId: 'b_' + '4'.repeat(32), name: 'Release tracker' }]);
  const directory = taskDirectory(teams, () => {}, async (taskId, action) => {
    actions.push([taskId, action]);
    if (action === 'keep_task') {
      const kept = teams.find(team => team.id === taskId)!;
      setTeams(current => current.filter(team => team.id !== taskId));
      setStaff(current => [...current, { botId: taskId, name: kept.task!.title }]);
    } else setTeams(current => current.map(team => team.id !== taskId ? team
      : { ...team, task: { ...team.task!, state: action === 'cancel_task' ? 'cancelled' : 'done', ...(action === 'mark_task_done' ? { result: { status: 'done', summary: 'Taken as done.', reportedAt: Date.now() } } : {}) } as TeamTask }));
  });
  const tasks = directory.owned(owner);
  return <TaskDirectoryContext.Provider value={directory}>
    <AssistantDetails surface={innerWidth < 700 ? 'sheet' : 'panel'} onClose={() => {}}
      assistant={{ id: 'chief', name: 'Chief of staff', role: 'Plans the release', bots: staff, tasks }} />
  </TaskDirectoryContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<LocaleProvider language={bindLanguage(document, localStorage, window)}>
  <main aria-label="Chief details" style={{ padding: 16, maxWidth: 420 }}><Fixture /></main>
</LocaleProvider>);
