/**
 * Every element the conversation showed before I3 and its new place (I3 plan, section 5), as data. The inventory spec has one
 * test per row and fails for a row it has no check for; rows of I3b (the details panel and Window tiles) wait for that part.
 */
export type InventoryLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L1 / L2' | 'L2 / L1';
export interface InventoryRow {
  readonly id: string;
  readonly part: 'I3a' | 'I3b';
  readonly before: string;
  readonly place: string;
  readonly layer: InventoryLayer;
}

export const ASSISTANT_INVENTORY: readonly InventoryRow[] = [
  { id: 'M1', part: 'I3a', before: 'User message text, markdown, content parts', place: 'Mine bubble', layer: 'L1' },
  { id: 'M2', part: 'I3a', before: 'Resource download (label, name, size, sha256), image tag and preview', place: 'In the mine bubble', layer: 'L1' },
  { id: 'M3', part: 'I3a', before: 'Quoted excerpts and session reference note', place: 'In the mine bubble', layer: 'L1' },
  { id: 'M4', part: 'I3a', before: 'Withdrawn note and Copy text', place: 'Under the mine bubble', layer: 'L1' },
  { id: 'M5', part: 'I3a', before: 'Assistant message text', place: 'Their bubble (answer)', layer: 'L1' },
  { id: 'M6', part: 'I3a', before: 'Assistant narration between steps', place: 'narration step', layer: 'L2' },
  { id: 'M7', part: 'I3a', before: 'Kicker "You" / "Assistant" / "Background check"', place: 'The bubble side; "Background check" on its step', layer: 'L1 / L2' },
  { id: 'M8', part: 'I3a', before: 'Entry time (swipe, Alt+T) and the time title', place: 'Unchanged reveal on the bubble; day separator', layer: 'L1' },
  { id: 'M9', part: 'I3a', before: 'Edit from this message, Inspect in Trace, selection', place: 'Bubble actions (unchanged triggers)', layer: 'L1' },
  { id: 'M10', part: 'I3a', before: 'Agent letters (sender → recipient, payload, details drawer)', place: 'Letter card in the turn', layer: 'L1' },
  { id: 'R1', part: 'I3a', before: 'Reasoning trace, full markdown', place: 'reasoning step, opened', layer: 'L2' },
  { id: 'T1', part: 'I3a', before: 'Tool name, one-line summary, state label, session references', place: 'Step header', layer: 'L2' },
  { id: 'T2', part: 'I3a', before: 'Command preview, result preview (exit code, first blocks, "No output"), error preview', place: 'Step at preview (Full mode, or opened)', layer: 'L2' },
  { id: 'T3', part: 'I3a', before: 'Command and cwd; read/edit/write type and path; query; URL; description', place: 'Opened step details', layer: 'L2' },
  { id: 'T4', part: 'I3a', before: 'Result: exit code, duration, stdout/stderr labels, text or JSON, raw result, truncated note, error', place: 'Opened step details', layer: 'L2' },
  { id: 'F1', part: 'I3a', before: 'File change: kind, path, previous path, +N −M, diff lines with line numbers', place: 'Opened step (the details Files list is I3b)', layer: 'L2' },
  { id: 'D1', part: 'I3a', before: 'Todo: tasks, marks, statuses', place: 'todo step; progress in the live line', layer: 'L2 / L1' },
  { id: 'C1', part: 'I3a', before: 'Compaction: state and trigger', place: 'compaction step', layer: 'L2' },
  { id: 'E1', part: 'I3a', before: 'Runtime notice group and messages', place: 'notice step; a failed turn\'s work line says "1 step failed"', layer: 'L2 / L1' },
  { id: 'B1', part: 'I3a', before: 'Background checks group and count', place: 'background step', layer: 'L2' },
  { id: 'I1', part: 'I3a', before: 'Pending tool approval: tool name, summary, command, working directory, context', place: 'Approval card prompt; Show what changes', layer: 'L1 / L2' },
  { id: 'I2', part: 'I3a', before: 'Allow once, Allow for session, Cancel, Deny, rules drawer, Apply rule, Submitting…', place: 'Allow and Not now on the card; the rest under Show what changes', layer: 'L1 / L2' },
  { id: 'I3', part: 'I3a', before: 'Permission request (access, resource, target, scope)', place: 'Approval card; detail under Show what changes', layer: 'L1 / L2' },
  { id: 'I4', part: 'I3a', before: 'Plan review (plan, feedback, Approve, Approve and execute, Request changes)', place: 'Approval card; plan and feedback under Show what changes', layer: 'L1 / L2' },
  { id: 'I5', part: 'I3a', before: 'Question card (tabs, options, custom text, Previous/Next, Submit, Dismiss, drafts)', place: 'Inline tint card, unchanged inputs', layer: 'L1' },
  { id: 'I6', part: 'I3a', before: 'Form and external-action cards', place: 'Inline tint card, unchanged inputs', layer: 'L1' },
  { id: 'I7', part: 'I3a', before: 'Waiting for connection to respond, Interaction unavailable, Invalid interaction request', place: 'The same words in the card', layer: 'L1' },
  { id: 'I8', part: 'I3a', before: 'Answered receipts (question, plan, tool approval, form, permission, external action) with detail', place: 'One-line receipt; detail on open', layer: 'L1 / L2' },
  { id: 'O1', part: 'I3a', before: 'Outgoing message: Sending, Not sent, Check delivery, Retry, Delete, error text', place: 'Mine bubble delivery word and actions', layer: 'L1' },
  { id: 'O2', part: 'I3a', before: 'Composer queue chips', place: 'Unchanged', layer: 'L1' },
  { id: 'S1', part: 'I3a', before: 'Activity label, elapsed time, interrupt', place: 'Status line sentence and detail; interrupt stays in the composer', layer: 'L1' },
  { id: 'S2', part: 'I3a', before: '"{name} is working"', place: 'Status line', layer: 'L1' },
  { id: 'H1', part: 'I3a', before: 'Timeline header: REMOTE SESSION, agent id, status, epoch · seq', place: 'Replica Inspector', layer: 'L3' },
  { id: 'H2', part: 'I3a', before: 'Load earlier activity, loading, error', place: 'Unchanged at the top', layer: 'L1' },
  { id: 'H3', part: 'I3a', before: 'Earlier conversation (Show, loading, unavailable, Retry) and its divider', place: 'Session-change line and the earlier bubbles', layer: 'L1' },
  { id: 'H4', part: 'I3b', before: 'Continued from / by, Return to current, Earlier history (N)', place: 'Details, Sessions', layer: 'L2' },
  { id: 'H5', part: 'I3b', before: 'Subagent sessions list', place: 'Details, Sessions; the step that spawned them links them', layer: 'L2' },
  { id: 'W1', part: 'I3b', before: 'Star, ChatSessionManager, Back/Forward, Session link, Quote messages', place: 'Tile ⋯ menu; details, Sessions', layer: 'L2' },
  { id: 'W2', part: 'I3b', before: 'Attributions: Host, Provider, cwd, Session ID; VS Code link', place: 'Details, Where it works and Sessions', layer: 'L2' },
  { id: 'W3', part: 'I3b', before: 'Bot Info sheet: Group, Host (Offline), Provider, Earlier providers', place: 'Details card and Where it works', layer: 'L2' },
  { id: 'W4', part: 'I3b', before: 'Bot row: role tag, label tag, reply time, preview, unread dot, ⌖, asks', place: 'Sidebar row', layer: 'L0' },
  { id: 'W5', part: 'I3b', before: 'Bot header status word', place: 'Top bar sentence', layer: 'L0' },
  { id: 'W6', part: 'I3b', before: 'Model, permissions, planning, usage', place: 'Details, Model and settings', layer: 'L2' },
  { id: 'W7', part: 'I3b', before: 'Connection phases, sync, timings, raw events', place: 'Trace and Replica Inspector, unchanged', layer: 'L3' },
];
