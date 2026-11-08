// The gotcha trigger: a shell command failed, and a changed retry of it
// succeeded. Then the success's tool result gets one line (NUDGE), never the
// system prompt, so the cached prefix stays the same.
//
// A pure detector over the session's shell runs, oldest first. The retry
// "is of" a failure when their words mostly overlap (most of the shorter
// command's words are in the other) and they are not the same command: the
// same command passing again is a code fix, not a fact about how to run it.

export const NUDGE = "A retry fixed a failure: if the fix is a durable fact about this repo or machine, memory_save it."

/** How many earlier runs a retry may look back over. */
export const WINDOW = 3
/** Overlap above which two commands are one command run two ways. */
export const OVERLAP = 0.5

export interface ShellRun {
  readonly command: string
  readonly failed: boolean
}

/** A command's words, without `cd <dir>` steps, the separators between steps, and redirections. */
export const wordsOf = (command: string): ReadonlySet<string> => {
  const tokens = command.split(/\s+|&&|\|\||;|\|/).filter((token) => token !== "")
  const words = new Set<string>()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "cd") {
      index += 1
      continue
    }
    if (/^\d?>>?&?\d*$|^\/dev\/null$|^&$/.test(token)) continue
    words.add(token)
  }
  return words
}

/** Whether `retry` is `failure` run another way: most of the shorter one's words are in the other, and they differ. */
export const isRetryOf = (failure: string, retry: string): boolean => {
  const a = wordsOf(failure)
  const b = wordsOf(retry)
  if (a.size === 0 || b.size === 0) return false
  const shared = [...a].filter((word) => b.has(word)).length
  const same = shared === a.size && shared === b.size
  return !same && shared / Math.min(a.size, b.size) > OVERLAP
}

/**
 * Whether `current` is a changed retry that fixed a recent failure: it
 * succeeded, and within the last WINDOW runs the nearest run of the same
 * command is a failure of it. A success of it in between means the failure was
 * already fixed (and told once).
 */
export const retryFixed = (history: ReadonlyArray<ShellRun>, current: ShellRun): boolean => {
  if (current.failed) return false
  for (const run of history.slice(-WINDOW).reverse()) {
    const related = run.command.trim() === current.command.trim() || isRetryOf(run.command, current.command)
    if (!related) continue
    return run.failed && run.command.trim() !== current.command.trim()
  }
  return false
}
