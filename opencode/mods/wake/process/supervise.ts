// A job's runner: the process `bun cmd/wake/job.ts <dir>` that the process
// runner launches outside the OpenCode server (a systemd user unit, or its own
// session). It reads the job from <dir>, runs the command under /bin/sh in a
// process group of its own (when heavy, through the guard's launcher: `nice -n
// 10`, `ionice -c3` where it is, and on Linux with a user systemd a scope with `MemoryMax=12G`), its stdout and stderr to
// <dir>/log, `$JOB_DRIP` naming <dir>/drip and `$JOB_ID` the job; stops it at
// its timeout or on SIGTERM (TERM to the group, KILL after a grace to what is
// left of the group, even once its leader is gone; the exit then names the
// signal, whatever the leader exited with); records
// the exit in <dir>/exit.json, atomically, with its typed end (job-event.ts:
// its disposition, generation and sequence), retrying a write that fails;
// then calls `notify` with the job's descriptor, so the wakes reconcile its
// end now. The exit is written before the call: whatever reads the job after
// the call (or after a call that was lost) reads the end.
//
// Before it runs anything the runner claims the job: it writes runner.json
// (the job's launch slot, job-event.ts) only if none is there (a link, which
// fails on an existing file), with its pid and its process's start time. A
// second runner for the same job, or one that comes after the wakes retired
// the job as never started, finds the slot taken and runs nothing, so a launch
// repeated after a crash never runs a command twice and a retired one never
// runs; a reader takes the claim's pid as the runner only while that pid's
// start time is the claim's, so a reused pid is not it. Every file of the
// record is written durably (`writeDurable`). Mac caveat: a sync there is F_FULLFSYNC (bound from libSystem), since
// plain fsync on macOS leaves data in the drive's cache; where F_FULLFSYNC is refused it falls back to fsync.
//
// The files of <dir>, which the process runner (runner.ts) writes and reads:
// - job.json: { spec, notify? } (the descriptor, absent when the backstop is off)
// - env.json: the environment the command runs in, 0600; read once and deleted
// - launch.json: { how, unit? }
// - runner.json: the launch slot: the claim, { pid, startedAt, start }, once
//   this runner is up, or the wakes' { retiredAt }
// - delivery.<n>.json: the delivery record's slots (the wakes write them)
// - stop: asks a runner not yet up to record a kill instead of running
// - log, drip, exit.json
import { dlopen, FFIType } from "bun:ffi"
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import path from "node:path"
import { Duration, Effect, Match, Option, Predicate, Result, Schedule, Schema } from "effect"
import { DEFAULT_HEAVY, isHeavy } from "@dotfiles/opencode-guard/heavy"
import { admissionPurpose, DEFAULT_LIMITS, heavyArgv, type Host, ioniceAvailable, SCOPE_PROBE } from "@dotfiles/opencode-guard/launcher"
import { checkPrefix } from "@dotfiles/opencode-guard/check-demand"
import { issue, type Actuation } from "@dotfiles/opencode-guard/process/actuation"
import { heavyJob, jobArgv } from "../job-admission.ts"
import type { Descriptor } from "../backstop.ts"
import { type JobExit, type JobSpec, KILL_GRACE_MS } from "../job.ts"
import { type Disposition, dispositionOfExit, generationOf, RunnerClaim } from "../job-event.ts"
import { STARTUP } from "./checks.ts"

export const FILES = {
  job: "job.json",
  env: "env.json",
  launch: "launch.json",
  runner: "runner.json",
  stop: "stop",
  log: "log",
  drip: "drip",
  exit: "exit.json",
} as const

export interface JobFile {
  readonly spec: JobSpec
  readonly notify?: Descriptor | undefined
}

/** Where a durable write stands, for a test that kills its writer there: its temporary file synced (`temp`), or its name taken and the directory not yet synced (`named`). */
export type Barrier = "temp" | "named"

export interface Durable {
  /** Take the name only if it is free (a link, which fails on an existing file): of two writers, one takes it. Else a rename replaces it. */
  readonly exclusive?: boolean
  readonly mode?: number
  readonly barrier?: (at: Barrier) => void
  readonly disk?: Disk
  readonly root?: string
}

