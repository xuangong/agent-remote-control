import { runProviderConformance } from '@orchardworks/agent-provider-sdk/conformance';
import { claudeConformanceSubject } from '@orchardworks/agent-provider-claude/recordings';
import { codexConformanceSubject } from '@orchardworks/agent-provider-codex/recordings';
import { copilotConformanceSubject } from '@orchardworks/agent-provider-copilot/recordings';

import { controllerConformancePorts } from './test-utils/provider-conformance.js';

/**
 * The provider conformance kit (`@orchardworks/agent-provider-sdk/conformance`) run for every journal-capable adapter: each brings its
 * declaration, its recordings and a fake of its CLI, and the Controller brings the journal's window decision and the CLI simulator. A new
 * adapter joins the list below; it needs no change to the Controller, the Relay or the client. `pnpm test:providers` runs this file.
 */
for (const subject of [codexConformanceSubject(), claudeConformanceSubject(), copilotConformanceSubject()]) runProviderConformance(subject, controllerConformancePorts);
