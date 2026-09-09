# Interaction Capabilities Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with scoped ownership, tests, and review.

**Goal:** Close missing normalized interaction capabilities without copying Paseo's private wire shapes.

**Architecture:** Strongly typed SDK/protocol interactions feed shared Relay validation and React renderers. Codex translates native requests and responses; DSH preserves supported semantics.

**Tech Stack:** TypeScript, TypeBox, React, Vitest, Playwright, native Codex app-server 0.148.0.

**Spec:** docs/superpowers/specs/2026-09-09-interaction-capabilities.md

## Global constraints

- Isolated worktree, no Borgee changes, no service disruption, no push/publication.
- Preserve existing shapes where additive fields suffice; protocol 1.3.0 exact negotiation.
- No secrets in resolved events/history/traces; no automatic approvals or URL actions.
- Native interpretation stays in adapters. Shared validation and renderers know canonical fields only.
- Test runners have per-test and outer deadlines.

## Contract and transport

- [x] Add failing behavior tests for form constraints, request-aware responses, unsupported grants, and redaction.
- [x] Extend SDK control types and protocol schemas with the spec's fields; extract shared validation/redaction.
- [x] Integrate validation and redaction at Relay ingress/resolution and debugger trace boundaries; update capability schema and version references.
- [x] Verify tests and publish exact interfaces to adapter/UI workers.

## Codex native adaptation

- [x] Add scripted-native failing tests for elicitation form, URL, granular permission, restricted decisions, secret question, and cancellations.
- [x] Extract native interaction mapping out of the large session class; register handlers with request correlation and lossless native choices.
- [x] Normalize supported form schemas, decline unsupported forms explicitly, and preserve exact native grants.
- [x] Verify native responses, live/resolved events and cancellation with secret redaction; inspect plan recovery and event coverage.

## Renderer and DSH integration

- [x] Add failing DOM behavior tests for forms, URLs, permissions, policies, cancellation, and redacted receipts.
- [x] Add focused cards using existing interaction state/submit pattern; preserve existing visual hierarchy and offline disabling.
- [x] Keep DSH native capability/response semantics strict with the extended shared union, and cover local/remote race behavior.

## Verification and handoff

- [x] Write a source-backed Paseo comparison with implemented coverage and explicit remaining boundaries.
- [x] Run full unit/typecheck/build, compatibility and docs checks, then real transport and browser acceptance.
- [x] Review the complete diff, fix confirmed findings, commit and fast-forward clean local main.
- [x] Report actual live versus fixture validation and give the new workbench URL.
