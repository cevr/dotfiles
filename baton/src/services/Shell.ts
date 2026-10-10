// Runs a command to completion and keeps what it printed: the one way baton
// reaches herdr and git.
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export type Ran = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }

export class ShellError extends Schema.TaggedError<ShellError>()("ShellError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `could not run ${this.command}: ${String(this.cause)}`
  }
}

export interface ShellService {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    cwd?: string,
  ) => Effect.Effect<Ran, ShellError>
}

const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.mkString(Stream.decodeText(stream))

export class Shell extends Context.Service<Shell, ShellService>()("baton/src/services/Shell") {
  static layer: Layer.Layer<Shell, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
    Shell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = Effect.fn("Shell.run")(
        function* (command: string, args: ReadonlyArray<string>, cwd?: string) {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, [...args], { cwd, forceKillAfter: "5 seconds" }),
          )
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [text(handle.stdout), text(handle.stderr), handle.exitCode],
            { concurrency: 3 },
          )
          return { stdout, stderr, exitCode: Number(exitCode) }
        },
        Effect.scoped,
        (effect, command) =>
          Effect.mapError(effect, (cause) => ShellError.make({ command, cause })),
      )
      return Shell.of({ run })
    }),
  )
}
