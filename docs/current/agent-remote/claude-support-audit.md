# Claude support audit against the Provider baseline

Audit date: **2026-09-11**. Initial runtime implementation: **`614d9fe`**, updated by native parity work following **`821d1c6`**, `feat/claude-provider`; public protocol **1.4.0**, SDK **0.3.247**, native Claude Code **2.1.247**. This is a source and test audit of the implemented adapter, not a proposal to implement the entire SDK and not a main/release claim.

Target and degree definitions: [Provider support baseline](provider-support.md). New Provider acceptance procedure: [onboarding checklist](provider-onboarding.md).

## Result by target group

| Baseline rows | Current finding | Evidence / disposition |
| --- | --- | --- |
| S1, S2, S4, H3 | Query create, saved resume, workspace and parent ownership are implemented. Concurrent resumes of one parent are rejected while loading/loaded; failed loads release reservation. Empty unsaved sessions can disappear after owner restart. | [provider.ts](../../../packages/agent-provider-claude/src/provider.ts), [provider.test.ts](../../../packages/agent-provider-claude/src/provider.test.ts), [Host directory tests](../../../packages/agent-host/src/claude-directory.test.ts). Core path present; retain S2 partial boundary. |
| S3, S5 | No attachment to another Claude terminal. Model/effort/planning can be selected at creation; live model settings now use public Query discovery and setters. | [session.ts](../../../packages/agent-provider-claude/src/session.ts), [Host registration](../../../packages/agent-host/src/claude.ts). Terminal attachment remains unavailable; creation-only effort retains W2. |
| I1, I4, I5 | Idle text and interrupt supported; lifecycle authoritative; Query survives interruption. Input/commands/planning changes serialize. | [session tests](../../../packages/agent-provider-claude/src/session.test.ts), [native process test](../../../packages/agent-provider-claude/src/provider.local.test.ts). Core path present. |
| I2, I3 | No busy immediate steering or native next-turn queue. Real CLI probes show priority input can cross turn boundaries and survive public interrupt. | [Native control probes](../../../packages/agent-provider-claude/src/native-controls.local.test.ts) and session guards. Proven native equivalence gap; W1 remains manual. |
| T1, T2 | Root history/live, streaming text/reasoning, native content blocks, tool lifecycle and turn outcomes are mapped. Child frames do not become root assistant text. | [projector.ts](../../../packages/agent-provider-claude/src/projector.ts), [projector tests](../../../packages/agent-provider-claude/src/projector.test.ts), [native process test](../../../packages/agent-provider-claude/src/provider.local.test.ts). Core path present. |
| T3, T4, T5, T6 | Results expose bounded text and uniquely attributable native JSON; todo mapping remains `TodoWrite`; compact has completion boundary. Per-turn tokens and Query cost increments are separate from exact-model native context capacity and `/context` occupancy. Titles remain directory metadata; no PTY control. | [projector.ts](../../../packages/agent-provider-claude/src/projector.ts), [session.ts](../../../packages/agent-provider-claude/src/session.ts), [catalog.ts](../../../packages/agent-provider-claude/src/catalog.ts). Partial; richer native data is not claimed. |
| X1, X2, X7 | Questions and one-time tool permissions map to root callbacks; strict pending-response validation and cancellation are implemented. No sensitivity marker is mapped from Claude questions. Callbacks/receipts cannot be resurrected by transcript resume. | [interactions.ts](../../../packages/agent-provider-claude/src/interactions.ts), [interaction tests](../../../packages/agent-provider-claude/src/interactions.test.ts). Partial/conditional, not six-kind interaction parity. |
| X3 | Native permission-mode planning toggle and actual `ExitPlanMode.plan` produce typed review. Approval waits for restored selected permissions; rejection returns feedback; cancellation and late native setter settlement keep exact ownership. | [session.ts](../../../packages/agent-provider-claude/src/session.ts), [interactions.ts](../../../packages/agent-provider-claude/src/interactions.ts). `planApproval` is enabled within that native scope; [native controls](../../../packages/agent-provider-claude/src/native-controls.local.test.ts) and cancellation regressions verify it. |
| X4, X5, X6 | No MCP form, granular permission grant or external-action mapping. Real native elicitation drops constraints and sensitive markers before the public callback. | [Native schema-loss probes](../../../packages/agent-provider-claude/src/native-elicitation.local.test.ts). Keep unavailable; W9 does not confer equivalence. |
| C1, C2 | Idle model/permission descriptors call public Query setters and publish only confirmed state. Effort remains creation-only; native session menus stay excluded from slash command discovery. | [commands.ts](../../../packages/agent-provider-claude/src/commands.ts), [session.ts](../../../packages/agent-provider-claude/src/session.ts). Native [settings tests](../../../packages/agent-provider-claude/src/settings.test.ts) and controls probes; W2 applies to effort only. |
| C3, C4 | Fresh SDK skill reload/list, validation, unique opaque IDs, execution revalidation and unchanged slash arguments are implemented. Unknown non-filtered entries are classified as skills from a flat list. | [commands.ts](../../../packages/agent-provider-claude/src/commands.ts), [discovery tests](../../../packages/agent-provider-claude/src/discovery.test.ts), [native process test](../../../packages/agent-provider-claude/src/provider.local.test.ts). Invocation supported; provenance/classification partial. |
| C5, C6 | No full skill-document resource or adapter prompt-file expansion; compact only when SDK advertises it. Descriptions are not skill content. | [commands.ts](../../../packages/agent-provider-claude/src/commands.ts). C5 unavailable; C6 partial; W3. |
| R1, R2 | Root `readResource` serves native tool-result embedded PNG/JPEG/GIF/WebP bytes through bounded immutable session references. No path/URL fetching, upload or child resources. | Capabilities and [projector.ts](../../../packages/agent-provider-claude/src/projector.ts). [Native image/resume tests](../../../packages/agent-provider-claude/src/native-images.local.test.ts). W5 applies to media outside this subset. |
| A1, A2 | Direct native local-agent task identity/status, stable aliases, separate Timeline and shared Host child navigation are implemented. Nested/ambient/shell tasks are excluded. | [children.ts](../../../packages/agent-provider-claude/src/children.ts), [children tests](../../../packages/agent-provider-claude/src/children.test.ts), [browser test](../../../packages/agent-remote-lab/e2e/claude-discovery.spec.ts). Supported within direct/read-only scope. |
| A3, A6 | No independent child input, cancellation, settings, commands, approvals or generic spawn/stop/resume operations. No child Query is created. | [child-session.ts](../../../packages/agent-provider-claude/src/child-session.ts), Host routing and native process test. Intentional boundary, not a missing UI button. W4. |
| A4, A5 | SDK saved child history is reconciled by UUID/content-block identity. Fresh saved attachment is canonical; an already observed binding cannot prepend missed prompts/tools. Foreground observation ends at parent result; background tasks follow native terminal events; root loss freezes views. | [child-session.ts](../../../packages/agent-provider-claude/src/child-session.ts), [children tests](../../../packages/agent-provider-claude/src/children.test.ts). Partial; neither freeze nor saved-history status proves successful native work. W4. |
| H1, H2 | Reconnect/re-pair reuse the live Host projection and Query. Cold resume reads persisted history, including direct children, but cannot recover callbacks/in-progress turns/unsaved empty roots. | [Host tests](../../../packages/agent-host/src/host.test.ts), [native process test](../../../packages/agent-provider-claude/src/provider.local.test.ts), [browser test](../../../packages/agent-remote-lab/e2e/claude-discovery.spec.ts). W6. |

