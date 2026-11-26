import { Console, Effect } from "effect"
import { pinDiff, pinnedRed } from "./known-red.ts"
import { type Fingerprint, formatInvariants, invariantsOfSignatures } from "./property.ts"

/** What one acceptance check found: its red set by job name, and the report lines of its reds ("" when green). */
export interface CheckResult {
  readonly fingerprint: Fingerprint
  readonly report: string
}

const resultLine = (key: string, result: CheckResult): string => {
  const jobs = Object.keys(result.fingerprint)
  if (jobs.length === 0) return `SIM-RESULT ${key} red=false`
  return `SIM-RESULT ${key} red=true jobs=${jobs.length} ${jobs.map((job) => `${job}${formatInvariants(invariantsOfSignatures(result.fingerprint[job] ?? []))}`).join(" ")}`
}

/** The red set as tab-separated lines, one per (job, signature), for the pins generator. */
const signatureLines = (key: string, fingerprint: Fingerprint): ReadonlyArray<string> =>
  Object.keys(fingerprint)
    .sort()
    .flatMap((job) => (fingerprint[job] ?? []).map((signature) => `SIM-SIG\t${key}\t${job}\t${signature}`))

/**
 * The body of one acceptance check, as a function bun can run (SPEC v2 ruling 7, widened). It runs the check,
 * prints its verdict, its red set as SIM-SIG lines and its report, and passes only when every job's set of
 * violation signatures equals the check's pin in sim/pins.ts exactly (no pin: green). A signature outside the
 * pin, a pinned signature that is missing, or a pinned job that turned green fails the check; so does a
 * timeout, since the check is a plain test.
 */
export const pinnedRunner = (key: string, body: Effect.Effect<CheckResult>) => (): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* body
      const diff = pinDiff(pinnedRed(key), result.fingerprint)
      yield* Console.log([resultLine(key, result), ...signatureLines(key, result.fingerprint), result.report].join("\n"))
      if (diff.length === 0) return
      return yield* Effect.die(`${key} does not match its pin (sim/pins.ts):\n  ${diff.join("\n  ")}\n${result.report}`)
    }),
  )