/**
 * The file system a job's record is written through, by the calls whose order makes it durable: a file's data is on
 * disk once `sync` returned on it; a name made, replaced or removed in a directory (`create`, `link`, `rename`,
 * `unlink`, `mkdir`) once `syncDir` returned on that directory. The tests put a disk that models a power loss here.
 */
export interface Disk {
  readonly create: (file: string, mode: number) => number
  readonly write: (fd: number, data: string) => void
  readonly sync: (fd: number) => void
  readonly close: (fd: number) => void
  readonly syncDir: (dir: string) => void
  /** Link `to` to `from`'s file: false when `to` is taken. */
  readonly link: (from: string, to: string) => boolean
  readonly rename: (from: string, to: string) => void
  readonly unlink: (file: string) => void
  /** Make `dir` (its parent there already); nothing when it is there. */
  readonly mkdir: (dir: string) => void
  readonly read: (file: string) => Option.Option<string>
  readonly list: (dir: string) => ReadonlyArray<string>
  /** Look up one name, without opening its parent for enumeration. Only absence is false. */
  readonly named: (name: string) => boolean
  /** Private sibling directory; publish its whole subtree without replacing a name another actor took. */
  readonly stage: (parent: string) => string
  readonly publish: (staged: string, root: string) => boolean
  /** Wait for filesystem metadata as well as file data, using only a handle at `dir`. */
  readonly syncVolume: (dir: string) => boolean
}

const platform = process.platform
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib"
/** `fcntl(fd, F_FULLFSYNC)` from libSystem, on macOS: there `fsync` leaves the data in the drive's cache; none elsewhere, or where it cannot be bound. */
const fullSync = Option.flatMap(
  Option.liftPredicate(platform, (os) => os === "darwin"),
  () => Option.liftThrowable(() => dlopen(LIBSYSTEM, { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.fcntl)(),
)
const F_FULLFSYNC = 51

const { i32, ptr, u32 } = FFIType
const AT_FDCWD = -100
const RENAME_NOREPLACE = 1
const RENAME_EXCL = 4
const kernelRename = Match.value(platform).pipe(
  Match.when("darwin", () => Option.liftThrowable(() => {
    const { renamex_np } = dlopen(LIBSYSTEM, { renamex_np: { args: [ptr, ptr, u32], returns: i32 } }).symbols
    return (from: Uint8Array, to: Uint8Array) => renamex_np(from, to, RENAME_EXCL)
  })()),
  Match.when("linux", () => Option.liftThrowable(() => {
    const { renameat2 } = dlopen("libc.so.6", { renameat2: { args: [i32, ptr, i32, ptr, u32], returns: i32 } }).symbols
    return (from: Uint8Array, to: Uint8Array) => renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE)
  })()),
  Match.orElse(() => Option.none<(from: Uint8Array, to: Uint8Array) => number>()),
)
// XNU's volume-sync callback discards VFS_SYNC's error; F_FULLFSYNC on the root fd cannot certify its parent.
const volumeSync = Match.value(platform).pipe(
  Match.when("linux", () => Option.liftThrowable(() => {
    const { syncfs } = dlopen("libc.so.6", { syncfs: { args: [i32], returns: i32 } }).symbols
    return (fd: number) => syncfs(fd) === 0
  })()),
  Match.orElse(() => Option.none<(fd: number) => boolean>()),
)
const cstring = (name: string) => new TextEncoder().encode(`${name}\0`)

const onDir = <A>(dir: string, use: (fd: number) => A): A => {
  const fd = openSync(dir, "r")
  const done = Result.try(() => use(fd))
  closeSync(fd)
  return Result.getOrThrow(done)
}

/** The host's file system. On macOS a sync is F_FULLFSYNC (flushed through the drive's cache); where that is refused, and elsewhere, fsync. */
export const NODE_DISK: Disk = {
  create: (file, mode) => openSync(file, "w", mode),
  write: (fd, data) => void writeSync(fd, data),
  sync: (fd) => {
    if (!Option.exists(fullSync, (fcntl) => fcntl(fd, F_FULLFSYNC) === 0)) fsyncSync(fd)
  },
  close: (fd) => closeSync(fd),
  syncDir: (dir) => onDir(dir, NODE_DISK.sync),
  link: (from, to) => Option.isSome(Option.liftThrowable(() => linkSync(from, to))()),
  rename: (from, to) => renameSync(from, to),
  unlink: (file) => rmSync(file, { force: true }),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true, mode: 0o700 }),
  read: (file) => Option.liftThrowable(() => readFileSync(file, "utf8"))(),
  list: (dir) => Option.getOrElse(Option.liftThrowable(() => readdirSync(dir))(), (): ReadonlyArray<string> => []),
  named: (name) => Option.isSome(Option.fromUndefinedOr(statSync(name, { throwIfNoEntry: false }))),
  stage: (parent) => mkdtempSync(path.join(parent, ".wake-stage-")),
  publish: (staged, root) => Option.exists(kernelRename, (rename) => rename(cstring(staged), cstring(root)) === 0),
  syncVolume: (dir) => Option.exists(volumeSync, (sync) => onDir(dir, sync)),
}

