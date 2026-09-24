import type {AgentToolResultJson} from '@orchardworks/agent-provider-sdk';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const coordinate = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Only completed native output is evidence of a file change; tool input is proposed intent. */
export function claudeFileChanges(name: string, value: unknown): AgentToolResultJson | undefined {
 if (!['Edit','MultiEdit','Write'].includes(name) || !object(value) || typeof value.filePath !== 'string' || !value.filePath) return;
 const path = value.filePath;
 const kind = name === 'Write' && value.type === 'create' ? 'added' : 'modified';
 if (!Array.isArray(value.structuredPatch)) return;
 let hunks = '';
 for (const hunk of value.structuredPatch) {
  if (!object(hunk) || !coordinate(hunk.oldStart) || !coordinate(hunk.oldLines) || !coordinate(hunk.newStart) || !coordinate(hunk.newLines)
   || !Array.isArray(hunk.lines) || !hunk.lines.length || !hunk.lines.every(line => typeof line === 'string' && /^[ +\\-]/.test(line) && !/[\r\n]/.test(line))) return;
  const lines = hunk.lines as string[];
  if (lines.filter(line=>line.startsWith(' ') || line.startsWith('-')).length !== hunk.oldLines
   || lines.filter(line=>line.startsWith(' ') || line.startsWith('+')).length !== hunk.newLines) return;
  hunks += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${lines.join('\n')}\n`;
 }
 if (!hunks && kind === 'added' && typeof value.content === 'string' && value.content) {
  const newline = value.content.endsWith('\n');
  const lines = value.content.split('\n'); if (newline) lines.pop();
  hunks = `@@ -0,0 +1,${lines.length} @@\n${lines.map(line=>'+'+line).join('\n')}\n${newline ? '' : '\\ No newline at end of file\n'}`;
 }
 if (!hunks) return;
 const gitPath = path.replace(/^[/\\]/, '').replace(/\\/g, '/');
 const quote = (text: string) => /[\s"\\]/.test(text) ? JSON.stringify(text) : text;
 const diff = `--- ${kind === 'added' ? '/dev/null' : quote('a/'+gitPath)}\n+++ ${quote('b/'+gitPath)}\n${hunks}`;
 return {format:'file_changes',version:1,files:[{path,kind,diff}]};
}
