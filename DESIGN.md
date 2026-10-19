# Design

## Theme

The developer reads long conversations in a normally lit workspace. Retain the existing light canvas, softly tinted supporting rails, and quiet blue action color.

## Tokens

Use the workbench CSS tokens in packages/agent-remote-lab/src/app.css: --obs-canvas, --obs-surface, --obs-text, --obs-text-secondary, --obs-border, --obs-action, and semantic state colors. Use OKLCH for new color values.

## Typography

Use the existing system sans stack at 14 px with fixed rem sizing. Reserve monospace for session identifiers and technical values.

## Layout

Keep the conversation central, discovery and creation in the context rail, and Trace and Replica inspection additive. At compact widths the context rail becomes the existing focus-managed drawer. Session lists are compact rows with title, workspace, and activity metadata, never a grid of cards.

A Window can contain multiple top-level sessions and their associated views; it has no unique main session. Selection belongs to one pane, including an empty pane, rather than to an entire session family. Clicking its title, conversation, or composer selects it. In wide layouts, a thin inset border and a lightly tinted heading identify the target without changing layout dimensions. Global controls retain that target. Compact presentation uses the foreground pane as the selected target without an extra selection border or heading tint. Parent, Ask source, TPM source, and Team relationships remain business associations independent of selection.

## Components

Retain existing button shapes, focus rings, supporting rails, timeline renderer, and composer. Use inline new-session fields, restrained selected backgrounds, meaningful empty states, and explicit refresh after cursor expiry.
