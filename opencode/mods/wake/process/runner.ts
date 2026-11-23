// Jobs as processes outside the OpenCode server. `launch` keeps the job's
// files in <root>/<id> (see supervise.ts) and starts its runner,
// `bun <script> <dir>`: under `systemd-run --user` on Linux, so a stop of the
// server's own unit leaves it running, and in its own session and process
// group elsewhere (and on a Linux whose user manager refuses), so the
// server's exit leaves it running. `read` takes the run from the files: an
// exit recorded is `ended`; a runner that claimed it and is still that process
// (its pid alive and started when its claim says) `running`; a claim whose
// runner is gone without an exit `lost`; never claimed `starting`; retired
// (its launch slot, `runner.json`, taken by the wakes' retirement before any
// runner's claim) `never-started`, and no runner runs it after. A kill
// signals only the claim's own runner, never a pid read alone. `watch` keeps
// one non-recursive watch on a live job's own directory and announces its exit
// file; the wakes close it once the end is delivered. `advance` takes the next
// slot of the job's delivery record (`delivery.<n>.json`) by an exclusive link,
// so of two writers in any location or process one wins; `.owed/<id>` lists
// the managed jobs whose record is not yet `delivered`. Every record write is
// durable (supervise.ts `writeDurable`).
import { type FSWatcher, readFileSync, watch, writeFileSync } from "node:fs"
import path from "node:path"
import { Clock, Effect, Layer, Match, Option, Schema } from "effect"
import type { Descriptor } from "../backstop.ts"
import { carried } from "../backstop.ts"
import { JobExit, type JobRecord, JobSpec, type Launched, NEVER_STARTED, type Run, unitOf } from "../job.ts"
import { type Exec } from "../cron/backstop.ts"
import { JobRefused, Runner } from "../service.ts"
import { Delivery, isJobID, LaunchClaim, type Retired, RunnerClaim, type Slot } from "../job-event.ts"
import { type Barrier, type Disk, FILES, type JobFile, makeDir, NODE_DISK, processStart, removeDurable, SELF, writeAtomic, writeDurable } from "./supervise.ts"

export interface Config {
  /** Where each job's directory is kept. */
  readonly root: string
  /** A real bun, by absolute path. */
  readonly bun: string
  /** The runner's entry (cmd/wake/job.ts), by absolute path. */
  readonly script: string
  readonly platform: NodeJS.Platform
  /** The environment a job runs in. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The `opencode` launcher the runner wakes the service with when the job ends; absent: the wakes' start or recovery sweep finds the end. */
  readonly opencode?: string | undefined
  readonly exec: Exec
  /** How a job's directory is watched; node's `fs.watch` by default (a test's stands in for a host out of watches). */
  readonly watch?: typeof watch
  /** The file system the job's record is written through and read from; the host's by default (a test's models a power loss). */
  readonly disk?: Disk
}

/** What `read` takes of job.json and launch.json. */
const Spec = Schema.Struct({ spec: JobSpec })
const Launch = Schema.Struct({ unit: Schema.optional(Schema.String) })

/** Whether `pid` is a live process. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The JSON file `file` holds, decoded by `schema`; none when it is missing or unreadable. */
const readJson = <A, I>(schema: Schema.Codec<A, I>, file: string, disk: Disk = NODE_DISK): Option.Option<A> =>
  Option.flatMap(disk.read(file), Schema.decodeUnknownOption(Schema.fromJsonString(schema)))

/**
 * Whether the claim's runner is still the process at its pid: alive, and started when the claim says (an older
 * runner's claim names no start, and its pid alone is taken). A start `ps` cannot read leaves it held: absence is not
 * proved, so it is not called lost.
 */
export const claimed = (claim: RunnerClaim, start: (pid: number) => Option.Option<string> = processStart): boolean =>
  alive(claim.pid) &&
  Option.match(Option.fromNullishOr(claim.start), {
    onNone: () => true,
    onSome: (then) => Option.match(start(claim.pid), { onNone: () => true, onSome: (now) => now === then }),
  })

/** This process as a server that runs owners' calls: its pid and its start, as `serverRuns` reads them back. */
export const serverHere = (): string => `${SELF}@${Option.getOrElse(processStart(SELF), () => "")}`

/** Whether the server `id` (a `serverHere`) still runs: its pid alive and started when the id says (a start not recorded, or one `ps` cannot read, leaves it running). */
export const serverRuns = (id: string, start: (pid: number) => Option.Option<string> = processStart): boolean => {
  const at = id.indexOf("@")
  const pid = Number(id.slice(0, at))
  if (at < 1 || !Number.isSafeInteger(pid) || pid < 2) return true
  const started = id.slice(at + 1)
  return claimed({ pid, startedAt: 0, ...Option.match(Option.liftPredicate(started, (each) => each !== ""), { onNone: () => ({}), onSome: (each) => ({ start: each }) }) }, start)
}

