// The floating shortcut slot and the Ask workspaces.
import type { AppScope } from '../types.js';

export function AskWorkspaces({ scope }: { readonly scope: Pick<AppScope, 'ask' | 'askFloatingSlot' | 'askSources' | 'backgroundInert' | 'renderAsk' | 'shortcutFloatingSlot' | 'sourceStateFor'> }) {
  const { ask, askFloatingSlot, askSources, backgroundInert, renderAsk, shortcutFloatingSlot, sourceStateFor } = scope;
  return <>
    <div ref={shortcutFloatingSlot} className="lab-movable-slot" />
    <div className="lab-ask-workspaces" {...backgroundInert}>
      <div ref={askFloatingSlot} className="lab-movable-slot" />
      {askSources.flatMap(({ source, owner }) => {
        return ask.isOpen(source, owner)
          ? [renderAsk(source, sourceStateFor(source))] : [];
      })}
    </div>
  </>;
}
