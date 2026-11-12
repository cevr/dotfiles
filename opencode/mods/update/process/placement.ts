import { Effect, Layer, Option, Schedule } from "effect"
import { readText } from "../filestore/files.ts"
import { Placement, placementOf, placeArgv } from "../placement.ts"
import { Placer } from "../service.ts"
import { said, spawned } from "./run.ts"

/** The process a Placer places, and how: the running service's own (the plugin's), or a test's. */
export interface Options {
  /** The service's process id. */
  readonly pid: number
  readonly platform: string
  /** The process's `/proc` directory: its `cgroup`, and its `cmdline`, which names `--service` in the background service. */
  readonly proc: string
  /** The call that asks the user manager for the scope (`placeArgv`). */
  readonly argv: ReadonlyArray<string>
}

/** The options of process `pid` on `platform`. */
export const optionsOf = (pid: number, platform: string): Options => ({ pid, platform, proc: `/proc/${pid}`, argv: placeArgv(pid) })

/**
 * The Placer over `/proc` and the user manager's bus (`busctl`). Off Linux, or in a server that is
 * not the background service (`opencode serve --service`), nothing is placed: a throwaway server a
 * test starts stays where it is. A placement already done is not asked again, so each location's
 * copy of the plugin may ask.
 */
export const layer = (options: Options) => {
  const cgroup = `${options.proc}/cgroup`
  const observeWith = (cause: string) =>
    readText(cgroup).pipe(
      Effect.map(
        Option.match({
          onNone: () => Placement.cases.Unmanaged.make({ reason: `${cgroup} does not read` }),
          onSome: (text) => placementOf(options.pid, text, cause),
        }),
      ),
    )
  /** Why nothing is placed here, if so: another system, or a server that is not the background service. */
  const unmanaged = Effect.gen(function* () {
    if (options.platform !== "linux") return Option.some(`${options.platform} has no user systemd`)
    const cmdline = yield* readText(`${options.proc}/cmdline`)
    const service = Option.exists(cmdline, (text) => text.split("\0").includes("--service"))
    return Option.liftPredicate("this server is not the background service", () => !service)
  })
  const observe = Effect.flatMap(unmanaged, (reason) =>
    Option.match(reason, {
      onSome: (why) => Effect.succeed(Placement.cases.Unmanaged.make({ reason: why })),
      onNone: () => observeWith("it was not placed"),
    }),
  )
  const place = Effect.gen(function* () {
    const before = yield* observe
    if (!Placement.guards.Unplaced(before)) return before
    const asked = yield* spawned("place the service", options.argv, { cwd: "/", env: {} }).pipe(
      Effect.map((ran) => Option.liftPredicate(said(ran), () => ran.code !== 0)),
      Effect.catch((failed) => Effect.succeed(Option.some(failed.message))),
    )
    // The manager answers once it has queued the start, and moves the process just after.
    return yield* Option.match(asked, {
      onSome: observeWith,
      onNone: () =>
        observeWith("the user manager answered and the process is not in the scope after 2 s").pipe(
          Effect.repeat({ schedule: Schedule.spaced("50 millis"), times: 40, until: Placement.guards.Placed }),
        ),
    })
  })
  return Layer.succeed(Placer, Placer.of({ place, observe }))
}
