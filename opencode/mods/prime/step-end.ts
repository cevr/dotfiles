// How a step that ended badly reads in the transcript, without rendering:
// its session row, from the error and retry the host keeps on the
// assistant message.
import type { Detail } from "./detail.ts"

/** What ended a step, as the host keeps it on the assistant message. */
export type StepEnd = {
  readonly error?: { readonly type: string; readonly message: string } | undefined
  readonly retry?: { readonly attempt: number; readonly at: number; readonly error: { readonly message: string } } | undefined
}

/** The lines a step's error keeps below All: a provider body can run long. */
export const ERROR_LINES = 4

/**
 * The row a step's end draws: `↻` a retry
 * (`Retrying in 3s · attempt 2 · Rate limit exceeded`, `Retrying now` once
 * due), `■` the reader's interrupt, `✗` an error that ended the turn (its
 * first `ERROR_LINES` lines below All, then the count of the rest). None for
 * a step that ended well.
 */
export function stepEndRow(
  end: StepEnd,
  now: number,
  detail: Detail,
): { readonly glyph: string; readonly tone: "muted" | "warning" | "error"; readonly text: string } | undefined {
  const firstLine = (text: string) => (text.split("\n")[0] ?? "").trim()
  if (end.retry) {
    const seconds = Math.ceil((end.retry.at - now) / 1000)
    const reason = firstLine(end.retry.error.message)
    const when = seconds > 0 ? `Retrying in ${seconds}s` : "Retrying now"
    return { glyph: "↻", tone: "muted", text: [when, `attempt ${end.retry.attempt}`, reason].filter(Boolean).join(" · ") }
  }
  if (!end.error) return undefined
  if (end.error.message === "Step interrupted") return { glyph: "■", tone: "warning", text: "Interrupted" }
  const lines = end.error.message.replace(/\s+$/, "").split("\n")
  const capped =
    detail === "all" || lines.length <= ERROR_LINES
      ? lines
      : [...lines.slice(0, ERROR_LINES), `… +${lines.length - ERROR_LINES} lines (ctrl+o)`]
  return { glyph: "✗", tone: "error", text: capped.join("\n") }
}
