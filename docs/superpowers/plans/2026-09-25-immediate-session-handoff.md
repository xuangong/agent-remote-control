# Immediate session handoff implementation plan

**Goal:** Transfer an ARC-managed stdio session between native CLI and Controller immediately, preserving identity and distinguishing requested interruption from an abnormal exit.

**Architecture:** A provider-neutral local ownership lease fences native writers. An authenticated loopback endpoint transfers a lease only after the old owner confirms release; the Copilot adapter supplies native close and lock verification. The browser requests an explicit generation-bound takeover through the existing attach route.

**Spec:** ../specs/2026-09-24-copilot-session-handoff.md

## Constraints

- No safe-wait mode, no native lock deletion, no automatic takeover during recovery.
- Web-to-web only transfers remote interaction authority and leaves native work running.
- Native takeover interrupts work; failures remain visible and never admit another writer.
- Local management tokens never enter public responses or recordings.
- Keep independent native profiles and existing user services intact.

## Tasks

- [x] Add real local-transport tests for exclusive acquisition, authenticated takeover, generation conflicts, stop failure, and abnormal exit reporting. Implement `native-session-owner.ts` to satisfy them.
- [x] Integrate the lease with `copilot-directory.ts` and `copilot-command.ts`; add adapter close/check operations. Test running CLI/SDK transfers using isolated profiles and the existing loopback model fixture.
- [x] Extend attach with an explicit target owner generation. Forward through policy and broker boundaries; add Chatbox takeover feedback without safe-wait options. Test authorization, CAS, and ordinary reconnect behavior.
- [x] Update the accepted spec and compatibility artifacts. Build before dependent tests; run bounded focused regressions, typechecks, and browser validation.

## Validation

- Local ownership, CLI and directory regressions: 26 tests passed in the final focused run.
- Real macOS SDK/native CLI and interactive PTY transfers passed with isolated profiles.
- Built product through the authenticated Gateway session channel: warm and cold mobile takeover passed. A cold view now keeps its Chatbox takeover controls in front instead of opening the Sessions drawer over them.
- Mobile native takeover and connection-error browser regressions: 4 passed.
- ARDB browser-to-browser handoff: passed; the existing model turn finishes without native interruption.
- Lab production build, lab/e2e typecheck, compatibility update/check and diff whitespace validation passed.
- Windows native takeover remains unverified on hardware. Unmanaged native clients remain explicitly unsupported for automatic termination.
- Implementation is local to the feature worktree; this task did not merge, push, deploy or publish.
