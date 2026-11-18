import { useEffect, useRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

/**
 * CodeMirror's default highlight style with its colors folded into the `--agent-syntax-*` variables, so a host can
 * give each appearance its own palette. A tag without a rule takes its parent's, and the most specific rule wins:
 * `string` keeps its own color although it is a kind of `literal`, while numbers take the literal color.
 */
export const readOnlyHighlight = HighlightStyle.define([
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.heading, textDecoration: 'underline', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.keyword, color: 'var(--agent-syntax-keyword)' },
  { tag: [tags.literal, tags.inserted, tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: 'var(--agent-syntax-literal)' },
  { tag: [tags.string, tags.deleted, tags.regexp, tags.escape, tags.special(tags.string)], color: 'var(--agent-syntax-string)' },
  { tag: [tags.typeName, tags.namespace, tags.className], color: 'var(--agent-syntax-type)' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName), tags.local(tags.variableName),
    tags.special(tags.variableName), tags.macroName], color: 'var(--agent-syntax-definition)' },
  { tag: [tags.comment, tags.meta], color: 'var(--agent-syntax-comment)' },
  { tag: tags.invalid, color: 'var(--agent-syntax-invalid)' },
]);

export default function ReadOnlyCode({ text, filename, wrap, line }: {
  readonly text: string; readonly filename: string; readonly wrap: boolean; readonly line?: number;
}) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new EditorView({ parent: parent.current!, state: EditorState.create({ doc: text, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `Read-only source: ${filename}` }),
      lineNumbers(), highlightActiveLineGutter(), syntaxHighlighting(readOnlyHighlight),
      search({ top: true }), keymap.of(searchKeymap),
      ...(wrap ? [EditorView.lineWrapping] : []),
      // CodeMirror's base theme stays in its light variant, so the parts of it this viewer shows take their colors from the
      // variables here. A rule that replaces a light one matches its specificity and is mounted after it, so it wins.
      // Selected text keeps the browser's own highlight, which follows the color scheme: without drawSelection() CodeMirror
      // draws no .cm-selectionBackground.
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'var(--agent-panel)', color: 'var(--agent-ink)', fontSize: '13px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        '.cm-content': { padding: '12px 0' },
        '.cm-gutters': { backgroundColor: 'var(--agent-surface-muted)', color: 'var(--agent-muted)', border: 'none' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--agent-surface-selected)', color: 'var(--agent-ink)' },
        '&.cm-focused': { outline: 'none' },
        '.cm-panels': { backgroundColor: 'var(--agent-surface-muted)', color: 'var(--agent-ink)' },
        '.cm-panels-top': { borderBottom: '1px solid var(--agent-rule)' },
        '.cm-search': { fontFamily: 'inherit' },
        '.cm-panel.cm-search label': { color: 'var(--agent-ink)' },
        '.cm-panel.cm-search [name=close]': { color: 'var(--agent-muted)' },
        '.cm-textfield': { backgroundColor: 'var(--agent-panel)', color: 'var(--agent-ink)', border: '1px solid var(--agent-rule)' },
        '.cm-button': {
          backgroundImage: 'none', backgroundColor: 'var(--agent-panel-raised)', color: 'var(--agent-ink)', border: '1px solid var(--agent-rule)',
        },
        // The light theme's pressed gradient is more specific than the rule above and would flash light in dark mode.
        '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--agent-surface-selected)' },
        '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--agent-signal) 22%, transparent)' },
        '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--agent-signal) 40%, transparent)' },
      }),
    ] }) });
    let disposed = false;
    const language = LanguageDescription.matchFilename(languages, filename);
    if (language) void language.load().then(support => {
      if (!disposed) view.dispatch({ effects: StateEffect.appendConfig.of(support) });
    }).catch(() => { /* Source stays readable when optional highlighting cannot load. */ });
    if (line) {
      const position = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    }
    return () => { disposed = true; view.destroy(); };
  }, [text, filename, wrap, line]);
  return <div ref={parent} className="agent-file-code" />;
}

