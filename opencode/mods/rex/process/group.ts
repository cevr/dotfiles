// A program the viewer runs (a headless browser, `xcrun simctl`, `ssh` to
// the Mac), in a process group of its own: when its scope closes before the
// program ends (a run interrupted by Ctrl-C or the pane closing, a live tab
// left), the whole group is killed, helpers too, so nothing is left behind.
import { Effect, Option, type Scope } from "effect"

/** A finished run: its exit code (none when a signal ended it), what it wrote to stdout, and its last words on stderr. */
export interface Ran {
  readonly code: Option.Option<number>
  readonly out: Uint8Array
  readonly err: string
}

/** Kills `running`'s group unless it has ended. */
const killGroup = (running: Bun.Subprocess) =>
  Effect.sync(() => {
    if (Option.isSome(Option.fromNullishOr(running.exitCode)) || Option.isSome(Option.fromNullishOr(running.signalCode))) return
    // The group this run started: its leader is the program itself.
    Option.liftThrowable(() => process.kill(-running.pid, "SIGKILL"))()
  })

/** Starts `argv` in a group of its own, its output dropped, for as long as the scope lasts: the group is killed when the scope closes; fails with why when it cannot start. */
export const keepGroup = (argv: ReadonlyArray<string>): Effect.Effect<Bun.Subprocess<"ignore", "ignore", "ignore">, string, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({ try: () => Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }), catch: (cause) => String(cause) }),
    killGroup,
  )

/** Runs `argv` to its end (killed after `timeoutMs`), its group killed if interrupted first; fails with why when it cannot start. */
export const runGroup = (argv: ReadonlyArray<string>, timeoutMs: number): Effect.Effect<Ran, string> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () => Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL", detached: true }),
          catch: (cause) => String(cause),
        }),
        killGroup,
      )
      const [out, err, code] = yield* Effect.all(
        [
          Effect.promise(() => new Response(child.stdout).arrayBuffer()),
          Effect.promise(() => new Response(child.stderr).text()),
          Effect.promise(() => child.exited),
        ],
        { concurrency: 3 },
      )
      return { code: Option.filter(Option.some(code), () => Option.isNone(Option.fromNullishOr(child.signalCode))), out: new Uint8Array(out), err: err.trim() }
    }),
  )

/** The last line of `text`, for an error line. */
export const lastLine = (text: string): string => Option.getOrElse(Option.fromUndefinedOr(text.trim().split("\n").at(-1)), () => "")
