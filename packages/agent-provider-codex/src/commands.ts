import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentCommand, AgentResourceReadResult } from '@borgee/agent-provider-sdk';
import type { CodexAppServerTransport } from './app-server-transport.js';
import { isRecord, readString } from './native.js';

export type CodexCommand = { descriptor: AgentCommand } & (
  | { type: 'builtin' }
  | { type: 'skill'; name: string; path: string }
  | { type: 'prompt'; body: string }
);
const validName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const maxPromptBytes = 256 * 1024;
const maxDirectoryEntries = 1024;

export async function discoverCodexCommands(transport: CodexAppServerTransport, cwd: string | undefined, codexHome: string): Promise<CodexCommand[]> {
  const commands: CodexCommand[] = [
    { descriptor: { id: 'model', name: 'model', description: 'Choose model and reasoning effort', kind: 'command' }, type: 'builtin' },
    { descriptor: { id: 'permissions', name: 'permissions', description: 'Choose native approval policy or sandbox', kind: 'command' }, type: 'builtin' },
    { descriptor: { id: 'compact', name: 'compact', description: 'Compact the current Codex thread', kind: 'command' }, type: 'builtin' },
  ];
  const result = await transport.request('skills/list', { cwds: cwd ? [cwd] : [], forceReload: true });
  if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('Codex returned an invalid skills directory.');
  if (result.data.length > maxDirectoryEntries) throw new Error('Codex skills directory exceeds the supported limit.');
  const seen = new Set<string>();
  const paths = new Set<string>();
  const names = new Set(commands.map(({ descriptor }) => descriptor.name));
  let skillCount = 0;
  for (const entry of result.data) {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) continue;
    if (cwd && readString(entry.cwd) !== cwd) continue;
    skillCount += entry.skills.length;
    if (skillCount > maxDirectoryEntries) throw new Error('Codex skills directory exceeds the supported limit.');
    for (const skill of entry.skills) {
      if (!isRecord(skill) || skill.enabled !== true) continue;
      const name = readString(skill.name);
      const file = readString(skill.path);
      if (!name || !validName(name) || !file || !path.isAbsolute(file) || file.includes('\0') || seen.has(name) || paths.has(file)) continue;
      seen.add(name);
      paths.add(file);
      let commandName = name.startsWith('prompts:') ? `skills:${name}` : name;
      while (names.has(commandName)) commandName = `skills:${commandName}`;
      names.add(commandName);
      const shortDescription = (isRecord(skill.interface) ? readString(skill.interface.shortDescription) : undefined) ?? readString(skill.shortDescription);
      commands.push({ type: 'skill', name, path: file, descriptor: {
        id: `skill:${encodeURIComponent(file)}`, name: commandName,
        description: readString(skill.description) ?? 'Codex skill', kind: 'skill', inputHint: 'Instructions for this skill',
        ...(shortDescription ? { shortDescription } : {}), documentation: `skill:${encodeURIComponent(file)}`,
      } });
    }
  }
  commands.push(...await discoverPrompts(codexHome));
  return commands;
}

export async function readCodexCommandDocumentation(transport: CodexAppServerTransport, cwd: string | undefined, codexHome: string, locator: string): Promise<AgentResourceReadResult> {
  const command = (await discoverCodexCommands(transport, cwd, codexHome)).find(({ descriptor }) => descriptor.documentation === locator);
  if (command?.type !== 'skill') return { status: 'unavailable', reason: 'Skill is no longer available in this session.' };
  try {
    const file = await open(command.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxPromptBytes) return { status: 'unavailable', reason: 'Skill documentation exceeds the supported file limit.' };
      const buffer = Buffer.alloc(maxPromptBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxPromptBytes) return { status: 'unavailable', reason: 'Skill documentation exceeds the supported file limit.' };
      return { status: 'available', bytes: buffer.subarray(0, bytesRead), mediaType: 'text/plain' };
    } finally { await file.close(); }
  } catch { return { status: 'unavailable', reason: 'Skill documentation cannot be read from the Host.' }; }
}

async function discoverPrompts(codexHome: string): Promise<CodexCommand[]> {
  let directory;
  try { directory = await opendir(path.join(codexHome, 'prompts')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const commands: CodexCommand[] = [];
  let count = 0;
  for await (const entry of directory) {
    if (++count > maxDirectoryEntries) throw new Error('Codex prompts directory exceeds the supported limit.');
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    if (!validName(name)) continue;
    const file = await open(path.join(codexHome, 'prompts', entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxPromptBytes) continue;
      const buffer = Buffer.alloc(maxPromptBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxPromptBytes) continue;
      const { body, metadata } = parsePrompt(buffer.subarray(0, bytesRead).toString('utf8'));
      commands.push({ type: 'prompt', body, descriptor: {
        id: `prompt:${name}`, name: `prompts:${name}`, kind: 'prompt', description: metadata.description ?? 'Custom Codex prompt',
        inputHint: `${metadata['argument-hint'] ?? 'Raw arguments'}; only $ARGUMENTS placeholders are supported`,
      } });
    } finally { await file.close(); }
  }
  return commands.sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
}

function parsePrompt(content: string): { body: string; metadata: Record<string, string> } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) return { body: content, metadata: {} };
  const metadata: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(description|argument-hint):\s*(.*?)\s*$/.exec(line);
    if (field) metadata[field[1]!] = field[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return { body: content.slice(match[0].length), metadata };
}

export function expandCodexPrompt(body: string, args: string): string {
  if (/\$(?!ARGUMENTS\b)(?:[A-Za-z_0-9{]|\$)/.test(body)) {
    throw new Error('Unsupported Codex prompt placeholder. Only $ARGUMENTS is supported; named, positional, escaped and braced placeholders require the native client.');
  }
  if (!body.includes('$ARGUMENTS') && args.trim()) throw new Error('This Codex prompt has no $ARGUMENTS placeholder.');
  return body.replace(/\$ARGUMENTS\b/g, () => args);
}
