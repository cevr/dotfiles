import { spawn, readableStreamToText } from "bun"
import { chmod, lstat, readdir, readFile, readlink, rm, stat, unlink } from "node:fs/promises"
import { holdingIfFree } from "@dotfiles/opencode-work/process/flock"
import { Array as Arr, Clock, Data, Duration, Effect, Layer, Match, Option, Schedule } from "effect"
import { FRESH_MS, isBuild, isFresh, oldFormat, prunable, type Running } from "../builds.ts"
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
  /** Linux's process directory, whose `<pid>/exe` links name each process's executable and `<pid>/cmdline` its arguments. */
  readonly proc: string
  /** macOS's process list: each line a running executable's path (`ps -axo comm=`). */
  readonly ps: ReadonlyArray<string>
  /** macOS's command lines: each line a running process's whole command line (`ps -axww -o args=`). */
  readonly psArgs: ReadonlyArray<string>
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
  psArgs: ["ps", "-axww", "-o", "args="],
})

const failed = (step: string) => (cause: unknown) => new UpdateFailed({ step, message: String(cause) })

/** Each numbered entry of `proc` read with `read`; an entry that does not read (another user's, or one that ended) is left out. */
const perProcess = (entries: ReadonlyArray<string>, read: (pid: string) => Promise<string>) =>
  Effect.forEach(
    entries.filter((entry) => /^\d+$/.test(entry)),
    (pid) => Effect.tryPromise(() => read(pid)).pipe(Effect.map(Option.some), Effect.orElseSucceed(() => Option.none<string>())),
    { concurrency: 16 },
  ).pipe(Effect.map((reads) => reads.flatMap(Option.toArray)))

/**
 * What runs, on Linux: each `/proc/<pid>/exe` link and `/proc/<pid>/cmdline` this user may read (its
 * arguments, NUL-separated, joined by spaces). A process of another user, or one that ended meanwhile,
 * has none to read. It fails when the process directory does not list, or this process's own link
 * (`self/exe`) does not read: then no link may read (a `hidepid` mount, a sandbox), and a build that
 * runs could go.
 */
const linuxRunning = (proc: string): Effect.Effect<Running, UpdateFailed> =>
  Effect.tryPromise({ try: () => readlink(`${proc}/self/exe`), catch: failed("read this process's executable") }).pipe(
    Effect.andThen(Effect.tryPromise({ try: () => readdir(proc), catch: failed("list the running processes") })),
    Effect.flatMap((entries) =>
      Effect.all({
        executables: perProcess(entries, (pid) => readlink(`${proc}/${pid}/exe`)),
        commands: perProcess(entries, (pid) => readFile(`${proc}/${pid}/cmdline`, "utf8")).pipe(Effect.map((lines) => lines.map((text) => text.split("\0").join(" ").trim()))),
      }),
    ),
  )

/** The lines a command prints, which must exit 0. */
const linesOf = (argv: ReadonlyArray<string>) =>
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

/** What runs, elsewhere: `ps`'s executables and its command lines, both of which must read. */
const psRunning = (argv: ReadonlyArray<string>, args: ReadonlyArray<string>): Effect.Effect<Running, UpdateFailed> => Effect.all({ executables: linesOf(argv), commands: linesOf(args) })

/** The entries of directory `path`, by name. */
const entriesOf = (path: string, step: string) => Effect.tryPromise({ try: () => readdir(path), catch: failed(step) })

/** Every file under `path` (a link as itself, never followed), with its size: a tree's bytes. */
const bytesUnder = (path: string): Effect.Effect<number, UpdateFailed> =>
  Effect.tryPromise({ try: () => lstat(path), catch: failed(`size ${path}`) }).pipe(
    Effect.flatMap((info) => {
      if (!info.isDirectory()) return Effect.succeed(info.size)
      return entriesOf(path, `size ${path}`).pipe(
        Effect.flatMap((names) => Effect.forEach(names, (name) => bytesUnder(`${path}/${name}`), { concurrency: 8 })),
        Effect.map((sizes) => sizes.reduce((sum, size) => sum + size, info.size)),
      )
    }),
  )

/**
 * Gives back the write permission a tree's seal took (`filestore/trees.ts`), on its directories only
 * and never in a `node_modules`, which the seal left as it was: deleting a file needs its directory
 * writable, not the file.
 */