All baseline IDs are covered above. Degree and workaround details remain in the baseline to avoid two competing support matrices.

## Endpoint findings

- **Adapter:** native interpretation is contained in Claude's package. Native model/permission settings and typed plan approval are now enabled; queue and steer remain disabled after negative native probes. Child views advertise their own read-only capability set.
- **Agent Host:** Claude registers alongside Codex; directory children require a loaded owning parent. Repeated attach and re-pair retain the existing projection, including its partial live-history boundary.
- **Protocol and Relay:** no new public rail is needed for implemented skills or child views. They reuse command list/result, runtime child descriptors and ordinary Agent sessions. An adapter cannot insert a historical prefix into an established live Timeline.
- **Web/Lab:** slash discovery, selected skill arguments, child navigation, status and read-only input use shared components. Missing documentation cannot be fetched by the skill viewer. Plain text submitted during an active Claude turn receives adapter rejection; the generic send affordance alone does not imply steer support.
- **Debugger:** an already bound Claude root/child can be inspected using the public Agent ID. Its CLI has no skills/commands/settings/queue or Host child-attach entry points, independent of Claude's native capabilities.

## Gap disposition and bounded next steps

The [Paseo comparison and gap ledger](provider-gap-analysis.md) owns feasibility and delivery order. The [native parity record](provider-native-parity.md) documents delivered settings/plan/results/usage and negative native probes. Source-level API availability did not establish steer or form equivalence; those flags remain disabled.

