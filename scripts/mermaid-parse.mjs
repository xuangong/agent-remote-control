#!/usr/bin/env node
// scripts/mermaid-parse.mjs — check every fenced ```mermaid block under the
// given roots, and report the ones that are broken.
//
// WHY THIS EXISTS. A broken diagram survives review exactly the way a false
// sentence would, except no reader ever reports it, because nobody clicks a
// diagram to check. Two ways one gets broken, and the second is the reason this
// file inspects the parse result instead of merely running it:
//
//   1. IT DOES NOT PARSE, and renders as an error box. mermaid 11 lexes an
//      unquoted `@` inside a node label as a link id, so `sdk[@agent-remote-controller/agent-provider-sdk]`
//      — a label that reads perfectly in the source — is a parse error.
//   2. IT PARSES AND IS WRONG. A flowchart edge may name a node that no
//      declaration introduces; mermaid invents one labelled with the raw id and
//      draws it, normally as a stray box outside the subgraph the edge was meant
//      to reach. Exit 0, visibly wrong picture. Both instances found here were
//      the residue of a deletion — a declaration removed or renamed with its
//      edges left behind — which is also why a linter is the right shape for it:
//      the author of the deletion is the one person who will not re-read the
//      diagram. See undeclaredEndpoints below for what counts as a declaration.
//
// NO BROWSER IS INVOLVED. The parser runs the same jison/langium grammar the
// renderer runs, then stops before layout, so it needs a DOM only because
// mermaid's config sanitizer installs DOMPurify hooks at load. jsdom satisfies
// that in about a second for the whole corpus; @mermaid-js/mermaid-cli would
// instead download and drive a chromium to answer a question that never needed
// pixels.
//
// The DOM is NOT optional. Without a window, DOMPurify degrades to a stub whose
// `addHook` is missing, and mermaid then throws `DOMPurify.addHook is not a
// function` for a flowchart that is perfectly valid — a toolchain fault wearing
// a parse error's clothes. Every failure mode here is therefore separated by
// exit code: 1 means a diagram is broken, 2 means we could not answer the
// question and nothing may be concluded.
//
// Usage: node scripts/mermaid-parse.mjs <file-or-directory>...
// Driven by scripts/lint-mermaid.sh, which provisions mermaid + jsdom.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const EXIT_BROKEN = 1;
const EXIT_UNUSABLE = 2;

const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_UNUSABLE);
};

const roots = process.argv.slice(2);
if (roots.length === 0) {
  fail('usage: node scripts/mermaid-parse.mjs <file-or-directory>...');
}

// jsdom must be installed before mermaid is imported: mermaid reads `window`
// during module evaluation, so a globals-first order is load-bearing rather
// than stylistic.
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (cause) {
  fail(`jsdom is not resolvable from ${import.meta.url} — ${cause.message}`);
}

const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const name of ['DOMParser', 'Element', 'HTMLElement', 'Node', 'NodeFilter', 'SVGElement']) {
  globalThis[name] = dom.window[name];
}
// Node exposes `navigator` as a getter-only global, so plain assignment throws
// where every other global accepts one.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

let mermaid;
try {
  mermaid = (await import('mermaid')).default;
} catch (cause) {
  fail(`mermaid is not resolvable from ${import.meta.url} — ${cause.message}`);
}
mermaid.initialize({ startOnLoad: false });

// A fence opens with up to three spaces of indent and three or more backticks
// or tildes, and closes with at least as many of the SAME character. Tracking
// the opening length is what keeps a ````-fenced example that quotes a
// ```mermaid block from being read as a diagram of its own.
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;

// mermaidBlocks <text> — every ```mermaid block in one file, each carrying the
// 1-based line of its opening fence so a report points at the source.
const mermaidBlocks = (text) => {
  const lines = text.split('\n');
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = FENCE.exec(line);
    if (open === null) {
      if (match === null) continue;
      const [, indent, marker, info] = match;
      open = {
        indent: indent.length,
        char: marker[0],
        length: marker.length,
        isMermaid: info.trim().split(/\s+/)[0] === 'mermaid',
        fenceLine: i + 1,
        body: [],
      };
      continue;
    }
    const closes =
      match !== null &&
      match[2][0] === open.char &&
      match[2].length >= open.length &&
      match[3] === '';
    if (closes) {
      if (open.isMermaid) blocks.push({ fenceLine: open.fenceLine, text: open.body.join('\n') });
      open = null;
      continue;
    }
    open.body.push(line.slice(open.indent));
  }
  // An unclosed fence runs to end of file by CommonMark's rule; keeping the
  // block means a doc that forgot its closing fence fails here loudly instead
  // of quietly dropping a diagram nobody then checks.
  if (open !== null && open.isMermaid) {
    blocks.push({ fenceLine: open.fenceLine, text: open.body.join('\n') });
  }
  return blocks;
};

// markdownFiles <root> — every .md file under a directory root, or the root
// itself when it is a file. Sorted so a run's output is stable.
const markdownFiles = (root) => {
  if (statSync(root).isFile()) return [root];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) found.push(path);
    }
  };
  walk(root);
  return found;
};

const files = [];
for (const root of roots) {
  try {
    files.push(...markdownFiles(root));
  } catch (cause) {
    fail(`cannot read '${root}' — ${cause.message}`);
  }
}

