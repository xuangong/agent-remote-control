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
/** The prose of the sample conversation, in each locale: a Chinese fixture reads Chinese sample data, an English one English. */
const SAMPLE_WORDS = {
  en: {
  allowEdit: 'Allow Edit?',
    editsPolicy: 'Allow edits in notes/ for this session',
    reason: 'Reason',
    addExample: 'Add a short example',
    network: 'Network access for the docs',
    plan: '1. Read the notes\n2. Add one example per principle\n3. Ask before publishing',
    tone: 'Tone',
    toneQuestion: 'Which tone should the examples use?',
    warm: 'Warm',
    plain: 'Plain',
    publishing: 'Publishing details',
    where: 'Where should the notes go?',
    folder: 'Folder',
    signIn: 'Sign in to the docs site',
    signInMessage: 'Finish signing in, then come back.',
    earlierNotes: 'Earlier notes',
    keepShort: 'Keep it short.',
    shortItIs: 'Short it is.',
    prompt: 'Write notes.md with three IM design principles, then explain each.',
    brief: 'Brief',
    sketch: 'Sketch',
    reasoning: 'The notes need three principles; read what exists first.',
    narration: 'Let me check the existing notes first.',
    askResearcher: 'Ask Researcher for examples',
    allowWrite: 'Allow Write?',
    readNotes: 'Read the notes',
    writePrinciples: 'Write the principles',
    explainEach: 'Explain each',
    mcpFailed: 'MCP server docs failed to start.',
    retrying: 'Retrying the docs server.',
    count: 'Count',
    howMany: 'How many principles?',
    three: 'Three',
    five: 'Five',
    writeThenExplain: 'Write, then explain.',
    author: 'Author',
    whoSigns: 'Who signs the notes?',
    me: 'Me',
    writeFolder: 'Write to the notes folder',
    openPreview: 'Open the preview',
    checkPage: 'Check the page.',
    letter: 'Here are two examples you can use.',
    answer: 'Done! I picked three:\n\n- **Content first**: open and read at once.\n- **Send without waiting**: it goes, and I say how it went.\n- **Process on demand**: details when you want them.',
    checked: 'Checked the notes',
    reviewTypos: 'Review the notes for typos.',
    looking: 'Looking for typos.',
    noTypos: 'No typos.',
    rename: 'Also rename the title.',
    expand: 'Expand the second principle with an example, then run the tests.',
    writeExample: 'Write the example',
    runTests: 'Run the tests',
    report: 'Report back',
  },
  zh: {
  allowEdit: '允许编辑吗？',
    editsPolicy: '本次会话允许编辑 notes/',
    reason: '原因',
    addExample: '加一小段例子',
    network: '访问文档网站',
    plan: '1. 读一遍笔记\n2. 每条原则加一个例子\n3. 发布前先问你',
    tone: '语气',
    toneQuestion: '例子用什么语气？',
    warm: '温和',
    plain: '平实',
    publishing: '发布信息',
    where: '笔记放到哪里？',
    folder: '文件夹',
    signIn: '登录文档网站',
    signInMessage: '登录完再回来。',
    earlierNotes: '之前的笔记',
    keepShort: '简短点。',
    shortItIs: '好，简短。',
    prompt: '帮我整理一份 IM 设计原则，写进 notes.md，再讲讲每条。',
    brief: '简报',
    sketch: '草图',
    reasoning: '笔记要三条原则，先看看已有的内容。',
    narration: '我先看看已有的笔记。',
    askResearcher: '请 Researcher 找些例子',
    allowWrite: '允许写入吗？',
    readNotes: '读笔记',
    writePrinciples: '写原则',
    explainEach: '逐条讲解',
    mcpFailed: 'MCP 服务 docs 没能启动。',
    retrying: '正在重试 docs 服务。',
    count: '数量',
    howMany: '要几条原则？',
    three: '三条',
    five: '五条',
    writeThenExplain: '先写，再讲。',
    author: '作者',
    whoSigns: '笔记署谁的名？',
    me: '我',
    writeFolder: '写入 notes 文件夹',
    openPreview: '打开预览',
    checkPage: '看一下这个页面。',
    letter: '这里有两个可以用的例子。',
    answer: '好了！我挑了三条：\n\n- **内容先到**：打开就能看。\n- **发送不等待**：先发出去，状态我会告诉你。\n- **过程可选**：平时只看结果，想看细节再点开。',
    checked: '检查了笔记',
    reviewTypos: '帮我检查一下笔记的错别字。',
    looking: '找错别字中。',
    noTypos: '没有错别字。',
    rename: '顺便把标题也改了。',
    expand: '第二条展开讲讲，加个例子，再跑一下测试。',
    writeExample: '写例子',
    runTests: '跑测试',
    report: '回来汇报',
  },
} as const;
type SampleWords = { readonly [K in keyof typeof SAMPLE_WORDS.en]: string };

