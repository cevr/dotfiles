import { spawn, readableStreamToText } from "bun"
import { readdir, readlink, stat, unlink } from "node:fs/promises"
import { holdingIfFree } from "@dotfiles/opencode-rift/process/flock"
import { Array as Arr, Clock, Data, Duration, Effect, Layer, Match, Option, Schedule } from "effect"
import { FRESH_MS, isFresh, prunable } from "../builds.ts"
import type { Record } from "../record.ts"
import { Builds, type Pruned, UpdateFailed } from "../service.ts"

/** Where the builds are, how this host lists the executables its processes run, and the lock daily's stage shares. */
export interface Options {
  /** The share directory daily copies each build into (`settings.ts` `shareDir`). */
  readonly share: string
  /** The builds lock file (`settings.ts` `buildsLock`). */
  readonly lock: string
  /** How long a prune waits for daily's stage to drop the builds lock before it gives up, deleting nothing. */
  readonly lockWaitMs: number
  /** How recently changed a build stays, whatever the record says (`builds.ts` `FRESH_MS`). */
  readonly freshMs: number
  readonly platform: string
  /** Linux's process directory, whose `<pid>/exe` links name each process's executable. */
  readonly proc: string
  /** macOS's process list: each line a running executable's path (`ps -axo comm=`). */
  readonly ps: ReadonlyArray<string>
}

/** The options of this host: `/proc` on Linux, `ps` elsewhere, two minutes' wait for the lock. */
export const optionsOf = (share: string, lock: string, platform: string): Options => ({
  share,
  lock,
  lockWaitMs: 2 * 60 * 1000,
  freshMs: FRESH_MS,
  platform,
  proc: "/proc",
  ps: ["ps", "-axo", "comm="],
})

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

/**
 * Deletes one build, answering its size; none, leaving it, when it changed within `freshMs` of now
 * (`builds.ts` `isFresh`, by the newer of its mtime and ctime: a copy keeps its source's mtime, and a
 * rename moves only the ctime).
 */
const removeBuild = (share: string, name: string, freshMs: number) =>
  Effect.all({ info: Effect.tryPromise({ try: () => stat(`${share}/${name}`), catch: failed(`size ${name}`) }), now: Clock.currentTimeMillis }).pipe(
    Effect.flatMap(({ info, now }) =>
      Option.match(Option.liftPredicate(info, (each) => !isFresh(Math.max(each.mtimeMs, each.ctimeMs), now, freshMs)), {
        onNone: () => Effect.succeed(Option.none<Pruned>()),
        onSome: (old) => Effect.tryPromise({ try: () => unlink(`${share}/${name}`), catch: failed(`delete ${name}`) }).pipe(Effect.as(Option.some<Pruned>({ name, bytes: old.size }))),
      }),
    ),
  )

/** How long a prune waits between asks for the builds lock. */
const LOCK_PAUSE = Duration.millis(250)

/** The lock is held by another holder still. */
class Busy extends Data.TaggedError("Busy")<{}> {}

/**
 * Runs `effect` holding the builds lock (`settings.ts` `buildsLock`) exclusively, asking again every
 * `LOCK_PAUSE` while another holder (daily's stage) has it, for `waitMs` at most; then it fails,
 * running nothing.
 */
const underLock = <A>(file: string, waitMs: number, effect: Effect.Effect<A, UpdateFailed>): Effect.Effect<A, UpdateFailed> =>
  holdingIfFree(file, effect).pipe(
    Effect.mapError((error) => Match.value(error).pipe(Match.tag("RiftFailed", (rift) => new UpdateFailed({ step: "take the builds lock", message: rift.message })), Match.orElse((each) => each))),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Busy()), onSome: Effect.succeed })),
    Effect.retry({ while: (error) => error._tag === "Busy", schedule: Schedule.spaced(LOCK_PAUSE), times: Math.ceil(waitMs / Duration.toMillis(LOCK_PAUSE)) }),
    Effect.catchTag("Busy", () => Effect.fail(new UpdateFailed({ step: "take the builds lock", message: `${file} stayed held for ${waitMs} ms` }))),
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
 * The Builds over the share directory. Under the builds lock, the record is read, then the running
 * executables, then the directory: when what runs does not read, the prune fails and deletes nothing
 * (`builds.ts` `prunable`).
 */
export const layer = (options: Options) => {
  const running = runningOf(options)
  const prune = (read: Effect.Effect<Option.Option<Record>>) =>
    underLock(
      options.lock,
      options.lockWaitMs,
      Effect.gen(function* () {
        const record = yield* read
        if (Option.isNone(record)) return []
        const paths = yield* running
        const names = yield* Effect.tryPromise({ try: () => readdir(options.share), catch: failed("list the builds") })
        const removed = yield* Effect.forEach(prunable(names, record.value, Option.some(paths)), (name) => removeBuild(options.share, name, options.freshMs))
        return Arr.getSomes(removed)
      }),
    ).pipe(Effect.withSpan("Builds.prune"))
  return Layer.succeed(Builds, Builds.of({ prune }))
}
