// Child processes as the process implementations run them: a command's exit
// code and output, or a RiftFailed carrying what it printed.
import { Effect, Exit } from "effect"
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

/** Kills the process group `leader` leads, the one a spawn made; nothing when it has already ended. */
const killGroup = (leader: number) =>
  Effect.try({
    try: () => process.kill(-leader, "SIGKILL"),
    catch: () => "the group has ended",
  }).pipe(Effect.ignore)

/** Runs commands with `env` added to this process's environment. */
export const commands = (env: Readonly<Record<string, string>> = {}) => {
  const base = { ...process.env, ...env }

  /**
   * Runs `argv` in `cwd`, in a process group of its own; never fails on its exit code, so a caller can read
   * it. An interrupt kills the whole group: a check's command runs inside `nice` and two shells, and only
   * the group reaches it.
   */
  const spawn = (argv: ReadonlyArray<string>, cwd: string, extra: Readonly<Record<string, string>> = {}) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => Bun.spawn([...argv], { cwd, env: { ...base, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }),
        catch: (cause) => new RiftFailed({ operation: argv.slice(0, 2).join(" "), message: cause instanceof Error ? cause.message : String(cause) }),
      }),
      (child) =>
        Effect.promise(async (): Promise<Ran> => {
          const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
          return { code: await child.exited, stdout, stderr }
        }),
      (child, exit) => Effect.when(killGroup(child.pid), Effect.sync(() => Exit.hasInterrupts(exit))),
    )

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
