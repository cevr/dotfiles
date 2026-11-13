// Checkouts over child processes, the same on macOS and Linux: `git` names a
// directory's checkout and its origin; `df -P` names the mount the checkout
// sits on and `mount` that mount's file system type; `workrift sources` (on
// the workbox, where it is on PATH) lists Rift's warm sources. A directory no
// checkout holds, or one that does not exist, is none; any other failure to
// read is CheckoutUnknown, so the guard refuses rather than guess.
import { env as processEnv, readableStreamToText, spawn, which } from "bun"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { type Checkout, CheckoutUnknown, Checkouts, type WarmSource } from "../service.ts"

/** A finished command: its exit code and what it printed. */
interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** The mount point `df -P` names for a path: the last line's sixth field on, which may hold spaces. */
export const mountPointOf = (df: string): Option.Option<string> => {
  const fields = Option.getOrElse(Arr.last(df.trim().split("\n")), () => "")
    .trim()
    .split(/\s+/)
  if (fields.length < 6) return Option.none()
  return Option.some(fields.slice(5).join(" "))
}

/** One `mount` line's mount point and type: Linux's `<device> on <point> type <type> (<options>)`, macOS's `<device> on <point> (<type>, <options>)`. */
const mountOf = (line: string): Option.Option<readonly [string, string]> =>
  Option.map(Option.fromNullishOr(/ on (.+) type (\S+) \(/.exec(line) ?? / on (.+) \(([^,)]+)[,)]/.exec(line)), (match) => [match[1] ?? "", match[2] ?? ""] as const)

/** Whether the mount at `at` holds `point`: it is `point`, or a directory above it. */
const holds = (at: string, point: string) => at === point || at === "/" || point.startsWith(`${at}/`)

/**
 * The file system type `mount` lists for the mount point, else for the nearest mount above it: df names a btrfs
 * subvolume (the workbox's `/workspaces/ergo`) as a mount point that `mount` does not list. The last line for a point
 * wins, as the last mount over it does.
 */
export const filesystemOf = (mounts: string, point: string): Option.Option<string> => {
  const holding = Arr.flatMap(mounts.split("\n"), (line) => Option.toArray(Option.filter(mountOf(line), ([at]) => holds(at, point))))
  const nearest = Arr.reduce(holding, 0, (deepest, [at]) => Math.max(deepest, at.length))
  return Option.map(
    Arr.findLast(holding, ([at]) => at.length === nearest),
    ([, type]) => type,
  )
}

export interface Options {
  /** The `workrift` to list warm sources with: a name on PATH or a path. None found, no warm sources. */
  readonly workrift: string
  /** The commands' environment. */
  readonly env: Readonly<Record<string, string>>
}

/** This process's environment, its unset entries left out. */
const ownEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(processEnv).flatMap(([key, value]) => Option.toArray(Option.fromNullishOr(value)).map((text) => [key, text] as const)))

/** Checkouts read with `git`, `df` and `mount`; warm sources from `workrift` (by default the one on PATH, in this process's environment). */
export const layer = (options: Partial<Options> = {}) => {
  const env = options.env ?? ownEnv()
  const workrift = options.workrift ?? "workrift"

  /** Runs `argv` to its end; fails only when it cannot start. */
  const run = (path: string, argv: ReadonlyArray<string>): Effect.Effect<Ran, CheckoutUnknown> => {
    const failed = (cause: unknown) => new CheckoutUnknown({ path, message: `\`${argv.join(" ")}\` could not run: ${String(cause)}` })
    return Effect.try({ try: () => spawn([...argv], { env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), catch: failed }).pipe(
      Effect.flatMap((child) =>
        Effect.all(
          {
            code: Effect.tryPromise({ try: () => child.exited, catch: failed }),
            out: Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: failed }),
            err: Effect.tryPromise({ try: () => readableStreamToText(child.stderr), catch: failed }).pipe(Effect.map((text) => text.trim())),
          },
          { concurrency: 3 },
        ).pipe(Effect.onInterrupt(() => Effect.sync(() => child.kill()))),
      ),
    )
  }

  /** Runs `argv` and answers its stdout, trimmed; a nonzero exit is CheckoutUnknown. */
  const read = (path: string, argv: ReadonlyArray<string>) =>
    run(path, argv).pipe(
      Effect.flatMap((ran) => {
        if (ran.code === 0) return Effect.succeed(ran.out.trim())
        return Effect.fail(new CheckoutUnknown({ path, message: `\`${argv.join(" ")}\` exited ${ran.code}: ${ran.err}` }))
      }),
    )

  /** A checkout's origin URL; none when it has no origin. */
  const origin = (path: string) =>
    run(path, ["git", "-C", path, "remote", "get-url", "origin"]).pipe(
      Effect.map((ran) => Option.filter(Option.some(ran.out.trim()), (url) => ran.code === 0 && url !== "")),
    )

  /** The type of the file system `root` sits on. */
  const filesystem = Effect.fn("Checkouts.filesystem")(function* (root: string) {
    const point = mountPointOf(yield* read(root, ["df", "-P", root]))
    if (Option.isNone(point)) return yield* new CheckoutUnknown({ path: root, message: "df named no mount point" })
    const type = filesystemOf(yield* read(root, ["mount"]), point.value)
    if (Option.isNone(type)) return yield* new CheckoutUnknown({ path: root, message: `mount lists no file system at ${point.value}` })
    return type.value
  })

  return Layer.succeed(
    Checkouts,
    Checkouts.of({
      of: Effect.fn("Checkouts.of")(function* (directory: string) {
        const top = yield* run(directory, ["git", "-C", directory, "rev-parse", "--show-toplevel"])
        // git says so of a directory in no checkout, and of one that does not exist.
        if (top.code !== 0 && /not a git repository|cannot change to/i.test(top.err)) return Option.none<Checkout>()
        if (top.code !== 0) return yield* new CheckoutUnknown({ path: directory, message: `git rev-parse exited ${top.code}: ${top.err}` })
        const root = top.out.trim()
        return Option.some<Checkout>({ root, filesystem: yield* filesystem(root), origin: yield* origin(root) })
      }),
      warmSources: Effect.gen(function* () {
        const found = Option.fromNullishOr(which(workrift, { PATH: env["PATH"] ?? "" }))
        if (Option.isNone(found)) return []
        const paths = (yield* read("workrift sources", [found.value, "sources"])).split("\n").filter((line) => line.trim() !== "")
        return yield* Effect.forEach(paths, (path) => origin(path).pipe(Effect.map((url): WarmSource => ({ path, origin: url }))), { concurrency: 4 })
      }),
    }),
  )
}
