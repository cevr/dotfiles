// A monitor's checks as owned child processes. Each runs `/bin/sh -c <command>`
// in its own process group, with no stdin and the environment minus
// BASH_ENV and ENV, so no shell startup file runs; the whole group is killed
// when the check runs past its time or the caller is interrupted (a cancel, a
// deleted session, the plugin stopping). Each stream keeps its last
// OUTPUT_CAP characters.
import { Effect, Layer, Option } from "effect"
import { Checks } from "../service.ts"
import type { Check } from "../wake.ts"

/** The most characters a check keeps of each stream: the tail, where a result is printed. */
export const OUTPUT_CAP = 64 * 1024

/** The variables that make a shell read a startup file. */
export const STARTUP = ["BASH_ENV", "ENV"] as const

/** The environment a check runs in. */
export const environmentOf = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined || (STARTUP as ReadonlyArray<string>).includes(name) ? [] : [[name, value] as const])))

/** A stream's text, kept to its last `cap` characters. */
class Tail {
  private text = ""
  private readonly decoder = new TextDecoder()
  constructor(private readonly cap: number) {}
  push(chunk: Uint8Array) {
    this.text += this.decoder.decode(chunk, { stream: true })
    if (this.text.length > this.cap * 2) this.text = this.text.slice(-this.cap)
  }
  value(): string {
    return this.text.length > this.cap ? this.text.slice(-this.cap) : this.text
  }
}

const drain = async (stream: ReadableStream<Uint8Array>, tail: Tail): Promise<void> => {
  try {
    for await (const chunk of stream) tail.push(chunk)
  } catch {
    // The stream ended with the process; what was read stays.
  }
}

/** Kill the check's process group; one already gone is no failure. */
const killGroup = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // No such group: the check already ended.
    }
  })

const failed = (why: string): Check => ({ exitCode: 127, stdout: "", stderr: why, timedOut: false })

export const run = (command: string, cwd: string, timeoutMs: number, env: Readonly<Record<string, string | undefined>> = process.env, cap = OUTPUT_CAP) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn(["/bin/sh", "-c", command], { cwd, env: environmentOf(env), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.result),
    (spawned) => {
      if (spawned._tag === "Failure") return Effect.succeed(failed(`the check did not start in ${cwd}: ${spawned.failure}`))
      const child = spawned.success
      const stdout = new Tail(cap)
      const stderr = new Tail(cap)
      const drains = Promise.all([drain(child.stdout, stdout), drain(child.stderr, stderr)])
      // The command's exit ends the check: what it left running in the background goes with its group, which closes the pipes.
      const ended = child.exited.then(async (code) => {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          // The group is already empty.
        }
        await drains
        return code
      })
      return Effect.promise(() => ended).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map(
          (code): Check =>
            Option.isSome(code)
              ? { exitCode: code.value, stdout: stdout.value(), stderr: stderr.value(), timedOut: false }
              : { exitCode: -1, stdout: stdout.value(), stderr: stderr.value(), timedOut: true },
        ),
      )
    },
    (spawned) => (spawned._tag === "Success" ? killGroup(spawned.success.pid) : Effect.void),
  )

export const layer = Layer.succeed(Checks, { run: (command, cwd, timeoutMs) => run(command, cwd, timeoutMs) })
