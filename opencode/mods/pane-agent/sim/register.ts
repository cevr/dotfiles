import { Console, Effect } from "effect"
import { pinDiff, pinnedRed } from "./known-red.ts"
import { type Fingerprint, formatInvariants } from "./property.ts"

/** What one acceptance check found: its red set by job name, and the report lines of its reds ("" when green). */
export interface CheckResult {
  readonly fingerprint: Fingerprint
  readonly report: string
}

const resultLine = (key: string, result: CheckResult): string => {
  const jobs = Object.keys(result.fingerprint)
  if (jobs.length === 0) return `SIM-RESULT ${key} red=false`
  return `SIM-RESULT ${key} red=true jobs=${jobs.length} ${jobs.map((job) => `${job}${formatInvariants(result.fingerprint[job] ?? [])}`).join(" ")}`
}

/** The red set as one JSON line, jobs sorted (job names hold no quotes), for the pins generator. */
const pinLine = (fingerprint: Fingerprint): string =>
  `{${Object.keys(fingerprint)
    .sort()
    .map((job) => `"${job}":[${(fingerprint[job] ?? []).join(",")}]`)
    .join(",")}}`

/**
 * The body of one acceptance check, as a function bun can run (SPEC v2 ruling 7). It runs the check, prints
 * its verdict, its red set as a SIM-PIN line and its report, and passes only when the red set equals the
 * check's pin in KNOWN_RED_AT_BASE exactly (an empty pin: green). A red outside the pin, a pinned job that
 * broke a different invariant, or a pinned job that turned green fails the check; so does a timeout, since
 * the check is a plain test.
 */
export const pinnedRunner = (key: string, body: Effect.Effect<CheckResult>) => (): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* body
      const diff = pinDiff(pinnedRed(key), result.fingerprint)
      yield* Console.log([resultLine(key, result), `SIM-PIN ${key} ${pinLine(result.fingerprint)}`, result.report].join("\n"))
      if (diff.length === 0) return
      return yield* Effect.die(`${key} does not match its pin (sim/known-red.ts):\n  ${diff.join("\n  ")}\n${result.report}`)
    }),
  )