/** A process's own synced directory names. The job store does not rename or remove directories. */
const sealed = new WeakMap<Disk, Map<string, Set<string>>>()

class RootUnsealed extends Schema.TaggedError<RootUnsealed>()("RootUnsealed", { root: Schema.String, parent: Schema.String, reason: Schema.String }) {
  override get message() {
    return `Cannot certify job storage directory ${this.root} in ${this.parent}: ${this.reason}. Pre-provision the job storage directory or give Wake read, write and search access to its parent.`
  }
}

export class RootHandoff extends Schema.TaggedError<RootHandoff>()("RootHandoff", { root: Schema.String, parent: Schema.String, reason: Schema.String }) {
  override get message() {
    return `Cannot certify job storage directory ${this.root} in ${this.parent}: ${this.reason}.`
  }
}

export const UNSEALED_ROOT = ".wake-unsealed"
const markerIn = (root: string) => path.join(root, UNSEALED_ROOT)
const Permission = Schema.Struct({ code: Schema.Literals(["EACCES", "EPERM"]) })

const syncRootName = (root: string, disk: Disk) => {
  const parent = path.dirname(root)
  const sync = Result.try(() => disk.syncDir(parent))
  if (Result.isSuccess(sync)) return
  if (Option.isSome(Schema.decodeUnknownOption(Permission)(sync.failure))) {
    const viaVolume = Result.try(() => disk.syncVolume(root))
    if (Result.isSuccess(viaVolume) && viaVolume.success) return
  }
  // A racing writer can prove this name and clear the marker while we are attempting the parent.
  if (!disk.named(markerIn(root))) return
  Result.getOrThrow(Result.fail(new RootHandoff({ root, parent, reason: String(sync.failure) })))
}

/** Explicit operator handoff: only remove the marker after syncing the parent, then sync the removal. */
export const sealJobRoot = (dir: string): void => {
  const root = path.resolve(dir)
  if (!NODE_DISK.named(markerIn(root))) return
  NODE_DISK.syncDir(path.dirname(root))
  NODE_DISK.unlink(markerIn(root))
  NODE_DISK.syncDir(root)
}

const stageRoot = (root: string, disk: Disk): void => {
  const parent = path.dirname(root)
  // A missing root can't be created when its parent cannot be synced. Check before making even a temporary name.
  disk.syncDir(parent)
  const stage = disk.stage(parent)
  writeName(markerIn(stage), {}, disk, {})
  if (disk.publish(stage, root) || disk.named(root)) return
  Result.getOrThrow(Result.fail(new RootUnsealed({ root, parent, reason: "atomic directory publication failed" })))
}

/**
 * Only a marked directory may be published. A provisioned or sealed root has no marker and never opens its
 * parent. A peer with a marked root first certifies the name; cleanup touches only the root and cannot veto use.
 */
const sealRoot = (root: string, disk: Disk, synced: Set<string>, create: boolean): boolean => {
  if (synced.has(root)) return true
  const exists = disk.named(root)
  if (!exists && !create) return false
  const parent = path.dirname(root)
  if (parent === root) return exists
  if (!exists) {
    const result = Result.try(() => {
      sealRoot(parent, disk, synced, true)
      stageRoot(root, disk)
    })
    if (Result.isFailure(result) && result.failure instanceof RootHandoff) Result.getOrThrow(result)
    Result.getOrThrowWith(result, (cause) => new RootUnsealed({ root, parent, reason: String(cause) }))
  }
  if (disk.named(markerIn(root))) {
    syncRootName(root, disk)
    Result.try(() => {
      disk.unlink(markerIn(root))
      disk.syncDir(root)
    })
  }
  synced.add(root)
  return true
}

