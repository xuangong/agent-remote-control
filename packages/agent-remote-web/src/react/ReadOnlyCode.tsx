import { useEffect, useRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap } from '@codemirror/search';

export default function ReadOnlyCode({ text, filename, wrap, line }: {
  readonly text: string; readonly filename: string; readonly wrap: boolean; readonly line?: number;
}) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new EditorView({ parent: parent.current!, state: EditorState.create({ doc: text, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `Read-only source: ${filename}` }),
      lineNumbers(), highlightActiveLineGutter(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      search({ top: true }), keymap.of(searchKeymap),
      ...(wrap ? [EditorView.lineWrapping] : []),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'var(--agent-panel)', color: 'var(--agent-ink)', fontSize: '13px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        '.cm-content': { padding: '12px 0' },
        '.cm-gutters': { backgroundColor: 'var(--agent-surface-muted)', color: 'var(--agent-muted)', border: 'none' },
        '&.cm-focused': { outline: 'none' },
        '.cm-search': { fontFamily: 'inherit' },
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

