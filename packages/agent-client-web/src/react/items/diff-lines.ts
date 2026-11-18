export interface DiffLine {
  text: string;
  kind: 'added' | 'deleted' | 'context' | 'hunk' | 'meta';
  oldLine?: number;
  newLine?: number;
}

export function diffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let inHunk = false;
  const lines = diff.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number.isSafeInteger(Number(hunk[1])) ? Number(hunk[1]) : undefined;
      newLine = Number.isSafeInteger(Number(hunk[2])) ? Number(hunk[2]) : undefined;
      inHunk = true;
      return { text, kind: 'hunk' };
    }
    if (text.startsWith('diff --git ') || text.startsWith('@@')) {
      inHunk = false; oldLine = undefined; newLine = undefined;
      return { text, kind: 'meta' };
    }
    if (!inHunk && (text.startsWith('--- ') || text.startsWith('+++ '))) return { text, kind: 'meta' };
    if (text.startsWith('+')) {
      const line: DiffLine = { text, kind: 'added', newLine };
      if (newLine !== undefined) newLine += 1;
      return line;
    }
    if (text.startsWith('-')) {
      const line: DiffLine = { text, kind: 'deleted', oldLine };
      if (oldLine !== undefined) oldLine += 1;
      return line;
    }
    if (text.startsWith(' ') && inHunk) {
      const line: DiffLine = { text, kind: 'context', oldLine, newLine };
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
      return line;
    }
    return { text, kind: 'meta' };
  });
}
