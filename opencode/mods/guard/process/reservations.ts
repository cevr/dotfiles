// Reservations over Ergo's `work` binary: `work --json list`, run in the
// directory, names the base's records; those whose state is Creating and whose
// folder exists (asked of `sh`'s `[ -d ]`) are the workspaces being made. A
// directory in no base (work's NoBase) has none, and so does a host with no
// `work` on PATH, where `work gc` cannot run. Any other failure to read is
// ReservationsUnknown, so the guard refuses rather than guess.
import { env as processEnv, readableStreamToText, spawn, which } from "bun"
import { Effect, Layer, Option, Schema } from "effect"
import { type Reservation, Reservations, ReservationsUnknown } from "../service.ts"

/** What the guard reads of `work --json list`: each record's name, folder and state. */
const Records = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, state: Schema.Struct({ _tag: Schema.String }) })))
/** What a failed `work --json` call prints: its tag. */
const Failure = Schema.fromJsonString(Schema.Struct({ _tag: Schema.String }))

export interface Options {
  /** The `work` binary: a name on PATH or a path. */
  readonly work: string
  /** The commands' environment. */
  readonly env: Readonly<Record<string, string>>
}

/** A finished command: its exit code and what it printed, trimmed. */
interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** This process's environment, its unset entries left out. */
const ownEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(processEnv).flatMap(([key, value]) => Option.toArray(Option.fromNullishOr(value)).map((text) => [key, text] as const)))

/** Prints each argument that names a directory, one a line. */
const DIRECTORIES = 'for p; do [ -d "$p" ] && printf "%s\\n" "$p"; done; exit 0'

export const layer = (options: Partial<Options> = {}) => {
  const env = options.env ?? ownEnv()
  const work = options.work ?? "work"

  /** Runs `argv` in `cwd` to its end; fails only when it cannot start. */
  const run = (directory: string, cwd: string, argv: ReadonlyArray<string>): Effect.Effect<Ran, ReservationsUnknown> => {
    const failed = (cause: unknown) => new ReservationsUnknown({ directory, message: `\`${argv.join(" ")}\` could not run: ${String(cause)}` })
    return Effect.try({ try: () => spawn([...argv], { cwd, env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), catch: failed }).pipe(
      Effect.flatMap((child) =>
        Effect.all(
          {
            code: Effect.tryPromise({ try: () => child.exited, catch: failed }),
            out: Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: failed }).pipe(Effect.map((text) => text.trim())),
            err: Effect.tryPromise({ try: () => readableStreamToText(child.stderr), catch: failed }).pipe(Effect.map((text) => text.trim())),
          },
          { concurrency: 3 },
        ).pipe(Effect.onInterrupt(() => Effect.sync(() => child.kill()))),
      ),
    )
  }

  /** The `work` to run: a path as given, else the one on PATH; none when there is none. */
  const binary = Option.orElse(Option.liftPredicate(work, (named) => named.includes("/")), () => Option.fromNullishOr(which(work, { PATH: env["PATH"] ?? "" })))

  const of = Effect.fn("Reservations.of")(function* (directory: string) {
    const unknown = (message: string) => new ReservationsUnknown({ directory, message })
    if (Option.isNone(binary)) return []
    const ran = yield* run(directory, directory, [binary.value, "--json", "list"])
    if (ran.code !== 0) {
      if (Option.exists(Schema.decodeUnknownOption(Failure)(ran.out), (failure) => failure._tag === "NoBase")) return []
      return yield* unknown(`\`work --json list\` exited ${ran.code}: ${ran.err || ran.out}`)
    }
    const records = yield* Schema.decodeUnknownEffect(Records)(ran.out).pipe(Effect.mapError((error) => unknown(`its answer does not read: ${error.message}`)))
    const creating = records.filter((record) => record.state._tag === "Creating")
    if (creating.length === 0) return []
    const present = yield* run(directory, "/", ["/bin/sh", "-c", DIRECTORIES, "sh", ...creating.map((record) => record.path)])
    const folders = new Set(present.out.split("\n"))
    return creating.flatMap((record): ReadonlyArray<Reservation> => [{ name: record.name, path: record.path }].filter(() => folders.has(record.path)))
  })

  return Layer.succeed(Reservations, Reservations.of({ of }))
}
