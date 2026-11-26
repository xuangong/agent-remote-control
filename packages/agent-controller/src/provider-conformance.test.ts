import { runProviderConformance, runUnknownEventRule } from '@orchardworks/agent-provider-sdk/conformance';
import { claudeConformanceSubject } from '@orchardworks/agent-provider-claude/recordings';
import { codexConformanceSubject } from '@orchardworks/agent-provider-codex/recordings';
import { copilotConformanceSubject } from '@orchardworks/agent-provider-copilot/recordings';
import { piConformanceSubject } from '@orchardworks/agent-provider-pi/recordings';
import { openCodeNativeFake } from '@orchardworks/agent-provider-opencode/testing';

import { controllerConformancePorts } from './test-utils/provider-conformance.js';

/**
 * The provider conformance kit (`@orchardworks/agent-provider-sdk/conformance`) run for every journal-capable adapter: each brings its
 * declaration, its recordings and a fake of its CLI, and the Controller brings the journal's window decision and the CLI simulator. A new
 * adapter joins the list below; it needs no change to the Controller, the Relay or the client. `pnpm test:providers` runs this file.
 */
for (const subject of [codexConformanceSubject(), claudeConformanceSubject(), copilotConformanceSubject(), piConformanceSubject()]) runProviderConformance(subject, controllerConformancePorts);
// OpenCode is not journal-capable: it follows the one rule every adapter follows, for events of a kind it does not know (gap 10).
runUnknownEventRule({ name: 'opencode', providerId: 'opencode', native: openCodeNativeFake() });
