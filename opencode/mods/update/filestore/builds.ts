import { spawn, readableStreamToText } from "bun"
import { readdir, readlink, stat, unlink } from "node:fs/promises"
import { Effect, Layer, Option } from "effect"
import { prunable } from "../builds.ts"
import type { Record } from "../record.ts"
import { Builds, type Pruned, UpdateFailed } from "../service.ts"

/** Where the builds are and how this host lists the executables its processes run. */
export interface Options {
  /** The share directory daily copies each build into (`settings.ts` `shareDir`). */
  readonly share: string
  readonly platform: string
  /** Linux's process directory, whose `<pid>/exe` links name each process's executable. */
  readonly proc: string
  /** macOS's process list: each line a running executable's path (`ps -axo comm=`). */
  readonly ps: ReadonlyArray<string>
}

/** The options of this host: `~/.local/share/opencode-prime`, `/proc` on Linux, `ps` elsewhere. */
export const optionsOf = (share: string, platform: string): Options => ({ share, platform, proc: "/proc", ps: ["ps", "-axo", "comm="] })

const failed = (step: string) => (cause: unknown) => new UpdateFailed({ step, message: String(cause) })

/**
 * The executables of the running processes, by path, on Linux: each `/proc/<pid>/exe` link this
 * user may read. A process of another user, or one that ended meanwhile, has none to read. It
 * fails when the process directory does not list, or this process's own link (`self/exe`) does not
 * read: then no link may read (a `hidepid` mount, a sandbox), and a build that runs could go.
 */
const linuxRunning = (proc: string) =>
  Effect.tryPromise({ try: () => readlink(`${proc}/self/exe`), catch: failed("read this process's executable") }).pipe(
    Effect.andThen(Effect.tryPromise({ try: () => readdir(proc), catch: failed("list the running processes") })),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries.filter((entry) => /^\d+$/.test(entry)),
        (pid) => Effect.tryPromise(() => readlink(`${proc}/${pid}/exe`)).pipe(Effect.map(Option.some), Effect.orElseSucceed(() => Option.none<string>())),
        { concurrency: 16 },
      ),
    ),
    Effect.map((links) => links.flatMap(Option.toArray)),
  )

/** The executables of the running processes, by path, elsewhere: `ps`'s list, which must exit 0. */
const psRunning = (argv: ReadonlyArray<string>) =>
  Effect.try({ try: () => spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }), catch: failed("list the running processes") }).pipe(
    Effect.flatMap((child) =>
      Effect.all({
        code: Effect.tryPromise({ try: () => child.exited, catch: failed("list the running processes") }),
        out: Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: failed("list the running processes") }),
      }),
    ),
    Effect.filterOrFail(
      (ran) => ran.code === 0,
      (ran) => new UpdateFailed({ step: "list the running processes", message: `${argv.join(" ")} exited ${ran.code}` }),
    ),
    Effect.map((ran) => ran.out.split("\n").map((line) => line.trim()).filter((line) => line !== "")),
  )

/** Deletes one build, answering its size. */
const removeBuild = (share: string, name: string) =>
  Effect.tryPromise({ try: () => stat(`${share}/${name}`), catch: failed(`size ${name}`) }).pipe(
    Effect.flatMap((info) => Effect.tryPromise({ try: () => unlink(`${share}/${name}`), catch: failed(`delete ${name}`) }).pipe(Effect.as<Pruned>({ name, bytes: info.size }))),
  )

/** The executables of the running processes, by path: `/proc` on Linux, `ps` elsewhere. */
export const runningOf = (options: Options) =>
  Option.match(Option.liftPredicate(options.platform, (platform) => platform === "linux"), {
    onSome: () => linuxRunning(options.proc),
    onNone: () => psRunning(options.ps),
  })

/** The builds a prune would delete now, deleting nothing: for a dry run. */
export const wouldPrune = (options: Options, record: Record) =>
  Effect.all({ paths: runningOf(options), names: Effect.tryPromise({ try: () => readdir(options.share), catch: failed("list the builds") }) }).pipe(
    Effect.map(({ paths, names }) => prunable(names, record, Option.some(paths))),
  )

/**
 * The Builds over the share directory. The running executables are read first; when they do not
 * read, the prune fails and deletes nothing (`builds.ts` `prunable`).
 */
export const layer = (options: Options) => {
  const running = runningOf(options)
  const prune = Effect.fn("Builds.prune")(function* (record: Record) {
    const paths = yield* running
    const names = yield* Effect.tryPromise({ try: () => readdir(options.share), catch: failed("list the builds") })
    return yield* Effect.forEach(prunable(names, record, Option.some(paths)), (name) => removeBuild(options.share, name))
  })
  return Layer.succeed(Builds, Builds.of({ prune }))
}
