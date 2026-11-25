import { Array as Arr, Data, DateTime, Option, Result } from "effect"

/** The commits a target names, as the fleet records them. */
export interface Commits {
  readonly dotfiles: string
  readonly fork: string
}

/** The form of the one machine line a batch file names its verified heads with, as a refusal quotes it. */
export const HEADS_FORM = "`Heads: dotfiles=<40-hex sha> fork=<40-hex sha>`"

/** The heads line, exactly: both full commit names, lowercase, in this order, nothing else on the line. */
const HEADS_LINE = /^Heads: dotfiles=([0-9a-f]{40}) fork=([0-9a-f]{40})$/

/** A line that means to be the heads line: it starts with `Heads:` in any case, after any indent, bullet, quote or backtick. */
const HEADS_START = /^\W*heads:/i

/**
 * The heads a batch file names: its one line `Heads: dotfiles=<sha> fork=<sha>`, both full
 * commit names, which the orchestrator writes after resolving them. No prose is read. A file with
 * no such line, two or more, or one not exactly in that form (a short or uppercase hash, a missing
 * repository, extra words) fails with why, and the publish refuses rather than guess. The one
 * reader of the line: the fleet's publish (git/fleet.ts) and a verify's head (tools.ts `batchHeadOf`).
 */
export const headsOf = (text: string): Result.Result<Commits, string> => {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => HEADS_START.test(line))
  const line = Arr.head(lines)
  if (Option.isNone(line)) return Result.fail(`has no heads line; write one, exactly ${HEADS_FORM}`)
  if (lines.length > 1) return Result.fail(`has ${lines.length} heads lines; write one, exactly ${HEADS_FORM}`)
  const match = Option.fromNullishOr(HEADS_LINE.exec(line.value))
  if (Option.isNone(match)) return Result.fail(`has a malformed heads line (<${line.value.slice(0, 160)}>); write it exactly ${HEADS_FORM}, both full commit names`)
  return Option.match(Option.all({ dotfiles: Arr.get(match.value, 1), fork: Arr.get(match.value, 2) }), {
    onNone: () => Result.fail(`has a malformed heads line; write it exactly ${HEADS_FORM}`),
    onSome: Result.succeed,
  })
}

/** A target the fleet records: its commits and the batch that verified them. */
export interface Verified extends Commits {
  readonly batch: string
}

/**
 * What recording an accepted batch's target did (`Fleet.record`):
 * - `Off`: this host records no target (no checkouts configured), so it says nothing.
 * - `Recorded`: the target moved to the batch's heads.
 * - `Unchanged`: the target already names those heads.
 * - `Refused`: nothing was recorded, and `reason` says why: a batch file that does not name both
 *   heads, a head the checkouts or origin lack, a head that is not a descendant of the current
 *   target's, or a push refused.
 */
export type FleetOutcome = Data.TaggedEnum<{
  Off: {}
  Recorded: { readonly target: Verified }
  Unchanged: { readonly target: Verified }
  Refused: { readonly reason: string }
}>
export const FleetOutcome = Data.taggedEnum<FleetOutcome>()

/** An absolute path to a findings file: up to a space, quote, backtick, bracket or parenthesis. */
const FINDINGS = /\/[^\s`'"()<>[\]]*-findings\.md/g

/**
 * The findings file a verifier's hand-back names: the last absolute path ending in `-findings.md` on its first line,
 * past whatever stands between the verdict and the path (`accepted (sidebar-fit accepted, …) /run/batch-findings.md`).
 */
export const findingsOf = (text: string): Option.Option<string> => {
  const first = Option.getOrElse(Arr.findFirst(text.split("\n"), (line) => line.trim() !== ""), () => "")
  return Option.map(Arr.last([...first.matchAll(FINDINGS)]), (match) => match[0])
}

/** The note's description in the root's context. */
export const FLEET_DESCRIPTION = "orchestrate: the fleet target was not published"

const short = (target: Commits) => `dotfiles ${target.dotfiles.slice(0, 10)}, fork ${target.fork.slice(0, 10)}`

/**
 * The line an outcome adds at `at` where the orchestrator reads it (the run's log.md, the root's
 * context, the server's log), stamped like the drift lines; none for `Off`.
 */
export const fleetLineOf = (batch: string, outcome: FleetOutcome, at: number): ReadonlyArray<string> => {
  const stamp = `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 16)}Z`
  return FleetOutcome.$match(outcome, {
    Off: () => [],
    Recorded: ({ target }) => [`${stamp} fleet: ${batch} accepted; published the verified target ${short(target)}`],
    Unchanged: ({ target }) => [`${stamp} fleet: ${batch} accepted; the verified target is already ${short(target)}`],
    Refused: ({ reason }) => [`${stamp} fleet: ${batch} accepted, but NOT published: ${reason}. Every host stays on the last published target.`],
  })
}