/** Seal every name below the boundary, whether created here or first seen from a peer. */
const sealPath = (dir: string, disk: Disk, synced: Set<string>, create: boolean, root: string): boolean => {
  if (synced.has(dir)) return true
  if (dir === root) return sealRoot(root, disk, synced, create)
  const parent = path.dirname(dir)
  if (parent === dir || !sealPath(parent, disk, synced, create, root)) return false
  if (!disk.named(dir)) {
    if (!create) return false
    disk.mkdir(dir)
  }
  disk.syncDir(parent)
  synced.add(dir)
  return true
}

const directoriesOf = (disk: Disk, root: string) => {
  const roots = Option.getOrElse(Option.fromUndefinedOr(sealed.get(disk)), () => new Map<string, Set<string>>())
  sealed.set(disk, roots)
  const seen = Option.fromUndefinedOr(roots.get(root))
  if (Option.isSome(seen)) return seen.value
  const synced = new Set<string>()
  roots.set(root, synced)
  return synced
}

const inStorage = (root: string, dir: string): boolean => {
  const relative = path.relative(root, dir)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Open a directory by a path this process has made durable, without creating a missing name. */
export const openDir = (dir: string, disk: Disk, root: string): boolean => {
  const boundary = path.resolve(root)
  const target = path.resolve(dir)
  return inStorage(boundary, target) && sealPath(target, disk, directoriesOf(disk, boundary), false, boundary)
}

/** Stabilize a reader's visible names before depending on them, even when their writer has not synced them yet. */
export const sealDirectory = (dir: string, disk: Disk, root: string): boolean => {
  if (!openDir(dir, disk, root)) return false
  disk.syncDir(dir)
  return true
}

/** Remove `file` and sync its directory, so the name stays gone after a power loss. */
export const removeDurable = (file: string, disk: Disk, root: string): void => {
  const dir = path.dirname(file)
  if (!openDir(dir, disk, root)) return
  disk.unlink(file)
  disk.syncDir(dir)
}

/** This process's pid. */
export const SELF = process.pid

/** The temporary files this process made, counted: with its pid, a name no other writer uses at once. */
const made = { count: 0 }

/**
 * Write `value` as JSON to `file` so a reader, a crash or a power loss never leaves half of it: a temporary file of
 * its own, written and synced, in a directory already reachable from the root; then the name (a link when exclusive,
 * else a rename); then the directory synced. A
 * writer acts on what it wrote only once this returns. At each barrier a loss leaves: before the name, the file as it
 * was (a stray `*.tmp`, which nothing reads); after it, the new file whole, or (a power loss before the directory's
 * sync) the old one, as if the write never was. Whether it took the name (an exclusive write finds it taken: false).
 */
export const writeDurable = <A>(file: string, value: A, options: Durable = {}): boolean => {
  const disk = options.disk ?? NODE_DISK
  const dir = path.dirname(file)
  const root = path.resolve(options.root ?? dir)
  const target = path.resolve(dir)
  if (!inStorage(root, target) || !sealPath(target, disk, directoriesOf(disk, root), true, root)) {
    return Result.getOrThrow(Result.fail(new RootUnsealed({ root, parent: dir, reason: "record path is outside job storage" })))
  }
  return writeName(file, value, disk, options)
}

/** Write a name whose containing directory is already durable. Only root creation bypasses `writeDurable`. */
const writeName = <A>(file: string, value: A, disk: Disk, options: Durable): boolean => {
  made.count += 1
  // A stray one of a dead process under the same pid is overwritten: that process links nothing any more.
  const temporary = `${file}.${SELF}.${made.count}.tmp`
  const fd = disk.create(temporary, options.mode ?? 0o600)
  const done = Result.try(() => {
    disk.write(fd, JSON.stringify(value))
    disk.sync(fd)
  })
  disk.close(fd)
  Result.getOrThrow(done)
  options.barrier?.("temp")
  if (options.exclusive !== true) disk.rename(temporary, file)
  else {
    const linked = disk.link(temporary, file)
    if (!linked) {
      disk.unlink(temporary)
      return false
    }
    disk.unlink(temporary)
  }
  options.barrier?.("named")
  disk.syncDir(path.dirname(file))
  return true
}

/** Write `value` as JSON to `file`, replacing it, durably (`writeDurable`). */
export const writeAtomic = <A>(file: string, value: A, mode = 0o600, disk: Disk = NODE_DISK, root: string = path.dirname(file)) =>
  void writeDurable(file, value, { mode, disk, root })

/** A process's start time as `ps -o lstart=` prints it (by its own path, in the C locale); none when `ps` could not say (no such process, or no `ps`). */
export const processStart = (pid: number): Option.Option<string> =>
  ranOf(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { LC_ALL: "C" }).pipe(
    Option.filter((ran) => ran.exitCode === 0),
    Option.map((ran) => ran.stdout.toString().trim()),
    Option.filter((start) => start !== ""),
  )

/** A short program run to its end, its output kept; none when it could not start. `env` set replaces the runner's. */
export const ranOf = (argv: ReadonlyArray<string>, env?: Record<string, string>) =>
  Option.liftThrowable(() => Bun.spawnSync([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", ...Option.match(Option.fromNullishOr(env), { onNone: () => ({}), onSome: (set) => ({ env: set }) }) }))()

/**
 * Claim the job in `dir` for this runner, as the process `pid`: true when its launch slot was free. The slot holds
 * one claim or the wakes' retirement, whichever came first, so a job retired as never started never runs.
 */
export const claim = (dir: string, startedAt: number, pid: number = SELF, barrier: (at: Barrier) => void = () => {}, disk: Disk = NODE_DISK, root: string = path.dirname(dir)): boolean => {
  const own: RunnerClaim = { pid, startedAt, ...Option.match(processStart(pid), { onNone: () => ({}), onSome: (start) => ({ start }) }) }
  return writeDurable(path.join(dir, FILES.runner), own, { exclusive: true, barrier, disk, root })
}

/** How many times the runner tries to write the exit, and how long it waits between. */
export const EXIT_WRITES = 5
export const EXIT_RETRY_MS = 200

/** Write the exit, trying again on a failure (a full disk, a transient error); whether it was written. */
export const writeExit = (dir: string, exit: JobExit, write: (file: string, value: JobExit) => void = writeAtomic): Effect.Effect<boolean> =>
  Effect.try(() => write(path.join(dir, FILES.exit), exit)).pipe(
    Effect.retry({ times: EXIT_WRITES - 1, schedule: Schedule.spaced(Duration.millis(EXIT_RETRY_MS)) }),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** Whether a heavy job can run in a systemd scope: on Linux, when the guard's probe exits 0; never elsewhere. */
export const scopeAvailable = (platform: string = process.platform, probe: ReadonlyArray<string> = SCOPE_PROBE): boolean => {
  if (platform !== "linux") return false
  return Option.exists(ranOf(probe), (ran) => ran.exitCode === 0)
}

/** What this machine offers a heavy job beyond `nice`: a scope (the guard's probe) and `ionice`. */
export const hostOf = (platform: string = process.platform): Host => ({ scope: scopeAvailable(platform), ionice: ioniceAvailable(platform) })

/**
 * The argv a job's command runs as: a heavy one through the guard's launcher (`nice`, `ionice -c3`
 * where the host has it, and in a scope under its memory cap where it has one). The host is asked
 * only for a heavy job: its scope probe starts a process.
 */
export const argvOf = (spec: Pick<JobSpec, "command" | "heavy">, host: () => Host): ReadonlyArray<string> => {
  const argv = ["/bin/sh", "-c", spec.command]
  return spec.heavy ? heavyArgv(argv, DEFAULT_LIMITS, host()) : argv
}

export const classifyJob = (command: string) => isHeavy(command, DEFAULT_HEAVY)
export const admittedJobArgv = (helper: ReadonlyArray<string>, command: string, requested: boolean) => {
  const payload = jobArgv(command)
  if (heavyJob(requested, classifyJob(command))) return [...helper, ...checkPrefix(admissionPurpose(command)), ...payload]
  return payload
}

/** Signal the process group `pid` leads; false when the group is already gone. */
const signalGroup = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/** Resolves once the group `pid` leads is empty, or at `until` (epoch ms), whichever comes first. */
const groupGone = async (pid: number, until: number) => {
  while (signalGroup(pid, 0) && Date.now() < until) await Bun.sleep(20)
}

const readEnv = (dir: string): Record<string, string> => {
  const file = path.join(dir, FILES.env)
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
  } catch {
    return Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])))
  } finally {
    rmSync(file, { force: true })
  }
}