/** The run the files of `dir` record. */
export const runOf = (dir: string, disk: Disk = NODE_DISK): Run => {
  const ended = (exit: JobExit): Run => ({ state: "ended", exit })
  return Option.match(readJson(JobExit, path.join(dir, FILES.exit), disk), {
    onSome: ended,
    onNone: () =>
      Option.match(launchOf(dir, disk), {
        onNone: (): Run => ({ state: "starting" }),
        onSome: (slot): Run => {
          // Retired before any runner claimed it: it never started, and no runner runs it after.
          if ("retiredAt" in slot) return NEVER_STARTED
          const runner = slot
          return Match.value(claimed(runner)).pipe(
            Match.when(true, (): Run => ({ state: "running", startedAt: runner.startedAt })),
            // The exit may have landed between the two reads.
            Match.orElse(() =>
              Option.match(readJson(JobExit, path.join(dir, FILES.exit), disk), {
                onSome: ended,
                onNone: (): Run => ({ state: "lost", startedAt: runner.startedAt, why: "its runner is gone without recording an exit (the machine restarted, or it was killed)", cause: "runner-gone" }),
              }),
            ),
          )
        },
      }),
  })
}

/** A write to a job's record that failed (a full disk, an unwritable root): which job, which write, and why. */
export class RecordUnwritten extends Schema.TaggedError<RecordUnwritten>()("RecordUnwritten", { id: Schema.String, what: Schema.String, cause: Schema.String }) {}

/** A delivery slot's file: `delivery.<n>.json`. */
const SLOT = /^delivery\.([1-9][0-9]*)\.json$/

/** The newest slot of the delivery record in `dir`: the highest-numbered whole slot (a `*.tmp` is never one). */
export const slotOf = (dir: string, disk: Disk = NODE_DISK): Option.Option<Slot> => {
  const versions = disk.list(dir).flatMap((name) =>
    Option.toArray(Option.map(Option.fromNullishOr(SLOT.exec(name)), (found) => Number(found[1]))),
  )
  const version = Math.max(0, ...versions)
  return Option.map(readJson(Delivery, path.join(dir, `delivery.${version}.json`), disk), (delivery) => ({ version, delivery }))
}

/** The directory the managed jobs not yet delivered are listed in, one empty file per job: `.owed/<id>`. */
const OWED = ".owed"

/** Retire the job in `dir` (made if it is not there yet, so a launch still to come is fenced too): whether its launch slot was free. */
export const retireIn = (dir: string, at: number, barrier: (at: Barrier) => void = () => {}, disk: Disk = NODE_DISK): boolean => {
  makeDir(dir, disk)
  return writeDurable(path.join(dir, FILES.runner), { retiredAt: at } satisfies Retired, { exclusive: true, barrier, disk })
}

/** Write slot `version + 1` of the delivery record in `dir`, only if no writer took it: whether this one did. Slots are taken in order, so it is taken only while `version` is the newest. */
export const advanceIn = (dir: string, version: number, next: Delivery, barrier: (at: Barrier) => void = () => {}, disk: Disk = NODE_DISK): boolean =>
  disk.list(path.dirname(dir)).includes(path.basename(dir)) && writeDurable(path.join(dir, `delivery.${version + 1}.json`), next, { exclusive: true, barrier, disk })

/** The launch slot of the job in `dir`: its runner's claim or the wakes' retirement; none while neither took it. */
export const launchOf = (dir: string, disk: Disk = NODE_DISK): Option.Option<LaunchClaim> => readJson(LaunchClaim, path.join(dir, FILES.runner), disk)

/**
 * A job's files before its runner starts, each durable before the next: its directory (named in the root), job.json,
 * env.json, and, for a managed job, its name in the owed index, so the start finds it until it is delivered.
 */
export const writeLaunch = (root: string, spec: JobSpec, file: JobFile, env: Readonly<Record<string, string>>, disk: Disk = NODE_DISK): void => {
  const dir = path.join(root, spec.id)
  makeDir(dir, disk)
  writeAtomic(path.join(dir, FILES.job), file, 0o600, disk)
  writeAtomic(path.join(dir, FILES.env), env, 0o600, disk)
  if (Option.isSome(Option.fromNullishOr(spec.generation))) {
    makeDir(path.join(root, OWED), disk)
    writeAtomic(path.join(root, OWED, spec.id), {}, 0o600, disk)
  }
}