// undeclaredEndpoints <diagram> <text> — the flowchart edge endpoints that name
// a node no declaration ever introduced.
//
// mermaid does not refuse these. It invents a node whose label is the raw id and
// draws it, usually as a stray box outside the subgraph the edge was meant to
// reach, so the parse is clean and the picture is wrong. Both instances found in
// this repository were the residue of a deletion: a declaration removed or
// renamed while its edges were left behind.
//
// Three things are declarations, and all three are read from the parse result
// rather than matched in the source, because a pattern-based version of this
// check is blind to whichever form it was not written for:
//   1. a node given any shape, wherever it appears — `rt[Label]` on its own line
//      and `a --> rt[Label]` inline are the same declaration, and both carry a
//      `type`. The `@{ shape: ... }` metadata form carries one too.
//   2. a subgraph id, which is a legitimate edge endpoint but never becomes a
//      typed vertex, so it has to come from getSubGraphs().
//   3. nothing at all — a flowchart written entirely in bare ids (`A --> B`) is
//      ordinary mermaid, and has no declaration for an edge to contradict. Such
//      a diagram is skipped rather than reported as entirely undeclared.
// Styling an id (`style x fill:...`, `class x foo`) is NOT a declaration: it
// leaves the stray node stray.
//
// Flowcharts only. In sequence, class, ER and state diagrams an unintroduced
// participant/class/entity is idiomatic rather than a defect, so there is no
// equivalent notion to check and this returns nothing for them.
const undeclaredEndpoints = (diagram, text) => {
  if (diagram.type !== 'flowchart-v2') return [];
  const db = diagram.db;
  const vertices = db.getVertices();
  const subgraphIds = new Set(db.getSubGraphs().map((group) => group.id));
  if ([...vertices.values()].every((vertex) => vertex.type === undefined)) return [];

  const offenders = new Map();
  for (const edge of db.getEdges()) {
    for (const id of [edge.start, edge.end]) {
      const vertex = vertices.get(id);
      if (vertex === undefined || vertex.type !== undefined || subgraphIds.has(id)) continue;
      if (!offenders.has(id)) offenders.set(id, []);
      offenders.get(id).push(`${edge.start} --> ${edge.end}`);
    }
  }
  // The parse result carries no source positions, so the line is recovered by
  // looking for the id in the block. This only places a pointer on a fact the
  // parser already established; a block where the search finds nothing is still
  // reported, without the pointer.
  const lines = text.split('\n');
  return [...offenders].map(([id, edges]) => {
    const at = lines.findIndex((line) => new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(line));
    return { id, edges, blockLine: at === -1 ? null : at + 1 };
  });
};

let blockCount = 0;
let fileCount = 0;
const failures = [];

for (const file of files) {
  const blocks = mermaidBlocks(readFileSync(file, 'utf8'));
  if (blocks.length === 0) continue;
  fileCount += 1;
  for (const [index, block] of blocks.entries()) {
    blockCount += 1;
    const at = { file, index: index + 1, fenceLine: block.fenceLine };
    let diagram;
    try {
      // getDiagramFromText runs exactly the parse mermaid.parse() runs and
      // throws the identical error, and additionally hands back the populated
      // db that the endpoint check reads.
      diagram = await mermaid.mermaidAPI.getDiagramFromText(block.text);
    } catch (cause) {
      failures.push({ ...at, kind: 'parse', message: String(cause.message) });
      continue;
    }
    for (const offender of undeclaredEndpoints(diagram, block.text)) {
      failures.push({ ...at, kind: 'undeclared', offender });
    }
  }
}

if (failures.length > 0) {
  console.error(`ERROR: ${failures.length} mermaid block(s) are broken:`);
  for (const failure of failures) {
    console.error(`\n  ${failure.file}:${failure.fenceLine} — block #${failure.index}`);
    if (failure.kind === 'parse') {
      // mermaid counts from the first line INSIDE the fence, so the fence's own
      // line number is exactly the offset that turns it into a file line.
      const offset = /parse error on line (\d+)/i.exec(failure.message);
      if (offset !== null) {
        console.error(`  offending line: ${failure.file}:${failure.fenceLine + Number(offset[1])}`);
      }
      console.error(failure.message.replace(/^/gm, '    '));
      continue;
    }
    const { id, edges, blockLine } = failure.offender;
    if (blockLine !== null) {
      console.error(`  offending line: ${failure.file}:${failure.fenceLine + blockLine}`);
    }
    console.error(`    no node "${id}" is declared, but ${edges.length} edge(s) reference it:`);
    for (const edge of edges) console.error(`      ${edge}`);
  }
  console.error('');
  if (failures.some((failure) => failure.kind === 'parse')) {
    console.error('  A block that does not parse renders as an error box. Common cause: mermaid 11');
    console.error('  lexes an unquoted @ or : inside a node label as syntax, so quote the label —');
    console.error('  sdk[@agent-remote-controller/agent-provider-sdk] must be written sdk["@agent-remote-controller/agent-provider-sdk"].');
  }
  if (failures.some((failure) => failure.kind === 'undeclared')) {
    console.error('  An undeclared endpoint still renders: mermaid invents a node labelled with the');
    console.error('  raw id and draws it, usually outside the subgraph the edge was meant to reach.');
    console.error('  Either declare the node or delete the edge — normally the latter, since this is');
    console.error('  what a deleted or renamed declaration leaves behind.');
  }
  process.exit(EXIT_BROKEN);
}

const scope = roots.map((root) => relative(process.cwd(), root) || root).join(', ');
console.log(`OK — ${blockCount} mermaid block(s) in ${fileCount} file(s) check out (${scope})`);
