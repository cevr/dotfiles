import { resumesAt } from "@dotfiles/opencode-orchestrate/sabbath"
import { Data, DateTime, Option } from "effect"

/** Whether the service may restart now, and if not, what holds it. */
export type Gate = Data.TaggedEnum<{
  /** It is not the Sabbath rest. */
  Open: {}
  /** The Sabbath rest: no restart until `until` (epoch ms). */
  Sabbath: { readonly until: number }
}>
export const Gate = Data.taggedEnum<Gate>()

/**
 * The restart gate at `now`. The service restarts as soon as a build is staged, whatever its
 * sessions are doing: the restart cuts a running turn or subagent like an interrupt, and the server
 * resumes each and delivers a subagent's report to its parent (the fork's `SessionRestart`). A
 * running shell command dies with it, a background one without a notice (measured 2026-11-18;
 * the owner accepts it). Over the Sabbath rest (orchestrate's `sabbath.ts`) it never opens.
 */
export const gate = (now: number): Gate => {
  const rest = Option.fromNullishOr(resumesAt(now))
  if (Option.isSome(rest)) return Gate.Sabbath({ until: rest.value })
  return Gate.Open()
}

/** An instant in a log line. */
export const iso = (at: number): string => DateTime.formatIso(DateTime.makeUnsafe(at))

/** The gate in a log line. */
export const describeGate = (held: Gate): string =>
  Gate.$match(held, {
    Open: () => "not the Sabbath rest",
    Sabbath: ({ until }) => `the Sabbath rest, until ${iso(until)}`,
  })
