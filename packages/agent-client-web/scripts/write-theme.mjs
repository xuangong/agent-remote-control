// Writes src/theme/theme.css from the tokens (`pnpm --filter @orchardworks/agent-client-web theme:write`). Node strips the types.
import { writeFileSync } from 'node:fs';
import { renderThemeCss } from '../src/theme/tokens.ts';

writeFileSync(new URL('../src/theme/theme.css', import.meta.url), renderThemeCss());
