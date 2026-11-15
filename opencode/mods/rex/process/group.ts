// A program the viewer runs for one shot (a headless browser, `xcrun simctl`,
// `ssh` to the Mac), in a process group of its own: when the run is
// interrupted before the program ends (Ctrl-C, the pane closing), the whole
// group is killed, helpers too, so a shot in flight leaves nothing behind.
import { Effect, Option } from "effect"

/** A finished run: its exit code (none when a signal ended it), what it wrote to stdout, and its last words on stderr. */
export interface Ran {
  readonly code: Option.Option<number>
  readonly out: Uint8Array
  readonly err: string
}

/** Runs `argv` to its end (killed after `timeoutMs`), its group killed if interrupted first; fails with why when it cannot start. */
export const runGroup = (argv: ReadonlyArray<string>, timeoutMs: number): Effect.Effect<Ran, string> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () => Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL", detached: true }),
          catch: (cause) => String(cause),
        }),
        (running) =>
          Effect.sync(() => {
            if (Option.isSome(Option.fromNullishOr(running.exitCode)) || Option.isSome(Option.fromNullishOr(running.signalCode))) return
            // The group this run started: its leader is the program itself.
            Option.liftThrowable(() => process.kill(-running.pid, "SIGKILL"))()
          }),
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
