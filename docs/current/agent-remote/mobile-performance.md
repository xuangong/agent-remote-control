# Mobile performance validation

Measured on 2026-09-20 against baseline `152ad44`.

## Render benchmark

The same isolated production bundle harness rendered the real `LabWorkbench` and
`TraceView` components in headless Chromium at a 390 x 844 mobile viewport with
4x CPU throttling. Each case measured nine synchronous React render-and-commit
updates after initial mounting; the table reports the median in milliseconds.
Messages contain headings, paragraphs, lists, links and fenced code. Streaming
updates replace only the final message with an additional token. Baseline and
optimized runs were sequential, after builds and browser regression tests finished.

| Scenario | Baseline | Optimized |
| --- | ---: | ---: |
| 100 entries, unchanged timeline | 66.3 | 2.4 |
| 100 entries, streaming final message | 66.7 | 4.1 |
| 300 entries, unchanged timeline | 194.1 | 5.6 |
| 300 entries, streaming final message | 188.3 | 11.3 |
| 300 entries and hidden Trace, unchanged | 224.1 | 5.8 |
| 300 entries and hidden Trace, streaming | 222.8 | 9.4 |

These are component update measurements, not end-to-end latency, INP, physical
phone frame rates or battery consumption. Network transfer and replica reduction
are outside this harness. Initial page loading and very large histories remain
separate optimization opportunities.

With a visible mobile page, closed side panel and no retained previews, nominal
Host/preview/tunnel polling drops from 54 to 16 requests per minute, excluding
initial refreshes, mutations, network duration and WebSocket traffic. This is
derived from configured intervals, not a measured battery saving.

## Verification

- Web: 299 unit tests passed.
- Lab: 496 unit tests passed, six skipped. The native Codex process suite was
  excluded because no dedicated `BORGEE_CODEX_TEST_EXECUTABLE` was configured.
- Image input: 32 browser cases passed across desktop/mobile Chromium and WebKit.
- Markdown reading: ten passed; two desktop-only orientation exclusions skipped.
- Trace, session channels, conversation previews, tunnel controls and Send press:
  24 desktop/mobile Chromium cases passed.
- Real transport/browser suite: 13 cases passed, including both mobile lifecycle
  recovery cases. Two cases still fail at reopening a preview after unregistering
  it, in Chromium and WebKit. The same Chromium failure was reproduced in the
  clean baseline checkout; this change does not resolve that existing behavior.
- Relay build, Web/Lab typechecks, compatibility manifest validation and independent
  code review passed.

The Trace fixture now separates timeline subscribers from activity subscribers.
Recovery coverage follows the existing send semantics: elapsed time alone is not
a failure; disconnect preserves an unconfirmed message; explicit Retry preserves
operation identity; reload preserves unresolved feedback for review and deletion.

No deployment or physical-device battery measurement is part of this validation.
