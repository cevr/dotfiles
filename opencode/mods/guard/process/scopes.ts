// Scopes over `systemd-run`: on Linux, a scope is available when
// `systemd-run --user --scope --quiet --collect true` exits 0 (a user
// systemd with a reachable bus); asked once, on the first heavy command. On
// any other system there is none.
import { Effect, Layer } from "effect"
import { Scopes } from "../service.ts"

/** The probe's command line; `platform` and `run` are the machine's unless a test names them. */
export const PROBE = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "true"] as const

const runs = (argv: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    try {
      const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      return (await child.exited) === 0
    } catch {
      return false
    }
  })

export const layer = (platform: string = process.platform, probe: ReadonlyArray<string> = PROBE) =>
  Layer.effect(
    Scopes,
    Effect.gen(function* () {
      const available = yield* Effect.cached(platform === "linux" ? runs(probe) : Effect.succeed(false))
      return Scopes.of({ available })
    }),
  )
