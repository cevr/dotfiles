// Jobs as processes outside the OpenCode server. `launch` keeps the job's
// files in <root>/<id> (see supervise.ts) and starts its runner,
// `bun <script> <dir>`: under `systemd-run --user` on Linux, so a stop of the
// server's own unit leaves it running, and in its own session and process
// group elsewhere (and on a Linux whose user manager refuses), so the
// server's exit leaves it running. `read` takes the run from the files: an
// exit recorded is `ended`; a runner that claimed it and is still that process
// (its pid alive and started when its claim says) `running`; a claim whose
// runner is gone without an exit `lost`; never claimed `starting`. A kill
// signals only the claim's own runner, never a pid read alone. `watch` keeps
// one non-recursive watch on a live job's own directory and announces its exit
// file; the wakes close it once the end is delivered.
import { chmodSync, existsSync, type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, Match, Option, Schema } from "effect"
import type { Descriptor } from "../backstop.ts"
import { carried } from "../backstop.ts"
import { JobExit, type JobRecord, JobSpec, type Launched, type Run, unitOf } from "../job.ts"
import { type Exec } from "../cron/backstop.ts"
import { JobRefused, Runner } from "../service.ts"
import { RunnerClaim } from "../job-event.ts"
import { FILES, type JobFile, processStart, writeAtomic } from "./supervise.ts"

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
const readJson = <A, I>(schema: Schema.Codec<A, I>, file: string): Option.Option<A> =>
  Option.flatMap(Option.liftThrowable(() => readFileSync(file, "utf8"))(), Schema.decodeUnknownOption(Schema.fromJsonString(schema)))

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

/** The run the files of `dir` record. */
export const runOf = (dir: string): Run => {
  const ended = (exit: JobExit): Run => ({ state: "ended", exit })
  return Option.match(readJson(JobExit, path.join(dir, FILES.exit)), {
    onSome: ended,
    onNone: () =>
      Option.match(readJson(RunnerClaim, path.join(dir, FILES.runner)), {
        onNone: (): Run => ({ state: "starting" }),
        onSome: (runner): Run =>
          Match.value(claimed(runner)).pipe(
            Match.when(true, (): Run => ({ state: "running", startedAt: runner.startedAt })),
            // The exit may have landed between the two reads.
            Match.orElse(() =>
              Option.match(readJson(JobExit, path.join(dir, FILES.exit)), {
                onSome: ended,
                onNone: (): Run => ({ state: "lost", startedAt: runner.startedAt, why: "its runner is gone without recording an exit (the machine restarted, or it was killed)", cause: "runner-gone" }),
              }),
            ),
          ),
      }),
  })
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
          if (existsSync(path.join(dir, FILES.exit))) announce()
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
    launch: (spec: JobSpec) =>
      Effect.gen(function* () {
        const dir = dirOf(spec.id)
        const descriptor: Descriptor | undefined =
          config.opencode === undefined ? undefined : { id: spec.id, title: unitOf(spec.id), directory: spec.directory, opencode: config.opencode, env: carried(config.env) }
        yield* Effect.try({
          try: () => {
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            chmodSync(dir, 0o700)
            writeAtomic(path.join(dir, FILES.job), { spec, ...(descriptor === undefined ? {} : { notify: descriptor }) } satisfies JobFile)
            writeAtomic(path.join(dir, FILES.env), Object.fromEntries(Object.entries(config.env).filter(([, value]) => value !== undefined)))
          },
          catch: (cause) => new JobRefused({ message: `its files were not written in ${dir}: ${cause instanceof Error ? cause.message : String(cause)}` }),
        })
        const where = { log: path.join(dir, FILES.log), drip: path.join(dir, FILES.drip) }
        let warning: string | undefined
        if (config.platform === "linux") {
          const unit = unitOf(spec.id)
          const ran = yield* config.exec(["systemd-run", "--user", "--unit", unit, "--collect", "--quiet", "--", config.bun, config.script, dir])
          if (ran.exitCode === 0) {
            writeAtomic(path.join(dir, FILES.launch), { how: "systemd", unit })
            return { ...where, how: "systemd", unit } satisfies Launched
          }
          warning = `systemd-run --user refused (${(ran.stderr || ran.stdout).trim() || `exit ${ran.exitCode}`}), so it runs in its own process group instead: a stop of the OpenCode service's unit may end it.`
        }
        yield* detached(dir)
        writeAtomic(path.join(dir, FILES.launch), { how: "detached" })
        return { ...where, how: "detached", ...(warning === undefined ? {} : { warning }) } satisfies Launched
      }),
    read: (id) =>
      Effect.sync(() => {
        const dir = dirOf(id)
        const record = Option.map(readJson(Spec, path.join(dir, FILES.job)), (job): JobRecord => ({
          spec: job.spec,
          run: runOf(dir),
          log: path.join(dir, FILES.log),
          drip: path.join(dir, FILES.drip),
          ...Option.match(Option.flatMapNullishOr(readJson(Launch, path.join(dir, FILES.launch)), (launch) => launch.unit), { onNone: () => ({}), onSome: (unit) => ({ unit }) }),
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
        if (!existsSync(path.join(dir, FILES.job))) return false
        const run = runOf(dir)
        if (run.state === "starting") {
          writeFileSync(path.join(dir, FILES.stop), "")
          return true
        }
        if (run.state !== "running") return false
        // Only the claim's own runner is signalled: a pid another process took since is not it.
        return Option.match(Option.filter(readJson(RunnerClaim, path.join(dir, FILES.runner)), (runner) => claimed(runner)), {
          onNone: () => false,
          onSome: (runner) => Option.isSome(Option.liftThrowable(() => process.kill(runner.pid, "SIGTERM"))()),
        })
      }),
      })
    }),
  )
}
