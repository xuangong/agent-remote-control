# Design

## Theme

The developer reads long conversations in a normally lit workspace. Retain the existing light canvas, softly tinted supporting rails, and quiet blue action color.

## Tokens

Use the workbench CSS tokens in packages/agent-remote-lab/src/app.css: --obs-canvas, --obs-surface, --obs-text, --obs-text-secondary, --obs-border, --obs-action, and semantic state colors. Use OKLCH for new color values.

## Typography

Use the existing system sans stack at 14 px with fixed rem sizing. Reserve monospace for session identifiers and technical values.

## Layout

Keep the conversation central, discovery and creation in the context rail, and Trace and Replica inspection additive. At compact widths the context rail becomes the existing focus-managed drawer. Session lists are compact rows with title, workspace, and activity metadata, never a grid of cards.

## Components

Retain existing button shapes, focus rings, supporting rails, timeline renderer, and composer. Use inline new-session fields, restrained selected backgrounds, meaningful empty states, and explicit refresh after cursor expiry.
