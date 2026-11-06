// The compaction window every agent runs at, and what every compaction keeps
// word for word.

/**
 * The window every role and primary agent compacts at, in tokens. The host
 * never raises a model's own window, so a smaller model compacts at its own
 * ceiling instead.
 */
export const WINDOW = 400_000

/**
 * Kept word for word through every compaction, as on Claude Code: the files
 * the work depends on, where it stands and what the user asked.
 */
export const KEEP =
  "Keep these word for word: the path of every plan, log, notes or state file the work reads or writes; the current step and its next action; each instruction the user gave during the session. Name a file by its path rather than restating its contents: it can be read again."

/** The keep-list as the user message the compaction request carries after the conversation, before the summary prompt. */
export const keepMessage = (): { role: "user"; content: Array<{ type: "text"; text: string }> } => ({
  role: "user",
  content: [{ type: "text", text: KEEP }],
})
