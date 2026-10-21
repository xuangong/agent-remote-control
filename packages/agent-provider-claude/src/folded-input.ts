import { createReadStream } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Input folded into a running turn is stored as a queued_command attachment, which public session
 * reads omit. Restore it as a user message after the conversation entry it followed, so the
 * Timeline after a reload matches what the agent saw.
 */
export async function withFoldedInput(sessionId: string, messages: SessionMessage[], env: NodeJS.ProcessEnv = process.env): Promise<SessionMessage[]> {
  const file = await transcriptFile(sessionId, env);
  if (!file) return messages;
  const entries = new Map<string, { parent: string | null; conversation: boolean }>();
  const folded: Array<{ uuid: string; parentUuid: string | null; content: string }> = [];
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    const { uuid, parentUuid, type, attachment, isSidechain } = entry as Record<string, unknown>;
    if (typeof uuid !== 'string') continue;
    entries.set(uuid, { parent: typeof parentUuid === 'string' ? parentUuid : null, conversation: (type === 'user' || type === 'assistant') && isSidechain !== true });
    if (type !== 'attachment' || isSidechain === true || !attachment || typeof attachment !== 'object') continue;
    const { type: kind, prompt, commandMode } = attachment as Record<string, unknown>;
    if (kind === 'queued_command' && commandMode === 'prompt' && typeof prompt === 'string' && prompt.trim()) {
      folded.push({ uuid, parentUuid: typeof parentUuid === 'string' ? parentUuid : null, content: prompt });
    }
  }
  if (!folded.length) return messages;
  const known = new Set(messages.map(message => message.uuid));
  const after = new Map<string, SessionMessage[]>();
  for (const input of folded) {
    if (known.has(input.uuid)) continue;
    // Walk up through entries that public reads omit to the conversation entry this input followed.
    let anchor = input.parentUuid;
    const visited = new Set<string>();
    while (anchor && !known.has(anchor) && !visited.has(anchor) && !entries.get(anchor)?.conversation) { visited.add(anchor); anchor = entries.get(anchor)?.parent ?? null; }
    // A conversation entry missing from the rows means a bounded read ended earlier; the position is outside it.
    if (!anchor || !known.has(anchor)) continue;
    const list = after.get(anchor) ?? [];
    list.push({ type: 'user', uuid: input.uuid, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null,
      message: { role: 'user', content: input.content } });
    after.set(anchor, list);
  }
  return messages.flatMap(message => [message, ...(after.get(message.uuid) ?? [])]);
}

async function transcriptFile(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return undefined;
  const projects = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'projects');
  let directories: string[];
  try { directories = await readdir(projects); } catch { return undefined; }
  for (const directory of directories) {
    const candidate = join(projects, directory, `${sessionId}.jsonl`);
    try { await access(candidate); return candidate; } catch { /* Not in this project. */ }
  }
  return undefined;
}
