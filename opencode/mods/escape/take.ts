// Taking every waiting prompt back into the composer at once, decided without
// the host. Up on the composer's first row, and Escape on a prompt still
// waiting, take all the session's waiting prompts (queued for after the turn,
// and steers not yet delivered) out of the inbox and put them in the composer,
// attachments and all, as one prompt: oldest first, joined by a newline, after
// whatever the composer holds. The fork's `ui.composer.takeBack` does the
// taking; cmd/escape/setup.ts decides when and says what was left.

/** What the prompts become in the composer: the texts joined by a newline. */
export const SEPARATOR = "\n"

/**
 * Whether Up on the composer takes the waiting prompts: the cursor on its first row, where the host's Up goes to
 * the history (at the start) or to the start (elsewhere on that row).
 */
export const firstRow = (composer: { readonly scrollY: number; readonly visualCursor: { readonly visualRow: number } }) =>
  composer.scrollY + composer.visualCursor.visualRow === 0

/** The toast when the server gave some waiting prompts back to nobody: they were sent meanwhile, or it did not answer. */
export const left = (count: number) => {
  if (count === 1) return "1 waiting prompt was not taken back: sent already, or the server did not answer"
  return `${count} waiting prompts were not taken back: sent already, or the server did not answer`
}
