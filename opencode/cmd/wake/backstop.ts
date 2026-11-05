/**
 * The OS job's script: what a wake's Bun.cron job runs when it fires. Each
 * job's entry file (`<state>/opencode-wake/jobs/opencode-wake-<id>.ts`,
 * written by `@dotfiles/opencode-wake/cron/backstop`) calls `scheduled` with
 * its descriptor. It reaches the OpenCode service, starting it when none
 * answers, and asks the entry's server to fire it (`@dotfiles/opencode-wake/cron/fire`);
 * the server delivers and removes the job. Each run appends one line to
 * `<state>/opencode-wake/backstop.log`.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { Descriptor } from "@dotfiles/opencode-wake/backstop"
import { fire, live } from "@dotfiles/opencode-wake/cron/fire"

/** Where the runs are logged, in the state directory the descriptor names. */
export const logOf = (descriptor: Descriptor): string =>
  path.join(descriptor.env.XDG_STATE_HOME ?? path.join(descriptor.env.HOME ?? "", ".local", "state"), "opencode-wake", "backstop.log")

const log = (descriptor: Descriptor, line: string) =>
  Effect.sync(() => {
    const file = logOf(descriptor)
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${descriptor.title} ${line}\n`)
  }).pipe(Effect.ignore)

export const scheduled = (descriptor: Descriptor): Promise<void> =>
  Effect.runPromise(
    fire(descriptor, live).pipe(
      Effect.matchEffect({
        onSuccess: (report) => log(descriptor, `${report.outcome}${report.started ? " (started the service)" : ""} via ${report.url}`),
        onFailure: (failure) => log(descriptor, `unreached: ${failure.message}`),
      }),
    ),
  )
