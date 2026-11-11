// The fleet install as a process: the dotfiles' `scripts/fleet-install.ts request`, which records
// the request and starts the install outside this server (a one-shot launchd job on the Mac, the
// Mac's over ssh from another host) and exits. With no script (the option unset: a test, a host
// outside the owner's fleet) nothing is asked.
import { Effect, Layer } from "effect"
import { Installs } from "../service.ts"

/** The request has this long: it appends a line and starts a job, or forwards it over ssh. */
const TIMEOUT_MS = 60_000

/**
 * Runs `script request --reason <reason>` and waits for it. The host's binary is Bun underneath,
 * so BUN_BE_BUN runs it as Bun. A request that fails or times out is lost; the next accepted
 * verdict, or the daily install, asks again.
 */
export const layer = (script: string | undefined) =>
  Layer.succeed(Installs, {
    request: (reason: string) =>
      script === undefined
        ? Effect.void
        : Effect.tryPromise(async () => {
            const child = Bun.spawn([process.execPath, script, "request", "--reason", reason], {
              env: { ...process.env, BUN_BE_BUN: "1" },
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              timeout: TIMEOUT_MS,
            })
            await child.exited
          }).pipe(Effect.ignore, Effect.withSpan("Installs.request")),
  })
