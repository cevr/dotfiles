# What makes fx feel like fx

The conversation is the interface. fx reads like a shell conversation: a strong
prompt, a readable answer, and a short record of the work between them. The UI
helps follow the agent without making its machinery the main event.

This mod takes that structure into Claude while keeping Claude's default color
tokens. It does not import fx's grayscale palette.

## Hierarchy and rhythm

The submitted prompt is bold, with a `┃` rail. Replies use native rich Markdown
and share a two-column transcript inset with activity and turn timing. Space
separates turns; related calls sit together. Repeated tool names, frames and
success bodies should not consume more attention than the answer.

A tool row answers what happened, to what, and with what useful result:
`Read src/app.ts`, `Ran bun test · 12 lines`, `Edited src/app.ts +3 −1`.
Paths become relative only inside the session's working directory. Counts come
from captured results. An unchanged write says so. A running action has a
working marker and an unfinished verb. Failure and interruption are explicit.

## Disclosure without losing the thread

Compact is the reading view. Activating a tool row opens one call in a separate
inspection pane: its file or output, diff where available, arguments and captured
result. `/fx-tool` offers a keyboard-accessible chooser of rendered activity.
Large histories and output are paged, while Copy section copies the complete
selected source. `/fx-details on` restores all native tool rows.

Native rendering remains responsible for errors, interruptions, proposed or
user-modified writes, incomplete and nontext reads, background commands, safety
hints, and unfamiliar result shapes. Compact presentation must preserve evidence
that changes how the user should interpret the result.

## A quiet action area

Claude's native mode, permission and working controls stay live. The extra footer
shows model and context. Account, folder, Git, cost and usage windows live behind
`details` or `/fx-status`. They come from Claude's session API, and Git runs only
when inspection is requested. Missing figures stay unknown. No timer, network
polling, credential lookup or custom color palette is needed.

The input editor, its border and startup logo have no render hook in the current
API. They remain native. Keyboard shortcuts and permission dialogs retain their
native behavior; the mod supplies explicit commands for its own disclosure.

## Source of the design

Read against vercel-labs/fx at `d5a7bc50` (after v0.0.13):

- [User message card](https://github.com/vercel-labs/fx/blob/d5a7bc50/src/ui/assistant/user_message_card.zig): prompt rail, weight and wrapping.
- [Tool group projection](https://github.com/vercel-labs/fx/blob/d5a7bc50/src/ui/transcript/tool_group_projection.zig): semantic actions and compact/expanded activity.
- [Footer row text](https://github.com/vercel-labs/fx/blob/d5a7bc50/src/ui/footer/row_text.zig): brief, clipped context at the action area.
- [Full transcript screen](https://github.com/vercel-labs/fx/blob/d5a7bc50/src/ui/full_transcript_screen.zig): inspection as a separate reading mode.

The separate per-call pane and on-demand status view are adaptations to
[Claude's mod API](https://github.com/anthropics/claude-code/tree/main/mods),
not claims that fx exposes those exact controls. The system to preserve is the
hierarchy: prompt, answer, concise activity, deliberate inspection.