| Gap group | Cause / path | Current boundary |
| --- | --- | --- |
| Model/permissions, steer and plan review | G1/G5 delivered via native mappings; G3 equivalence failed against the pinned CLI. | Settings/plan flags are enabled; steer remains disabled. |
| Reasoning settings and queue | G2/G4: no public effort setter; native queued input can outlive a turn and public interrupt. | Creation effort only; no Query replacement workaround, hidden queue or hot-update claim. |
| Forms, permissions, results/usage and resources | G8/G9 delivered native structured result/accounting/context and embedded raster mappings. G6 native schema loss and G7 authority gates remain explicit. | No fabricated typed workflow, scope, context size or resource authority. |
| Skill body/provenance | G10: establish actual loaded-source identity before bounded document reads. | Descriptions and guessed paths are not full skill documentation. |
| Child controls and recovery | G11/G12: native task stop is a limited candidate; full child control and history rebase are distinct problems. | Children remain read-only; approvals belong to parent; existing projections remain append-only. |
| Debugger | G19: implement public CLI entry points separately. | Headless/Lab availability does not mean CLI availability. |

## Verification record

The runtime implementation's prior full validation at `614d9fe`: **1,241 passed, 6 skipped**; conformance **13 passed**; desktop/mobile Claude discovery plus dual-provider Host browser cases **6 passed**. Build/typecheck and compatibility checks passed in that implementation turn.

The documentation audit separately reruns the five relevant adapter/plugin/Host suites with per-test 10-second and hook 30-second limits plus a 180-second outer deadline. Result: **492 passed, 0 skipped** across **52 files**: DSH adapter 161, Codex adapter 188, Claude adapter 31, DSH plugin 75, Agent Host 37. Log: `.runtime/provider-support-tests.log` (local validation artifact). The source audit also checks SDK/wire, shared client/renderer, Lab routing and debugger command dispatch; that inspection is not a new deployed endpoint test.

The documentation audit also runs `pnpm test:conformance`: **13 passed** across **3 files**. `pnpm compatibility:update`, `pnpm compatibility:check` and `git diff --check` pass. Local documentation links and coverage of all 40 baseline row IDs are checked separately.

The Claude native process test creates a real `.claude/skills/fixture-skill/SKILL.md`, discovers/invokes it through Claude Code, starts a real native Agent/Task child, checks separated output and closed status, and restores the same saved child identity. It uses an isolated configuration/workspace and a **loopback Anthropic Messages SSE fixture**, not an online model service. The browser test uses the real adapter/Host/uplink/Relay/UI with a **deterministic Query fixture**, not a live Claude model.

Regressions cover concurrent parent resume, failed-load cleanup, initial prompt/tool/answer order, partial/full stream overlap, multiple completed blocks sharing one message ID, unsaved tails, delayed deltas, same-text distinct UUIDs, stale skills, parent namespace, direct-child filtering, background lifetime, read-only controls and observer disposal. These checks support the named boundaries rather than claiming all native APIs are implemented.


Reproduction (build the runtime first when source has changed):

```bash
export BORGEE_CODEX_TEST_EXECUTABLE=/absolute/path/to/codex-0.148.0
export AGENT_CLAUDE_TEST_EXECUTABLE=/absolute/path/to/claude-2.1.247
export NODE_OPTIONS=--no-experimental-webstorage
python3 - <<'PYTEST'
import subprocess
result = subprocess.run([
    'pnpm', '-r', '--filter', '@borgee/agent-provider-dsh',
    '--filter', '@borgee/agent-provider-codex', '--filter', '@borgee/agent-provider-claude',
    '--filter', '@agent-remote-control/dsh', '--filter', '@borgee/agent-host',
    'run', 'test', '--hookTimeout=30000',
], timeout=180)
raise SystemExit(result.returncode)
PYTEST
```

The 492-test documentation audit above is historical. Subsequent native parity implementation, negative probes, real broker integration and browser validation are recorded separately in [provider-native-parity.md](provider-native-parity.md). No deployed live-model acceptance is implied.
