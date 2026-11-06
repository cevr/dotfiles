// Child processes as the process implementations run them: a command's exit
// code and output, or a RiftFailed carrying what it printed.
import { Effect } from "effect"
import { RiftFailed } from "../service.ts"

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The non-empty lines of `text`, trailing space dropped. */
export const lines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")

/** Runs commands with `env` added to this process's environment. */
export const commands = (env: Readonly<Record<string, string>> = {}) => {
  const base = { ...process.env, ...env }

  /** Runs `argv` in `cwd`; never fails on its exit code, so a caller can read it. An interrupt kills it. */
  const spawn = (argv: ReadonlyArray<string>, cwd: string, extra: Readonly<Record<string, string>> = {}) =>
    Effect.tryPromise({
      try: async (signal): Promise<Ran> => {
        const child = Bun.spawn([...argv], { cwd, env: { ...base, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal })
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        return { code: await child.exited, stdout, stderr }
      },
      catch: (cause) => new RiftFailed({ operation: argv.slice(0, 2).join(" "), message: cause instanceof Error ? cause.message : String(cause) }),
    })

  /** Runs `argv` and answers its output, or fails with what it said. */
  const run = (argv: ReadonlyArray<string>, cwd: string, extra: Readonly<Record<string, string>> = {}) =>
    spawn(argv, cwd, extra).pipe(
      Effect.flatMap((ran) =>
        ran.code === 0
          ? Effect.succeed(ran.stdout)
          : Effect.fail(
              new RiftFailed({
                operation: argv.slice(0, 2).join(" "),
                message: (ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.code}`).split("\n").slice(-20).join("\n"),
              }),
            ),
      ),
    )

  return { spawn, run }
}
