import { Effect, Option } from "effect"
import { type AdmissionUnavailable } from "../admission.ts"
import { SCOPE_PROBE } from "../launcher.ts"

/** How long the user-scope probe may take. A loaded host (the workbox at
 * load 18) answers `systemd-run --user --scope true` in well under a
 * second; three seconds leaves room, and a probe that takes longer is
 * reported as timed out, never as an absent user manager. */
export const SCOPE_PROBE_TIMEOUT_MS = 3000
/** What the probe found: a user scope; none, with the probe's failure (a
 * caller with no user manager on its bus); or no answer in time. */
export type ScopeProbe =
  | { readonly kind: "scope" }
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "timed-out"; readonly afterMs: number }

/** Ask `systemd-run --user --scope true` through `run`, bounded by
 * `timeoutMs`: an answer is a scope, a failure is none with its detail, no
 * answer in time is timed out. `run` is the seam a slow-helper test fakes. */
export const probeScope = (run: (argv: ReadonlyArray<string>) => Effect.Effect<string, AdmissionUnavailable>, timeoutMs = SCOPE_PROBE_TIMEOUT_MS) =>
  run(["/usr/bin/systemd-run", ...SCOPE_PROBE.slice(1)]).pipe(
    Effect.as<ScopeProbe>({ kind: "scope" }),
    Effect.catchTag("AdmissionUnavailable", ({ detail }) =>
      Effect.succeed<ScopeProbe>({ kind: "none", why: Option.getOrElse(Option.fromNullishOr(detail), () => "systemd-run --user --scope failed") })),
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.getOrElse((): ScopeProbe => ({ kind: "timed-out", afterMs: timeoutMs }))),
  )
