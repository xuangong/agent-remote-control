import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { controllerSkills } from './session-skills.js';

it('finds the packaged skills in the Claude Code plugin layout', async () => {
  const skills = await controllerSkills();
  expect(JSON.parse(await readFile(join(skills!, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('agent-remote');
  expect(await readFile(join(skills!, 'skills', 'agent-remote', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: agent-remote\n/);
});