export function buildPendingInteractions(locale: 'en' | 'zh' = 'en'): AgentInteractionRequest[] {
  const w: SampleWords = SAMPLE_WORDS[locale];
  return [
    { kind: 'tool_approval', requestId: 'pending-tool', toolCallId: 'call-pending', toolName: 'Edit', summary: w.allowEdit,
      detail: { type: 'edit', filePath: '/Users/me/notes/notes.md' }, allowedDecisions: ['allow', 'deny', 'cancel'], allowScopes: ['once', 'session', 'policy'],
      policies: [{ policyId: 'edits-in-notes', description: w.editsPolicy }], context: [{ label: w.reason, value: w.addExample }] },
    { kind: 'permission_approval', requestId: 'pending-permission', summary: w.network,
      permissions: [{ resource: 'network', access: 'connect', target: 'docs.example.com' }], allowScopes: ['turn', 'session'] },
    { kind: 'plan_approval', requestId: 'pending-plan', plan: w.plan, allowedActions: ['approve', 'approve_and_resume', 'reject'] },
    { kind: 'question', requestId: 'pending-question', questions: [{ questionId: 'q-tone', header: w.tone, prompt: w.toneQuestion, required: true,
      selection: 'single', options: [{ value: 'warm', label: w.warm }, { value: 'plain', label: w.plain }], allowCustomText: true, allowDismiss: true }] },
    { kind: 'form', requestId: 'pending-form', title: w.publishing, message: w.where,
      fields: [{ fieldId: 'folder', label: w.folder, type: 'text', required: true }] },
    { kind: 'external_action', requestId: 'pending-external', title: w.signIn, message: w.signInMessage, url: 'https://docs.example.com/sign-in' },
  ];
}

/**
 * A conversation with one row of every item kind: every tool kind and state, every interaction kind answered (and, through
 * `buildPendingInteractions`, pending), runtime notices, a compaction, a todo, reasoning, narration between steps, a letter,
 * a background check, a withdrawn message, a message with attachments, excerpts and a reference note, and a last turn that
 * is still running a test command with a todo in progress.
 */