const unseal = (path: string): Effect.Effect<void, UpdateFailed> =>
  Effect.tryPromise({ try: () => lstat(path), catch: failed(`unseal ${path}`) }).pipe(
    Effect.flatMap((info) => {
      if (!info.isDirectory()) return Effect.void
      return Effect.tryPromise({ try: () => chmod(path, info.mode | 0o700), catch: failed(`unseal ${path}`) }).pipe(
        Effect.andThen(entriesOf(path, `unseal ${path}`)),
        Effect.flatMap((names) => Effect.forEach(names.filter((name) => name !== "node_modules"), (name) => unseal(`${path}/${name}`), { discard: true })),
      )
    }),
  )

/** Deletes one entry, a build file or a tree, answering what it held. */
const removeEntry = (path: string, name: string): Effect.Effect<number, UpdateFailed> =>
  Effect.tryPromise({ try: () => lstat(path), catch: failed(`size ${name}`) }).pipe(
    Effect.flatMap((info) => {
      if (!info.isDirectory()) return Effect.tryPromise({ try: () => unlink(path), catch: failed(`delete ${name}`) }).pipe(Effect.as(info.size))
      return bytesUnder(path).pipe(Effect.tap(() => unseal(path)), Effect.tap(() => Effect.tryPromise({ try: () => rm(path, { recursive: true }), catch: failed(`delete ${name}`) })))
    }),
  )

/** Deletes a tree in the making a failed make left (`filestore/trees.ts`), sealed or not; nothing when there is none. */
export const removeMaking = (path: string): Effect.Effect<void> => removeEntry(path, path).pipe(Effect.ignore)

/**
 * Deletes one build or tree, answering its size; none, leaving it, when it changed within `freshMs`
 * of now (`builds.ts` `isFresh`, by the newer of its mtime and ctime: a copy keeps its source's mtime,
 * and a rename or a seal moves only the ctime).
 */
const removeBuild = (share: string, name: string, freshMs: number) =>
  Effect.all({ info: Effect.tryPromise({ try: () => stat(`${share}/${name}`), catch: failed(`size ${name}`) }), now: Clock.currentTimeMillis }).pipe(
    Effect.flatMap(({ info, now }) =>
      Option.match(Option.liftPredicate(info, (each) => !isFresh(Math.max(each.mtimeMs, each.ctimeMs), now, freshMs)), {
        onNone: () => Effect.succeed(Option.none<Pruned>()),
        onSome: () => removeEntry(`${share}/${name}`, name).pipe(Effect.map((bytes) => Option.some<Pruned>({ name, bytes }))),
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

/** What runs: `/proc` on Linux, `ps` elsewhere. */
export const runningOf = (options: Options) =>
  Option.match(Option.liftPredicate(options.platform, (platform) => platform === "linux"), {
    onSome: () => linuxRunning(options.proc),
    onNone: () => psRunning(options.ps, options.psArgs),
  })

/** The builds and trees a prune would delete now, deleting nothing: for a dry run. */
export const wouldPrune = (options: Options, record: Record) =>
  Effect.all({ running: runningOf(options), names: Effect.tryPromise({ try: () => readdir(options.share), catch: failed("list the builds") }) }).pipe(
    Effect.map(({ running, names }) => prunable(names, record, Option.some(running))),
  )

/**
 * The Builds over the share directory. Under the builds lock, the record is read, then what runs,
 * then the directory: when what runs does not read, the prune fails and deletes nothing (`builds.ts`
 * `prunable`). Builds go first, then trees, so a tree never outlives the prune of its build.
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
        const now = yield* running
        const names = yield* Effect.tryPromise({ try: () => readdir(options.share), catch: failed("list the builds") })
        const doomed = prunable(names, record.value, Option.some(now))
        const removed = yield* Effect.forEach([...doomed.filter(isBuild), ...doomed.filter((name) => !isBuild(name))], (name) => removeBuild(options.share, name, options.freshMs))
        return Arr.getSomes(removed)
      }),
    ).pipe(Effect.withSpan("Builds.prune"))
  const oldRunning = Effect.all({ now: running, names: Effect.tryPromise({ try: () => readdir(options.share), catch: failed("list the builds") }) }).pipe(
    Effect.map(({ now, names }) => oldFormat(names, now.executables)),
  )
  return Layer.succeed(Builds, Builds.of({ prune, oldRunning }))
}