/** The bytes of `file` from `from` to its end, or none. */
const bytesFrom = (file: string, from: number): Uint8Array => {
  try {
    const all = readFileSync(file)
    return from >= all.length ? new Uint8Array() : all.subarray(from)
  } catch {
    return new Uint8Array()
  }
}

/** A system error's code, as `fs.watch` throws one (ENOSPC past Linux's inotify watches, EMFILE past the open files). */
const Coded = Schema.Struct({ code: Schema.String })

export const layer = (config: Config) => {
  const dirOf = (id: string) => path.join(config.root, id)
  const detached = (dir: string) =>
    Effect.try({
      try: () => Bun.spawn([config.bun, config.script, dir], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref(),
      catch: (cause) => new JobRefused({ message: `its runner did not start: ${cause instanceof Error ? cause.message : String(cause)}` }),
    })

  /**
   * A write to a job's record: whether it took its slot. One that failed (a full disk, an unwritable root) took nothing
   * and is no lost race: it dies, saying why, and the wakes reconcile the job again.
   */
  const disk = config.disk ?? NODE_DISK
  const written = (id: string, what: string, write: () => boolean) =>
    Effect.try({ try: write, catch: (cause) => new RecordUnwritten({ id, what, cause: String(cause) }) }).pipe(Effect.orDie)

  /** Each watched job's watch: one per live job, on its own directory alone. */
  const watches = new Map<string, FSWatcher>()
  const unwatch = (id: string) => {
    const held = watches.get(id)
    watches.delete(id)
    held?.close()
  }

  return Layer.effect(
    Runner,
    Effect.gen(function* () {
      // At most one watch per live job, so closing them all as the server stops is bounded (the host's own skip of
      // its many file watches at a signal is not a plugin's interface).
      yield* Effect.addFinalizer(() => Effect.sync(() => [...watches.keys()].forEach(unwatch)))
      return Runner.of({
    watch: (id, announce) =>
      Effect.try({
        try: () => {
          if (watches.has(id)) return true
          const dir = dirOf(id)
          // The exit is written as a temporary file renamed onto exit.json: either name announces; the log and progress do not.
          const watcher = (config.watch ?? watch)(dir, { persistent: false }, (_event, name) => {
            // An event that names no file may be the exit too: it announces, and the reader reads.
            if (Option.match(Option.fromNullishOr(name), { onNone: () => true, onSome: (file) => String(file).startsWith(FILES.exit) })) announce()
          })
          // A watch that fails later (its directory removed, the host's limit) is closed; the sweep finds that end.
          watcher.on("error", () => {
            if (watches.get(id) === watcher) unwatch(id)
          })
          watches.set(id, watcher)
          // Watched before this read: an exit written before the watch opened is announced here, one after it by the watch.
          if (Option.isSome(disk.read(path.join(dir, FILES.exit)))) announce()
          return true
        },
        // The error's code (ENOSPC, EMFILE, ENOENT), or its text when it has none.
        catch: (cause) =>
          Schema.decodeUnknownOption(Coded)(cause).pipe(
            Option.map((coded) => coded.code),
            Option.getOrElse(() => String(cause)),
          ),
      }).pipe(
        // ENOSPC or EMFILE (the host's watch limit), or no directory: that job's end is the sweep's to find; the job runs on.
        Effect.catch((code) => Effect.logWarning("wake: a job is not watched; the sweep finds its end", { id, code }).pipe(Effect.as(false))),
      ),
    unwatch: (id) => Effect.sync(() => unwatch(id)),
    watching: Effect.sync(() => [...watches.keys()]),
    retire: (id) => Effect.flatMap(Clock.currentTimeMillis, (now) => written(id, "retire", () => retireIn(dirOf(id), now, () => {}, disk))),
    advance: (id, version, next) =>
      written(id, "advance", () => {
        const took = advanceIn(dirOf(id), version, next, () => {}, disk)
        // Delivered: off the owed list (a crash before this leaves it listed, and `owed` drops it).
        if (took && next.state === "delivered") removeDurable(path.join(config.root, OWED, id), disk)
        return took
      }),
    stabilize: (id) => Effect.sync(() => disk.syncDir(dirOf(id))),
    owed: ({ directory, sessionID } = {}) =>
      Effect.sync(() => {
        const listed = disk.list(path.join(config.root, OWED))
        return listed.filter(isJobID).filter((id) => {
          const dir = dirOf(id)
          if (Option.exists(slotOf(dir, disk), (slot) => slot.delivery.state === "delivered")) {
            removeDurable(path.join(config.root, OWED, id), disk)
            return false
          }
          return Option.exists(readJson(Spec, path.join(dir, FILES.job), disk), ({ spec }) =>
            !Option.exists(Option.fromUndefinedOr(directory), (value) => value !== spec.directory) &&
            !Option.exists(Option.fromUndefinedOr(sessionID), (value) => value !== spec.sessionID),
          )
        })
      }),
    launch: (spec: JobSpec) =>
      Effect.gen(function* () {
        const dir = dirOf(spec.id)
        const descriptor: Descriptor | undefined =
          config.opencode === undefined ? undefined : { id: spec.id, title: unitOf(spec.id), directory: spec.directory, opencode: config.opencode, env: carried(config.env) }
        yield* Effect.try({
          try: () => {
            const env = Object.fromEntries(Object.entries(config.env).flatMap(([key, value]) => Option.toArray(Option.map(Option.fromNullishOr(value), (set) => [key, set] as const))))
            writeLaunch(config.root, spec, { spec, ...(descriptor === undefined ? {} : { notify: descriptor }) }, env, disk)
          },
          catch: (cause) => new JobRefused({ message: `its files were not written in ${dir}: ${cause instanceof Error ? cause.message : String(cause)}` }),
        })
        const where = { log: path.join(dir, FILES.log), drip: path.join(dir, FILES.drip) }
        let warning: string | undefined
        if (config.platform === "linux") {
          const unit = unitOf(spec.id)
          const ran = yield* config.exec(["systemd-run", "--user", "--unit", unit, "--collect", "--quiet", "--", config.bun, config.script, dir])
          if (ran.exitCode === 0) {
            writeAtomic(path.join(dir, FILES.launch), { how: "systemd", unit }, 0o600, disk)
            return { ...where, how: "systemd", unit } satisfies Launched
          }
          warning = `systemd-run --user refused (${(ran.stderr || ran.stdout).trim() || `exit ${ran.exitCode}`}), so it runs in its own process group instead: a stop of the OpenCode service's unit may end it.`
        }
        yield* detached(dir)
        writeAtomic(path.join(dir, FILES.launch), { how: "detached" }, 0o600, disk)
        return { ...where, how: "detached", ...(warning === undefined ? {} : { warning }) } satisfies Launched
      }),
    read: (id) =>
      Effect.sync(() => {
        const dir = dirOf(id)
        const record = Option.map(readJson(Spec, path.join(dir, FILES.job), disk), (job): JobRecord => ({
          spec: job.spec,
          run: runOf(dir, disk),
          log: path.join(dir, FILES.log),
          drip: path.join(dir, FILES.drip),
          ...Option.match(Option.flatMapNullishOr(readJson(Launch, path.join(dir, FILES.launch), disk), (launch) => launch.unit), { onNone: () => ({}), onSome: (unit) => ({ unit }) }),
          ...Option.match(slotOf(dir, disk), { onNone: () => ({}), onSome: (delivery) => ({ delivery }) }),
        }))
        return Option.getOrUndefined(record)
      }),
    tail: (id, chars) =>
      Effect.sync(() => {
        const file = path.join(dirOf(id), FILES.log)
        try {
          const size = Bun.file(file).size
          return new TextDecoder().decode(bytesFrom(file, Math.max(0, size - chars * 4))).slice(-chars)
        } catch {
          return ""
        }
      }),
    drip: (id, from) =>
      Effect.sync(() => {
        const bytes = bytesFrom(path.join(dirOf(id), FILES.drip), from)
        const end = bytes.lastIndexOf(10) + 1
        if (end === 0) return { text: "", offset: from }
        return { text: new TextDecoder().decode(bytes.subarray(0, end)), offset: from + end }
      }),
    kill: (id) =>
      Effect.sync(() => {
        const dir = dirOf(id)
        if (Option.isNone(disk.read(path.join(dir, FILES.job)))) return false
        const run = runOf(dir, disk)
        if (run.state === "starting") {
          writeFileSync(path.join(dir, FILES.stop), "")
          return true
        }
        if (run.state !== "running") return false
        // Only the claim's own runner is signalled: a pid another process took since is not it.
        return Option.match(Option.filter(readJson(RunnerClaim, path.join(dir, FILES.runner), disk), (runner) => claimed(runner)), {
          onNone: () => false,
          onSome: (runner) => Option.isSome(Option.liftThrowable(() => process.kill(runner.pid, "SIGTERM"))()),
        })
      }),
      })
    }),
  )
}