export function buildEveryKindConversation(options: { providerId?: string; locale?: 'en' | 'zh' } = {}): { entries: ProjectedTimelineEntry[]; pendingInteractions: AgentInteractionRequest[]; snapshot: AgentSnapshotPayload } {
  const w: SampleWords = SAMPLE_WORDS[options.locale ?? 'en'];
  const rows = new TimelineRows(options.providerId ?? 'claude');
  const t1 = { turnId: 'turn-1' };
  const excerpt = { id: 'quote-1', source: { providerId: 'codex', nativeSessionId: 'earlier', title: w.earlierNotes }, capturedAt: '2026-11-20T09:00:00.000Z',
    segments: [[{ role: 'user' as const, text: w.keepShort }, { role: 'assistant' as const, text: w.shortItIs }]] };
  const prompt = withSessionReferenceNote(appendSessionExcerpts(w.prompt, [excerpt]),
    { revision: 1, references: [{ address: 'local/codex/earlier', title: w.earlierNotes, origin: 'added' }] });
  rows.user(prompt, { ...t1, key: 'prompt-1', content: [
    { type: 'text', text: prompt.split('\n\n')[0]! + ' ' },
    { type: 'resource', locator: 'input-resource:brief', label: w.brief, name: 'brief.pdf', mediaType: 'application/pdf', byteLength: 2048, sha256: sha('a') },
    { type: 'image', locator: 'input-image:sketch', label: w.sketch, sha256: sha('b') },
    { type: 'text', text: prompt.slice(prompt.indexOf('\n\n')) },
  ] });
  rows.reasoning(w.reasoning, { ...t1, key: 'reasoning-1' });
  rows.tool('Bash', { type: 'shell', command: 'ls -la', cwd: '/Users/me/notes' }, 'completed', { ...t1, key: 'tool-shell',
    result: { content: [{ type: 'text', text: 'notes.md\nREADME.md', stream: 'stdout' }], exitCode: 0, durationMs: 12 } });
  rows.tool('Read', { type: 'read', filePath: '/Users/me/notes/README.md' }, 'completed', { ...t1, key: 'tool-read', result: { content: [{ type: 'text', text: '# Notes' }] } });
  rows.tool('Read', { type: 'read', filePath: '/Users/me/notes/style.md' }, 'completed', { ...t1, key: 'tool-read-2', result: { content: [{ type: 'text', text: 'Be brief.' }], truncated: true } });
  rows.assistant(w.narration, { ...t1, key: 'narration-1' });
  rows.tool('Grep', { type: 'search', query: 'principle' }, 'completed', { ...t1, key: 'tool-search', result: { content: [{ type: 'json', value: [] }] } });
  rows.tool('WebFetch', { type: 'fetch', url: 'https://example.com/im-design' }, 'completed', { ...t1, key: 'tool-fetch', result: { content: [{ type: 'text', text: 'IM design notes' }] } });
  rows.tool('Task', { type: 'other', description: w.askResearcher, sessionReference: { nativeSessionId: 'child-1', title: 'Researcher' } }, 'completed', { ...t1, key: 'tool-other' });
  rows.interaction({ kind: 'tool_approval', requestId: 'answered-tool', toolCallId: 'tool-write', toolName: 'Write', summary: w.allowWrite,
    detail: { type: 'write', filePath: '/Users/me/notes/notes.md' }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once', 'session'] },
  { kind: 'tool_approval', decision: 'allow', scope: 'once' }, { ...t1, key: 'receipt-tool' });
  rows.tool('Write', { type: 'write', filePath: '/Users/me/notes/notes.md' }, 'completed', { ...t1, key: 'tool-write',
    result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [{ path: '/Users/me/notes/notes.md', kind: 'added', diff: '@@ -0,0 +1,3 @@\n+# IM principles\n+1. Content first\n+2. Send without waiting' }] } }] } });
  rows.tool('Edit', { type: 'edit', filePath: '/Users/me/notes/README.md' }, 'completed', { ...t1, key: 'tool-edit',
    result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [{ path: '/Users/me/notes/README.md', previousPath: '/Users/me/notes/OLD.md', kind: 'renamed', diff: '@@ -1 +1 @@\n-# Old\n+# Notes' }] } }] } });
  rows.tool('Bash', { type: 'shell', command: 'npm run lint' }, 'failed', { ...t1, key: 'tool-failed', error: 'lint: 2 problems', result: { content: [{ type: 'text', text: 'lint: 2 problems', stream: 'stderr' }], exitCode: 1 } });
  rows.tool('Bash', { type: 'shell', command: 'sleep 100' }, 'canceled', { ...t1, key: 'tool-canceled' });
  rows.todo([{ text: w.readNotes, completed: true, status: 'completed' }, { text: w.writePrinciples, completed: true, status: 'completed' }, { text: w.explainEach, completed: false, status: 'pending' }], { ...t1, key: 'todo-1' });
  rows.compaction('completed', { ...t1, key: 'compaction-1' });
  rows.error(w.mcpFailed, { ...t1, key: 'notice-1' });
  rows.error(w.retrying, { ...t1, key: 'notice-2' });
  rows.interaction({ kind: 'question', requestId: 'answered-question', questions: [{ questionId: 'q-count', header: w.count, prompt: w.howMany, required: true,
    selection: 'single', options: [{ value: 'three', label: w.three }, { value: 'five', label: w.five }], allowCustomText: false, allowDismiss: true }] },
  { kind: 'question', answers: [{ questionId: 'q-count', selectedValues: ['three'] }] }, { ...t1, key: 'receipt-question' });
  rows.interaction({ kind: 'plan_approval', requestId: 'answered-plan', plan: w.writeThenExplain, allowedActions: ['approve', 'reject'] },
    { kind: 'plan_approval', action: 'approve' }, { ...t1, key: 'receipt-plan' });
  rows.interaction({ kind: 'form', requestId: 'answered-form', title: w.author, message: w.whoSigns, fields: [{ fieldId: 'author', label: w.author, type: 'text', required: true }] },
    { kind: 'form', action: 'submit', values: { author: w.me } }, { ...t1, key: 'receipt-form' });
  rows.interaction({ kind: 'permission_approval', requestId: 'answered-permission', summary: w.writeFolder, permissions: [{ resource: 'filesystem', access: 'write', target: '/Users/me/notes' }], allowScopes: ['turn', 'session'] },
    { kind: 'permission_approval', decision: 'allow', scope: 'turn' }, { ...t1, key: 'receipt-permission' });
  rows.interaction({ kind: 'external_action', requestId: 'answered-external', title: w.openPreview, message: w.checkPage, url: 'https://example.com/preview' },
    { kind: 'external_action', action: 'completed' }, { ...t1, key: 'receipt-external' });
  rows.letter(w.letter, { ...t1, key: 'letter-1' });
  rows.assistant(w.answer, { ...t1, key: 'answer-1' });

  const review: BackgroundActivity = { id: 'review-1', kind: 'review', status: 'silent', summary: w.checked };
  rows.user(w.reviewTypos, { key: 'background-user', turnId: 'turn-bg', background: review });
  rows.reasoning(w.looking, { key: 'background-reasoning', turnId: 'turn-bg', background: review });
  rows.assistant(w.noTypos, { key: 'background-answer', turnId: 'turn-bg', background: review });

  rows.user(w.rename, { key: 'withdrawn-1', turnId: 'turn-2', withdrawn: true });

  const t3 = { turnId: 'turn-3' };
  rows.user(w.expand, { ...t3, key: 'prompt-3' });
  rows.todo([{ text: w.writeExample, completed: true, status: 'completed' }, { text: w.runTests, completed: false, status: 'in_progress' }, { text: w.report, completed: false, status: 'pending' }], { ...t3, key: 'todo-3' });
  rows.tool('Bash', { type: 'shell', command: 'npm test' }, 'running', { ...t3, key: 'tool-running' });

  const providerId = options.providerId ?? 'claude';
  const snapshot = buildSnapshot({ id: 'agent-every-kind', providerId, status: 'running', nativeSessionId: 'every-kind',
    runtimeInfo: { providerId, sessionId: 'every-kind', status: 'running', cwd: '/Users/me/notes' },
    activeTurn: { turnId: 'turn-3', startedAt: new Date(Date.parse('2026-11-20T10:57:00.000Z') + 60_000).toISOString() } });
  return { entries: rows.entries, pendingInteractions: buildPendingInteractions(options.locale), snapshot };
}