/** The bytes of progress written so far: the end's sequence follows them. */
const dripped = (dir: string): number => Option.getOrElse(Option.liftThrowable(() => statSync(path.join(dir, FILES.drip)).size)(), () => 0)
const writeTerminal = (file: string, value: JobExit) => writeAtomic(file, value, 0o600, NODE_DISK, path.dirname(path.dirname(file)))

/**
 * Run the job in `dir` to its end, record it, and call `notify` with its descriptor. None, running nothing, when
 * another runner claimed the job first. `write` is how the exit is written (a test makes it fail).
 */
export const supervise = async (
  dir: string,
  notify?: (descriptor: Descriptor) => Promise<void>,
  grace = KILL_GRACE_MS,
  write: (file: string, value: JobExit) => void = writeTerminal,
  launch: (spec: JobSpec) => ReadonlyArray<string> = (spec) => argvOf(spec, hostOf),
  stopThroughAdmission: (spec: JobSpec) => boolean = () => false,
): Promise<Option.Option<JobExit>> => {
  const root = path.dirname(dir)
  if (!openDir(dir, NODE_DISK, root)) return Option.none()
  const job = JSON.parse(readFileSync(path.join(dir, FILES.job), "utf8")) as JobFile
  const startedAt = Date.now()

  let child: ReturnType<typeof Bun.spawn> | undefined
  let timedOut = false
  let killed = false
  /** The strongest signal this runner delivered to the command's group while the group was there. */
  let sent: "SIGTERM" | "SIGKILL" | undefined
  /** When a stop's grace ends: the SIGKILL then reaches what is left of the group. */
  let hardAt: number | undefined
  let hard: ReturnType<typeof setTimeout> | undefined
  const delegated = stopThroughAdmission(job.spec)
  const ownedLaunch: Actuation = { dispatch: (intent) => Effect.sync(() => {
    if (intent.target !== "retained-child" || !child || !Predicate.isNull(child.exitCode) || !Predicate.isNull(child.signalCode)) return
    child.kill("SIGTERM")
    sent = "SIGTERM"
  }) }
  const stop = () => {
    if (delegated) {
      // This helper owns its watchdog/cgroup, including descendants. Never
      // infer the right to signal a numeric group from the job's snapshot.
      Effect.runSync(issue(ownedLaunch, [{ target: "retained-child", signal: "TERM" }]))
      return
    }
    const pid = child?.pid
    // No group left: the command ended by itself before the stop reached it.
    if (pid === undefined || !signalGroup(pid, "SIGTERM")) return
    sent ??= "SIGTERM"
    if (hard !== undefined) return
    hardAt = Date.now() + grace
    hard = setTimeout(() => {
      if (signalGroup(pid, "SIGKILL")) sent = "SIGKILL"
    }, grace)
  }
  const onSignal = () => {
    killed = true
    stop()
  }
  // The handlers come before runner.json: once it is written the job reads
  // running and a kill sends SIGTERM here, and without a handler that signal
  // ends this runner with no exit recorded (the job reads lost) and leaves
  // the command's group running.
  const handlers = (method: "on" | "off") => {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process[method](signal, onSignal)
  }
  handlers("on")
  // Another runner of this job claimed it first: this one runs nothing and records nothing.
  if (!claim(dir, startedAt)) {
    handlers("off")
    return Option.none()
  }
  const env = readEnv(dir)

  const record = (fields: Omit<JobExit, "disposition" | "generation" | "sequence">, disposition: Option.Option<Disposition> = Option.none()) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit: JobExit = { ...fields, generation: generationOf(job.spec), sequence: dripped(dir) + 1 }
        const typed: JobExit = { ...exit, disposition: Option.getOrElse(disposition, () => dispositionOfExit(exit)) }
        // The end is on disk before anyone is told of it; one never written reads lost, and is not announced.
        const written = yield* writeExit(dir, typed, write)
        const told = Option.all({ descriptor: Option.fromNullishOr(job.notify), call: Option.fromNullishOr(notify) }).pipe(Option.filter(() => written))
        yield* Option.match(told, { onNone: () => Effect.void, onSome: ({ descriptor, call }) => Effect.promise(() => call(descriptor).catch(() => {})) })
        return Option.some(typed)
      }),
    )

  if (killed || existsSync(path.join(dir, FILES.stop)))
    return record({ exitCode: null, signal: "SIGTERM", startedAt, endedAt: Date.now(), timedOut: false, killed: true })

  const log = openSync(path.join(dir, FILES.log), "a", 0o600)
  const drip = path.join(dir, FILES.drip)
  writeFileSync(drip, "", { flag: "a", mode: 0o600 })
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !(STARTUP as ReadonlyArray<string>).includes(name)))
  let spawned: ReturnType<typeof Bun.spawn>
  try {
    spawned = Bun.spawn([...launch(job.spec)], {
      cwd: job.spec.cwd,
      env: { ...childEnv, JOB_DRIP: drip, JOB_ID: job.spec.id },
      stdin: "ignore",
      stdout: log,
      stderr: log,
      detached: true,
    })
  } catch (cause) {
    writeFileSync(log, `job: the command did not start in ${job.spec.cwd}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    closeSync(log)
    return record({ exitCode: 127, startedAt, endedAt: Date.now(), timedOut: false, killed: false }, Option.some("spawn-failed"))
  }
  closeSync(log)
  child = spawned

  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, job.spec.timeoutSeconds * 1000)
  // A kill that came while this runner was coming up.
  if (killed || existsSync(path.join(dir, FILES.stop))) onSignal()

  const exitCode = await spawned.exited
  clearTimeout(timer)
  // A stop ends the whole group, not just its leader: the leader can end at
  // the SIGTERM while a member that ignores it runs on, so what is left at the
  // grace's end gets the SIGKILL, before the exit is recorded.
  if (hard !== undefined && hardAt !== undefined) {
    await groupGone(spawned.pid, hardAt)
    clearTimeout(hard)
    if (signalGroup(spawned.pid, "SIGKILL")) sent = "SIGKILL"
  }
  // A stop that reached the group ended the job, whatever its leader made of
  // the signal (a shell that traps SIGTERM, or whose children die of it, can
  // exit 0): the exit names the signal, as the memory runner's does. A stop
  // that found no group came after the command had ended by itself, so its
  // own exit stands and it is neither killed nor timed out.
  return record(endOf({ exitCode, signalCode: spawned.signalCode, sent: Option.fromNullishOr(sent), timedOut, killed, startedAt, endedAt: Date.now() }))
}

/** Installed durable entry. Its classified path has no unmanaged default launcher. */
export const superviseAdmitted = (dir: string, helper: ReadonlyArray<string>, notify?: (descriptor: Descriptor) => Promise<void>) =>
  supervise(dir, notify, KILL_GRACE_MS, writeTerminal,
    (spec) => admittedJobArgv(helper, spec.command, spec.heavy),
    (spec) => heavyJob(spec.heavy, classifyJob(spec.command)),
  )

/** The exit a run that went its course records: the signal that ended it, whether its own or one this runner sent, wins over its code. */
const endOf = (run: {
  readonly exitCode: number
  readonly signalCode: ReturnType<typeof Bun.spawn>["signalCode"]
  readonly sent: Option.Option<"SIGTERM" | "SIGKILL">
  readonly timedOut: boolean
  readonly killed: boolean
  readonly startedAt: number
  readonly endedAt: number
}): Omit<JobExit, "disposition" | "generation" | "sequence"> => {
  const stopped = Option.isSome(run.sent)
  return {
    ...Option.match(Option.orElse(Option.map(Option.fromNullishOr(run.signalCode), String), () => run.sent), {
      onNone: () => ({ exitCode: run.exitCode }),
      onSome: (signal) => ({ exitCode: null, signal }),
    }),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    timedOut: run.timedOut && stopped,
    killed: run.killed && !run.timedOut && stopped,
  }
}
