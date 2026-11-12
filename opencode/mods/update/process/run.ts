import { env, readableStreamToText, spawn } from "bun"
import { Effect, Option } from "effect"
import { UpdateFailed } from "../service.ts"

/** A finished command: its exit code and what it printed. */
export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Where a command runs, and what it adds to this process's environment. */
export interface Place {
  readonly cwd: string
  readonly env: Readonly<globalThis.Record<string, string>>
}

/** This process's environment with `extra` over it. */
export const environment = (extra: Readonly<globalThis.Record<string, string>>): globalThis.Record<string, string> => {
  const base = Object.entries(env).flatMap(([key, value]) => Option.toArray(Option.fromNullishOr(value)).map((text) => [key, text] as const))
  return { ...Object.fromEntries(base), ...extra }
}

/** The last lines of what a command said, for a failure's message. */
export const said = (ran: Ran, lines = 20): string => {
  const text = [ran.stderr.trim(), ran.stdout.trim()].filter((part) => part !== "").join("\n")
  if (text === "") return `exit ${ran.code}`
  return text.split("\n").slice(-lines).join("\n")
}

/** Runs `argv`; never fails on its exit code, so the caller reads it. Interrupting it kills the command. */
export const spawned = (step: string, argv: ReadonlyArray<string>, place: Place): Effect.Effect<Ran, UpdateFailed> => {
  const failed = (cause: unknown) => new UpdateFailed({ step, message: String(cause) })
  return Effect.try({
    try: () => spawn([...argv], { cwd: place.cwd, env: environment(place.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
    catch: failed,
  }).pipe(
    Effect.flatMap((child) =>
      Effect.all(
        {
          code: Effect.tryPromise({ try: () => child.exited, catch: failed }),
          stdout: Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: failed }),
          stderr: Effect.tryPromise({ try: () => readableStreamToText(child.stderr), catch: failed }),
        },
        { concurrency: 3 },
      ).pipe(Effect.onInterrupt(() => Effect.sync(() => child.kill()))),
    ),
  )
}

/** Runs `argv` and answers its output, or fails with what it said. */
export const run = (step: string, argv: ReadonlyArray<string>, place: Place): Effect.Effect<string, UpdateFailed> =>
  spawned(step, argv, place).pipe(
    Effect.flatMap((ran) => {
      if (ran.code === 0) return Effect.succeed(ran.stdout)
      return Effect.fail(new UpdateFailed({ step, message: said(ran) }))
    }),
  )
