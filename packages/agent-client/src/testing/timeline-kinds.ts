import { appendSessionExcerpts, withSessionReferenceNote, type AgentInteractionRequest, type AgentInteractionResponse, type AgentSnapshotPayload, type AgentTimelineItem, type AgentToolDetail, type AgentToolResult, type BackgroundActivity, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { buildSnapshot } from './builders.js';

/**
 * Timeline rows of every kind, typed against the protocol: the turn fold's vectors, the timeline's component tests and the
 * assistant-conversation fixture page read them. `TimelineRows` numbers its rows in order (seq and item key `r<seq>`, or the
 * key given), so a conversation reads top to bottom as it is written.
 */
export class TimelineRows {
  readonly entries: ProjectedTimelineEntry[] = [];
  private seq = 0;
  constructor(private readonly providerId = 'claude', private readonly start = Date.parse('2026-11-20T10:57:00.000Z')) {}

  /** Adds one row; `key` defaults to `r<seq>`, `at` to one second after the previous row. */
  add(item: AgentTimelineItem, options: { key?: string; turnId?: string; at?: number } = {}): ProjectedTimelineEntry {
    const seq = ++this.seq;
    const entry: ProjectedTimelineEntry = {
      providerId: this.providerId, itemKey: options.key ?? `r${seq}`, item, ...(options.turnId ? { turnId: options.turnId } : {}),
      timestamp: new Date(options.at ?? this.start + seq * 1_000).toISOString(), seqStart: seq, seqEnd: seq,
      sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
    };
    this.entries.push(entry);
    return entry;
  }
  user(text: string, options: { key?: string; turnId?: string; background?: BackgroundActivity; withdrawn?: boolean; content?: Extract<AgentTimelineItem, { type: 'user_message' }>['content'] } = {}) {
    return this.add({ type: 'user_message', text, messageId: options.key ?? `u${this.seq + 1}`, ...(options.content ? { content: options.content } : {}),
      ...(options.withdrawn ? { withdrawn: { reason: 'stopped' } } : {}), ...(options.background ? { background: options.background } : {}) }, options);
  }
  assistant(text: string, options: { key?: string; turnId?: string; background?: BackgroundActivity } = {}) {
    return this.add({ type: 'assistant_message', text, messageId: options.key ?? `a${this.seq + 1}`, ...(options.background ? { background: options.background } : {}) }, options);
  }
  reasoning(text = 'Weighing the options.', options: { key?: string; turnId?: string; background?: BackgroundActivity } = {}) {
    return this.add({ type: 'reasoning', text, ...(options.background ? { background: options.background } : {}) }, options);
  }
  tool(name: string, detail: AgentToolDetail, status: 'running' | 'completed' | 'failed' | 'canceled' = 'completed',
    options: { key?: string; turnId?: string; result?: AgentToolResult; error?: string; background?: BackgroundActivity } = {}) {
    const callId = options.key ?? `call-${this.seq + 1}`;
    const base = { type: 'tool_call' as const, callId, name, detail, ...(options.result ? { result: options.result } : {}), ...(options.background ? { background: options.background } : {}) };
    const item: AgentTimelineItem = status === 'failed' ? { ...base, status, error: options.error ?? 'The tool failed.' } : { ...base, status, error: null };
    return this.add(item, options);
  }
  todo(items: Extract<AgentTimelineItem, { type: 'todo' }>['items'], options: { key?: string; turnId?: string } = {}) {
    return this.add({ type: 'todo', items }, options);
  }
  error(message: string, options: { key?: string; turnId?: string } = {}) {
    return this.add({ type: 'error', message }, options);
  }
  compaction(status: 'loading' | 'completed' | 'failed', options: { key?: string; turnId?: string } = {}) {
    return this.add({ type: 'compaction', status, trigger: 'auto' }, options);
  }
  interaction(request: AgentInteractionRequest, response: AgentInteractionResponse, options: { key?: string; turnId?: string } = {}) {
    return this.add({ type: 'interaction', request, response }, options);
  }
  letter(text: string, options: { key?: string; turnId?: string; sender?: string; recipient?: string } = {}) {
    return this.add({ type: 'agent_communication', messageId: options.key ?? `l${this.seq + 1}`, sender: options.sender ?? 'Planner', recipient: options.recipient ?? 'Chief', text }, options);
  }
}

const sha = (digit: string) => digit.repeat(64);

/** One pending request of each interaction kind, in the order a person would meet them. */
export function buildPendingInteractions(): AgentInteractionRequest[] {
  return [
    { kind: 'tool_approval', requestId: 'pending-tool', toolCallId: 'call-pending', toolName: 'Edit', summary: 'Allow Edit?',
      detail: { type: 'edit', filePath: '/Users/me/notes/notes.md' }, allowedDecisions: ['allow', 'deny', 'cancel'], allowScopes: ['once', 'session', 'policy'],
      policies: [{ policyId: 'edits-in-notes', description: 'Allow edits in notes/ for this session' }], context: [{ label: 'Reason', value: 'Add a short example' }] },
    { kind: 'permission_approval', requestId: 'pending-permission', summary: 'Network access for the docs',
      permissions: [{ resource: 'network', access: 'connect', target: 'docs.example.com' }], allowScopes: ['turn', 'session'] },
    { kind: 'plan_approval', requestId: 'pending-plan', plan: '1. Read the notes\n2. Add one example per principle\n3. Ask before publishing', allowedActions: ['approve', 'approve_and_resume', 'reject'] },
    { kind: 'question', requestId: 'pending-question', questions: [{ questionId: 'q-tone', header: 'Tone', prompt: 'Which tone should the examples use?', required: true,
      selection: 'single', options: [{ value: 'warm', label: 'Warm' }, { value: 'plain', label: 'Plain' }], allowCustomText: true, allowDismiss: true }] },
    { kind: 'form', requestId: 'pending-form', title: 'Publishing details', message: 'Where should the notes go?',
      fields: [{ fieldId: 'folder', label: 'Folder', type: 'text', required: true }] },
    { kind: 'external_action', requestId: 'pending-external', title: 'Sign in to the docs site', message: 'Finish signing in, then come back.', url: 'https://docs.example.com/sign-in' },
  ];
}

/**
 * A conversation with one row of every item kind: every tool kind and state, every interaction kind answered (and, through
 * `buildPendingInteractions`, pending), runtime notices, a compaction, a todo, reasoning, narration between steps, a letter,
 * a background check, a withdrawn message, a message with attachments, excerpts and a reference note, and a last turn that
 * is still running a test command with a todo in progress.
 */
export function buildEveryKindConversation(options: { providerId?: string } = {}): { entries: ProjectedTimelineEntry[]; pendingInteractions: AgentInteractionRequest[]; snapshot: AgentSnapshotPayload } {
  const rows = new TimelineRows(options.providerId ?? 'claude');
  const t1 = { turnId: 'turn-1' };
  const excerpt = { id: 'quote-1', source: { providerId: 'codex', nativeSessionId: 'earlier', title: 'Earlier notes' }, capturedAt: '2026-11-20T09:00:00.000Z',
    segments: [[{ role: 'user' as const, text: 'Keep it short.' }, { role: 'assistant' as const, text: 'Short it is.' }]] };
  const prompt = withSessionReferenceNote(appendSessionExcerpts('Write notes.md with three IM design principles, then explain each.', [excerpt]),
    { revision: 1, references: [{ address: 'local/codex/earlier', title: 'Earlier notes', origin: 'added' }] });
  rows.user(prompt, { ...t1, key: 'prompt-1', content: [
    { type: 'text', text: prompt.split('\n\n')[0]! + ' ' },
    { type: 'resource', locator: 'input-resource:brief', label: 'Brief', name: 'brief.pdf', mediaType: 'application/pdf', byteLength: 2048, sha256: sha('a') },
    { type: 'image', locator: 'input-image:sketch', label: 'Sketch', sha256: sha('b') },
    { type: 'text', text: prompt.slice(prompt.indexOf('\n\n')) },
  ] });
  rows.reasoning('The notes need three principles; read what exists first.', { ...t1, key: 'reasoning-1' });
  rows.tool('Bash', { type: 'shell', command: 'ls -la', cwd: '/Users/me/notes' }, 'completed', { ...t1, key: 'tool-shell',
    result: { content: [{ type: 'text', text: 'notes.md\nREADME.md', stream: 'stdout' }], exitCode: 0, durationMs: 12 } });
  rows.tool('Read', { type: 'read', filePath: '/Users/me/notes/README.md' }, 'completed', { ...t1, key: 'tool-read', result: { content: [{ type: 'text', text: '# Notes' }] } });
  rows.tool('Read', { type: 'read', filePath: '/Users/me/notes/style.md' }, 'completed', { ...t1, key: 'tool-read-2', result: { content: [{ type: 'text', text: 'Be brief.' }], truncated: true } });
  rows.assistant('Let me check the existing notes first.', { ...t1, key: 'narration-1' });
  rows.tool('Grep', { type: 'search', query: 'principle' }, 'completed', { ...t1, key: 'tool-search', result: { content: [{ type: 'json', value: [] }] } });
  rows.tool('WebFetch', { type: 'fetch', url: 'https://example.com/im-design' }, 'completed', { ...t1, key: 'tool-fetch', result: { content: [{ type: 'text', text: 'IM design notes' }] } });
  rows.tool('Task', { type: 'other', description: 'Ask Researcher for examples', sessionReference: { nativeSessionId: 'child-1', title: 'Researcher' } }, 'completed', { ...t1, key: 'tool-other' });
  rows.interaction({ kind: 'tool_approval', requestId: 'answered-tool', toolCallId: 'tool-write', toolName: 'Write', summary: 'Allow Write?',
    detail: { type: 'write', filePath: '/Users/me/notes/notes.md' }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once', 'session'] },
  { kind: 'tool_approval', decision: 'allow', scope: 'once' }, { ...t1, key: 'receipt-tool' });
  rows.tool('Write', { type: 'write', filePath: '/Users/me/notes/notes.md' }, 'completed', { ...t1, key: 'tool-write',
    result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [{ path: '/Users/me/notes/notes.md', kind: 'added', diff: '@@ -0,0 +1,3 @@\n+# IM principles\n+1. Content first\n+2. Send without waiting' }] } }] } });
  rows.tool('Edit', { type: 'edit', filePath: '/Users/me/notes/README.md' }, 'completed', { ...t1, key: 'tool-edit',
    result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [{ path: '/Users/me/notes/README.md', previousPath: '/Users/me/notes/OLD.md', kind: 'renamed', diff: '@@ -1 +1 @@\n-# Old\n+# Notes' }] } }] } });
  rows.tool('Bash', { type: 'shell', command: 'npm run lint' }, 'failed', { ...t1, key: 'tool-failed', error: 'lint: 2 problems', result: { content: [{ type: 'text', text: 'lint: 2 problems', stream: 'stderr' }], exitCode: 1 } });
  rows.tool('Bash', { type: 'shell', command: 'sleep 100' }, 'canceled', { ...t1, key: 'tool-canceled' });
  rows.todo([{ text: 'Read the notes', completed: true, status: 'completed' }, { text: 'Write the principles', completed: true, status: 'completed' }, { text: 'Explain each', completed: false, status: 'pending' }], { ...t1, key: 'todo-1' });
  rows.compaction('completed', { ...t1, key: 'compaction-1' });
  rows.error('MCP server docs failed to start.', { ...t1, key: 'notice-1' });
  rows.error('Retrying the docs server.', { ...t1, key: 'notice-2' });
  rows.interaction({ kind: 'question', requestId: 'answered-question', questions: [{ questionId: 'q-count', header: 'Count', prompt: 'How many principles?', required: true,
    selection: 'single', options: [{ value: 'three', label: 'Three' }, { value: 'five', label: 'Five' }], allowCustomText: false, allowDismiss: true }] },
  { kind: 'question', answers: [{ questionId: 'q-count', selectedValues: ['three'] }] }, { ...t1, key: 'receipt-question' });
  rows.interaction({ kind: 'plan_approval', requestId: 'answered-plan', plan: 'Write, then explain.', allowedActions: ['approve', 'reject'] },
    { kind: 'plan_approval', action: 'approve' }, { ...t1, key: 'receipt-plan' });
  rows.interaction({ kind: 'form', requestId: 'answered-form', title: 'Author', message: 'Who signs the notes?', fields: [{ fieldId: 'author', label: 'Author', type: 'text', required: true }] },
    { kind: 'form', action: 'submit', values: { author: 'Me' } }, { ...t1, key: 'receipt-form' });
  rows.interaction({ kind: 'permission_approval', requestId: 'answered-permission', summary: 'Write to the notes folder', permissions: [{ resource: 'filesystem', access: 'write', target: '/Users/me/notes' }], allowScopes: ['turn', 'session'] },
    { kind: 'permission_approval', decision: 'allow', scope: 'turn' }, { ...t1, key: 'receipt-permission' });
  rows.interaction({ kind: 'external_action', requestId: 'answered-external', title: 'Open the preview', message: 'Check the page.', url: 'https://example.com/preview' },
    { kind: 'external_action', action: 'completed' }, { ...t1, key: 'receipt-external' });
  rows.letter('Here are two examples you can use.', { ...t1, key: 'letter-1' });
  rows.assistant('Done! I picked three:\n\n- **Content first**: open and read at once.\n- **Send without waiting**: it goes, and I say how it went.\n- **Process on demand**: details when you want them.', { ...t1, key: 'answer-1' });

  const review: BackgroundActivity = { id: 'review-1', kind: 'review', status: 'silent', summary: 'Checked the notes' };
  rows.user('Review the notes for typos.', { key: 'background-user', turnId: 'turn-bg', background: review });
  rows.reasoning('Looking for typos.', { key: 'background-reasoning', turnId: 'turn-bg', background: review });
  rows.assistant('No typos.', { key: 'background-answer', turnId: 'turn-bg', background: review });

  rows.user('Also rename the title.', { key: 'withdrawn-1', turnId: 'turn-2', withdrawn: true });

  const t3 = { turnId: 'turn-3' };
  rows.user('Expand the second principle with an example, then run the tests.', { ...t3, key: 'prompt-3' });
  rows.todo([{ text: 'Write the example', completed: true, status: 'completed' }, { text: 'Run the tests', completed: false, status: 'in_progress' }, { text: 'Report back', completed: false, status: 'pending' }], { ...t3, key: 'todo-3' });
  rows.tool('Bash', { type: 'shell', command: 'npm test' }, 'running', { ...t3, key: 'tool-running' });

  const providerId = options.providerId ?? 'claude';
  const snapshot = buildSnapshot({ id: 'agent-every-kind', providerId, status: 'running', nativeSessionId: 'every-kind',
    runtimeInfo: { providerId, sessionId: 'every-kind', status: 'running', cwd: '/Users/me/notes' },
    activeTurn: { turnId: 'turn-3', startedAt: new Date(Date.parse('2026-11-20T10:57:00.000Z') + 60_000).toISOString() } });
  return { entries: rows.entries, pendingInteractions: buildPendingInteractions(), snapshot };
}
