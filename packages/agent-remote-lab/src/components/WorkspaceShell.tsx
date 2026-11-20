import { accessLocale, accessView } from '@orchardworks/agent-relay-core/access-page';
import { deviceChoices } from '../device-choices.js';

/**
 * A returning browser's page while it checks access and loads code: the theme's ground and nothing else, so a short wait
 * shows no words (I4, decision 4); assistive technology hears that Orchard is opening.
 */
export function WorkspaceShell() {
  const sentence = accessView('checking', accessLocale([deviceChoices().language.locale])) as { sentence: string };
  return <div className="gateway-workspace-shell" role="status" aria-busy="true" aria-label={sentence.sentence} />;
}
