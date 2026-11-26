import { connect, env, listen, spawn, type Socket } from "bun"
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { AdmissionUnavailable } from "../admission.ts"
import { Counter, OpaqueId, type Principal } from "../admission-wire.ts"
import { type BootHost, linuxBudget, readProcess, ref, WORKLOAD_SLICE } from "./admission.ts"
import { DEFAULT_LIMITS, heavyArgv, ioniceAvailable, SCOPE_PROBE } from "../launcher.ts"
import { type Actuation, issue, watchdogPlan, watchdogProgram } from "./actuation.ts"
import { attestLinux, linuxDrain, stopLinux, type LinuxManager } from "./linux-controller.ts"

const unavailable = (detail: string) => new AdmissionUnavailable({ reason: "unavailable", detail })
const unqualified = () => new AdmissionUnavailable({ reason: "unqualified" })
/** An unqualified launch step, naming the step. */
const refuse = (detail: string) => () => new AdmissionUnavailable({ reason: "unqualified", detail })

interface ProcessIdentity {
  readonly pid: number
  readonly start: number
  readonly group: number
  readonly uid: number
  readonly command: string
}

const Descriptor = Schema.Struct({ file: Schema.String, device: Schema.String, inode: Schema.String })
type Descriptor = typeof Descriptor.Type
export const ProcessPin = Schema.Struct({
  ref: OpaqueId, bootId: OpaqueId, pid: Counter, start: Counter, group: Counter,
  cgroup: Schema.OptionFromNullOr(Schema.String),
  descriptor: Descriptor,
})
export type ProcessPin = typeof ProcessPin.Type
type UnarmedPin = Omit<ProcessPin, "descriptor">

const flockExclusiveNonblocking = 2 | 4
const privateOpen = { darwin: 0x01000102, linux: 0x000a0002 }
const cString = (text: string) => new TextEncoder().encode(`${text}\0`)
interface Stamp { readonly device: string; readonly inode: string; readonly mode: number; readonly uid: number; readonly links: number }

// `vnode_fdinfo` starts with proc_fileinfo then fixed-size vinfo_stat;
// byte offsets are from the macOS SDK's sys/proc_info.h.
const darwinStat = (host: BootHost, pid: number, fd: number, bytes = new Uint8Array(176)): Option.Option<Stamp> => {
  if (Option.isNone(host.kernel.mach)) return Option.none()
  const symbols = host.kernel.mach.value.symbols
  if (symbols.proc_pidfdinfo(pid, fd, 1, bytes, bytes.length) <= 0) return Option.none()
  const fields = new DataView(bytes.buffer)
  return Option.some({
    device: String(fields.getUint32(24, true)), mode: fields.getUint16(28, true), links: fields.getUint16(30, true),
    inode: String(fields.getBigUint64(32, true)), uid: fields.getUint32(40, true),
  })
}
// statx is the fixed-size Linux UAPI, independent of the loader's struct stat ABI.
const linuxStat = (host: BootHost, fd: number, name: string, flags: number): Option.Option<Stamp> => {
  if (Option.isNone(host.kernel.linux)) return Option.none()
  const bytes = new Uint8Array(256)
  if (host.kernel.linux.value.symbols.statx(fd, cString(name), flags, 0x7ff, bytes) !== 0) return Option.none()
  const fields = new DataView(bytes.buffer)
  if ((fields.getUint32(0, true) & 0x10f) !== 0x10f) return Option.none()
  return Option.some({
    device: `${fields.getUint32(136, true)}:${fields.getUint32(140, true)}`,
    mode: fields.getUint16(28, true), links: fields.getUint32(16, true),
    inode: String(fields.getBigUint64(32, true)), uid: fields.getUint32(20, true),
  })
}
const descriptorOf = (host: BootHost, file: string, fd: number) => {
  const sys = host.kernel.core.symbols
  const attestation = {
    darwin: () => darwinStat(host, sys.getpid(), fd),
    linux: () => linuxStat(host, fd, "", 0x1000),
  }
  return attestation[host.platform]().pipe(
    Option.filter((entry) => (entry.mode & 0xf000) === 0x8000 && (entry.mode & 0o077) === 0 &&
      entry.links === 1 && entry.uid === sys.getuid()),
    Option.map(({ device, inode }) => ({ file, device, inode })),
  )
}
const equalDescriptor = (a: Descriptor, b: Descriptor) => a.device === b.device && a.inode === b.inode
const openDescriptor = (host: BootHost, file: string) => Effect.acquireRelease(
  Effect.suspend(() => {
    const fd = host.kernel.core.symbols.open(cString(file), privateOpen[host.platform])
    if (fd < 0) return Effect.fail(unavailable(`cannot open the lease lock ${file}`))
    return Effect.succeed(fd)
  }),
  (fd) => Effect.sync(() => { host.kernel.core.symbols.close(fd) }),
)

/** A distinct open-file description owns each attempt. The payload inherits a
 * duplicate. CLOSE (never explicit unlock) drops our reference without
 * unlocking still-live copies, including setsid'd descendants. */
export const armDescriptor = Effect.fn("LaunchScope.armDescriptor")(function* (host: BootHost, file: string) {
  const fs = yield* FileSystem.FileSystem
  const sys = host.kernel.core.symbols
  yield* Effect.scoped(fs.open(file, { flag: "wx", mode: 0o600, noFollow: true })).pipe(Effect.mapError(refuse(`cannot create the lease lock ${file}`)))
  const fd = yield* openDescriptor(host, file)
  const stamp = descriptorOf(host, file, fd)
  if (Option.isNone(stamp) || sys.flock(fd, flockExclusiveNonblocking) !== 0) return yield* refuse(`cannot lock the lease lock ${file}`)()
  return { fd, descriptor: stamp.value }
})

export const descriptorLiveness = Effect.fn("LaunchScope.descriptorLiveness")(function* (host: BootHost, stamp: Descriptor) {
  const sys = host.kernel.core.symbols
  const fd = yield* openDescriptor(host, stamp.file)
  const resolved = descriptorOf(host, stamp.file, fd)
  if (Option.isNone(resolved) || !equalDescriptor(resolved.value, stamp)) return "unknown" as const
  if (sys.flock(fd, flockExclusiveNonblocking) === 0) return "gone" as const
  return "held" as const
})

const linuxManager = Effect.fn("LaunchScope.manager")(function* () {
  const fs = yield* FileSystem.FileSystem
  const read = (file: string) => fs.readFileString(file).pipe(Effect.mapError(unqualified))
  return {
    workloadRoot: linuxBudget().pipe(Effect.flatMap(({ budget }) => Option.match(budget, {
      onNone: () => Effect.fail(unqualified()), onSome: ({ control }) => Effect.succeed(control),
    }))),
    currentGroup: read("/proc/self/cgroup"),
    read,
    exists: (file) => fs.exists(file).pipe(Effect.mapError(unqualified)),
    stop: (unit) => readProcess(["/usr/bin/systemctl", "--user", "--no-block", "stop", unit]).pipe(Effect.asVoid),
  } satisfies LinuxManager<FileSystem.FileSystem>
})

export const stopOwnedCgroup = Effect.fn("LaunchScope.stopOwnedCgroup")(function* (host: BootHost, pin: ProcessPin) {
  if (host.platform !== "linux" || Option.isNone(pin.cgroup)) return yield* unqualified()
  // This process still inhabits the exact one-use unit; its native binding
  // cannot refer to a future reuse. The user manager drives KillMode,
  // including members that changed their POSIX group.
  yield* stopLinux(yield* linuxManager(), pin.cgroup.value, host.kernel.core.symbols.getpid() === pin.pid)
})

// stdin is a one-way control pipe, not the command's stdin. The watcher is
// started before the lease descriptor exists. Only a post-claim `armed`
// order authorizes a kill. EOF thereafter means the launcher disappeared.
const spawnWatchdog = (script: string) => spawn(["/bin/sh", "-c", script], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
/** A pin in a cgroup is stopped by its unit; any other (the Mac, an
 * unattested Linux host) by its own process group's watchdog. */
export const watchGroup = Effect.fn("LaunchScope.watchGroup")(function* (host: BootHost, pin: UnarmedPin) {
  if (Option.isSome(pin.cgroup)) return { arm: Effect.void, disarm: Effect.void, stop: Effect.void, onLauncherExit: Effect.void }
  return yield* watchOwnGroup(host, pin.pid)
})

/** Darwin's production watchdog; the same portable group primitive can be
 * checked under a scratch Linux group without changing Linux's cgroup policy. */
export const watchOwnGroup = Effect.fn("LaunchScope.watchOwnGroup")(function* (
  host: BootHost, leader: number, spawnNative: typeof spawnWatchdog = spawnWatchdog,
) {
  const sys = host.kernel.core.symbols
  if (sys.getpid() !== leader || sys.getpgrp() !== leader) return yield* refuse("this process does not lead its own process group")()
  const dispatch = watchdogPlan({ source: "pipe", armed: true, order: "eof" })
  let waitForExit = false
  const watcher = yield* Effect.acquireRelease(
    Effect.try({ try: () => spawnNative(watchdogProgram(dispatch)), catch: refuse("cannot start the group watchdog (/bin/sh)") }),
    (child) => Effect.sync(() => {
      if (waitForExit) child.unref()
      else child.stdin.end()
    }),
  )
  const send = (line: string) => Effect.suspend(() => {
    if (Number.isInteger(watcher.exitCode) || watcher.signalCode) return Effect.fail(unqualified())
    return Effect.try({
      try: () => {
        watcher.stdin.write(`${line}\n`)
        watcher.stdin.flush()
      },
      catch: unqualified,
    })
  })
  const ack = yield* Effect.acquireUseRelease(
    Effect.sync(() => watcher.stdout.getReader()),
    (reader) => Effect.tryPromise({ try: () => reader.read(), catch: unqualified }),
    (reader) => Effect.sync(() => reader.releaseLock()),
  ).pipe(Effect.timeout(1000), Effect.mapError(refuse("the group watchdog did not answer ready within 1 s")))
  if (ack.done || new TextDecoder().decode(ack.value) !== "ready\n") return yield* refuse("the group watchdog did not answer ready")()
  const stop = send("stop").pipe(Effect.catchTag("AdmissionUnavailable", () => Effect.suspend(() => {
      // The group is still pinned by *this* live leader. A fresh in-group
      // sender is safe even if the original watcher was independently lost.
    if (!Number.isInteger(watcher.exitCode) && !watcher.signalCode) return Effect.fail(unqualified())
    const plan = watchdogPlan({ source: "leader", ownGroup: sys.getpgrp() === leader, watchdog: "gone" })
    if (plan.length === 0) return Effect.fail(unqualified())
    return Effect.try({ try: () => {
      const replacement = spawnNative(watchdogProgram(plan))
      replacement.stdin.write("armed\nstop\n")
      replacement.stdin.end()
    }, catch: unqualified })
  })))
  return { arm: send("armed"), disarm: send("drained").pipe(Effect.ignore), stop, onLauncherExit: Effect.sync(() => { waitForExit = true }) }
})

const commandLabel = (name: string) => [...name].filter((char) => {
  const first = char.charCodeAt(0)
  return first >= 32 && first !== 127
}).join("")

const darwinIdentity = (host: BootHost, pid: number): Option.Option<ProcessIdentity> => {
  if (Option.isNone(host.kernel.mach)) return Option.none()
  const bsdinfo = new Uint8Array(136)
  if (host.kernel.mach.value.symbols.proc_pidinfo(pid, 3, 0n, bsdinfo, bsdinfo.length) !== bsdinfo.length) return Option.none()
  const view = new DataView(bsdinfo.buffer)
  if (view.getUint32(12, true) !== pid) return Option.none()
  const start = Number(view.getBigUint64(120, true) * 1_000_000n + view.getBigUint64(128, true))
  if (!Number.isSafeInteger(start) || start <= 0) return Option.none()
  const command = commandLabel(new TextDecoder().decode(bsdinfo.subarray(48, 64)))
  return Option.some({ pid, start, group: view.getUint32(100, true), uid: view.getUint32(28, true), command })
}

const linuxIdentity = Effect.fn("LaunchScope.linuxIdentity")(function* (pid: number) {
  const fs = yield* FileSystem.FileSystem
  const [stat, status] = yield* Effect.all([
    fs.readFileString(`/proc/${pid}/stat`), fs.readFileString(`/proc/${pid}/status`),
  ], { concurrency: 2 }).pipe(Effect.option)
    .pipe(Effect.map((both) => Option.getOrElse(both, () => ["", ""] as const)))
  const end = stat.lastIndexOf(")")
  const command = commandLabel(stat.slice(stat.indexOf("(") + 1, end))
  const fields = stat.slice(end + 1).trim().split(/\s+/u)
  const start = Number(fields[19])
  const group = Number(fields[2])
  const uid = Number(status.match(/^Uid:\s*(\d+)/mu)?.[1])
  if (![start, group, uid].every((n) => Number.isSafeInteger(n) && n >= 0) || start === 0 || group === 0) return Option.none()
  return Option.some({ pid, start, group, uid, command })
})

export const processIdentity = (host: BootHost, pid: number) => {
  if (host.platform === "darwin") return Effect.sync(() => darwinIdentity(host, pid))
  return linuxIdentity(pid)
}

export const callerOf = Effect.fn("LaunchScope.caller")(function* (host: BootHost) {
  const core = host.kernel.core.symbols
  const pid = core.getppid()
  const identity = yield* processIdentity(host, pid)
  if (Option.isNone(identity) || identity.value.uid !== core.getuid())
    return yield* unavailable(`cannot read the calling process's identity (pid ${pid}) as this user`)
  const scopeId = ref("peer", `${host.bootId}:${identity.value.uid}:${identity.value.pid}:${identity.value.start}`)
  const principal: Principal = { kind: "external-runner", scopeId, epoch: identity.value.start }
  return { principal, owner: scopeId, ...identity.value }
})
export type Caller = Effect.Success<ReturnType<typeof callerOf>>

export const actorLiveness = Effect.fn("LaunchScope.actorLiveness")(function* (host: BootHost, pid: number, start: number) {
  const identity = yield* processIdentity(host, pid)
  if (Option.isSome(identity)) {
    if (identity.value.start === start) return "live" as const
    return "gone" as const
  }
  // Reused start identity is positive loss. A failing query by itself is
  // not evidence of death. On Darwin enumerate the whole process table
  // with the kernel API (no command lines or other users' names).
  if (host.platform === "darwin") {
    if (Option.isNone(host.kernel.mach)) return "unknown" as const
    const list = listPids(host.kernel.mach.value.symbols.proc_listpids)
    if (Option.isNone(list) || list.value.includes(pid)) return "unknown" as const
    return "gone" as const
  }
  const fs = yield* FileSystem.FileSystem
  return yield* fs.exists(`/proc/${pid}`).pipe(
    Effect.map((exists) => {
      if (exists) return "unknown" as const
      return "gone" as const
    }),
    Effect.orElseSucceed(() => "unknown" as const),
  )
})

const listPids = (list: (kind: number, arg: number, buffer: Int32Array, size: number) => number) => {
  const pids = new Int32Array(8192)
  const bytes = list(1, 0, pids, pids.byteLength)
  if (bytes <= 0 || bytes >= pids.byteLength || bytes % 4 !== 0) return Option.none()
  return Option.some([...pids.subarray(0, bytes / 4)].filter((pid) => pid > 0))
}

const sameUser = (host: BootHost, identity: ProcessIdentity) => identity.uid === host.kernel.core.symbols.getuid()
const darwinHolds = (host: BootHost, pid: number, descriptor: Descriptor) => {
  if (Option.isNone(host.kernel.mach)) return false
  const symbols = host.kernel.mach.value.symbols
  // proc_fdinfo is two 32-bit words; vnode_fdinfo begins with a 24-byte
  // proc_fileinfo, then vinfo_stat's device, mode, link count and inode.
  const fds = new Int32Array(2048)
  const size = symbols.proc_pidinfo(pid, 1, 0n, fds, fds.byteLength)
  if (size <= 0 || size > fds.byteLength || size % 8 !== 0) return false
  const vnode = new Uint8Array(176)
  for (let i = 0; i < size / 4; i += 2) {
    const fd = fds[i]
    if (Predicate.isNotUndefined(fd) && fds[i + 1] === 1 &&
      Option.exists(darwinStat(host, pid, fd, vnode), (entry) => entry.device === descriptor.device && entry.inode === descriptor.inode))
      return true
  }
  return false
}

const linuxHolds = Effect.fn("LaunchScope.linuxHolds")(function* (host: BootHost, pid: number, descriptor: Descriptor) {
  const fs = yield* FileSystem.FileSystem
  const directory = `/proc/${pid}/fd`
  const files = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
  for (const name of files.slice(0, 1024)) {
    const match = linuxStat(host, -100, `${directory}/${name}`, 0)
    if (Option.exists(match, (entry) => entry.device === descriptor.device && entry.inode === descriptor.inode)) return true
  }
  return false
})

/** Positive evidence only. A partial scan never certifies absence or gives
 * an actuator a PID. The inherited lock is the independent release proof. */
export const descriptorHolders = Effect.fn("LaunchScope.descriptorHolders")(function* (
  host: BootHost, descriptor: Descriptor, candidates?: ReadonlyArray<number>,
) {
  const fs = yield* FileSystem.FileSystem
  const inventory = {
    darwin: () => Effect.succeed(Option.match(Option.flatMap(host.kernel.mach, ({ symbols }) => listPids(symbols.proc_listpids)), {
      onNone: () => [], onSome: (pids) => pids,
    })),
    linux: () => fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []),
      Effect.map((entries) => entries.filter((entry) => /^\d+$/u.test(entry)).map(Number))),
  }
  const check = {
    darwin: (pid: number) => Effect.sync(() => darwinHolds(host, pid, descriptor)),
    linux: (pid: number) => linuxHolds(host, pid, descriptor),
  }
  const pids = candidates ?? (yield* inventory[host.platform]())
  const matches: ProcessIdentity[] = []
  for (const pid of pids.slice(0, 1024)) {
    if (matches.length >= 16) break
    const prior = yield* processIdentity(host, pid)
    if (Option.isNone(prior) || !sameUser(host, prior.value)) continue
    const holds = yield* check[host.platform](pid)
    if (!holds) continue
    const after = yield* processIdentity(host, pid)
    if (Option.isSome(after) && after.value.start === prior.value.start && sameUser(host, after.value)) matches.push(after.value)
  }
  return matches
})

export const scopeLiveness = Effect.fn("LaunchScope.scopeLiveness")(function* (host: BootHost, pin: ProcessPin) {
  if (pin.bootId !== host.bootId) return "gone" as const
  const descriptor = yield* Effect.scoped(descriptorLiveness(host, pin.descriptor)).pipe(Effect.orElseSucceed(() => "unknown" as const))
  if (descriptor === "held") return "live" as const
  if (descriptor === "unknown") return descriptor
  // A group-placed pin (the Mac, an unattested Linux host) has no cgroup:
  // its released descriptor is the proof, as every member inherited it.
  if (Option.isNone(pin.cgroup)) return "gone" as const
  return yield* linuxDrain(yield* linuxManager(), pin.cgroup.value, descriptor)
})

/** Where a claimed attempt lives: `cgroup`, the Linux workload controller's
 * one-use unit; `group`, its own process group (the Mac, and a Linux host
 * that cannot attest a controller). */
export type Placement = "cgroup" | "group"
export const placementOf = (host: BootHost, attested: boolean): Placement => {
  if (host.platform === "linux" && attested) return "cgroup"
  return "group"
}

export const pinOf = Effect.fn("LaunchScope.pin")(function* (
  host: BootHost, id: string, generation: number, cpuMilli: number, memoryBytes: number, foreground = Option.none<number>(),
  placement: Placement = placementOf(host, true),
) {
  const sys = host.kernel.core.symbols
  const pid = sys.getpid()
  const grouped = placement === "group"
  if (grouped && sys.getpgrp() !== pid &&
    ((sys.isatty(0) === 1 && !Option.exists(foreground, (group) => group === sys.getpgrp())) || sys.setpgid(0, 0) !== 0))
    return yield* refuse("cannot lead a process group of its own (setpgid failed, or the terminal's foreground group is another)")()
  const self = yield* processIdentity(host, pid)
  if (Option.isNone(self) || (grouped && self.value.group !== pid)) return yield* refuse(`cannot read its own identity as group leader (pid ${pid})`)()
  let cgroup = Option.none<string>()
  if (!grouped) {
    const actual = yield* attestLinux(yield* linuxManager(), unitOf(id, generation), cpuMilli, memoryBytes)
    cgroup = Option.some(actual)
  }
  return {
    ref: ref("scope", `${host.bootId}:${id}:${generation}:${self.value.pid}:${self.value.start}`),
    bootId: host.bootId, pid: self.value.pid, start: self.value.start, group: self.value.group, cgroup,
  } satisfies UnarmedPin
})

const serviceEnv = ["PATH", "HOME", "USER", "LOGNAME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const
const unitOf = (id: string, generation: number) => `host-admit-${ref("run", `${id}:${generation}`)}`
/** The proxy starts the helper, not the payload, in an attestable cgroup.
 * No `--scope` migration from the protected resident. */
export const systemdArgv = (input: {
  readonly id: string
  readonly generation: number
  readonly cwd: string
  readonly cpuMilli: number
  readonly memoryBytes: number
  readonly helper: ReadonlyArray<string>
}) => [
  "/usr/bin/systemd-run", "--user", "--wait", "--pipe", "--quiet", "--collect", "--expand-environment=no",
  `--slice=${WORKLOAD_SLICE}`, `--unit=${unitOf(input.id, input.generation)}`, `--working-directory=${input.cwd}`,
  "-p", `CPUQuota=${input.cpuMilli / 10}%`, "-p", "CPUWeight=20",
  "-p", `MemoryMax=${input.memoryBytes}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=kill",
  "-p", "MemoryOOMGroup=yes", "-p", "KillMode=control-group", "-p", "TimeoutStopSec=2s",
  ...serviceEnv.values().filter((name) => Predicate.isString(env[name])).map((name) => `--setenv=${name}`),
  "--", ...input.helper,
]

export const payloadArgv = (host: BootHost, argv: ReadonlyArray<string>, nice = 10, ionice = true) => {
  const prefix = ["/usr/bin/nice", "-n", String(nice)]
  if (host.platform === "darwin") return [...prefix, "/usr/sbin/taskpolicy", "-b", ...argv]
  if (ionice) return [...prefix, "/usr/bin/ionice", "-c3", ...argv]
  return [...prefix, ...argv]
}

/** A group-placed attempt's payload. On Linux (a host that cannot attest
 * its workload controller) it is the guard's own heavy launcher
 * (`../launcher.ts`): nice, the idle IO class and, where the user manager
 * answers its probe, a transient user scope under the guard's memory cap
 * and CPU weight. On the Mac, `payloadArgv` as before. */
export const groupPayloadArgv = Effect.fn("LaunchScope.groupPayload")(function* (host: BootHost, argv: ReadonlyArray<string>) {
  if (host.platform !== "linux") return payloadArgv(host, argv)
  const { scope, ionice } = yield* groupLauncher()
  return heavyArgv(argv, DEFAULT_LIMITS, { scope: Option.isNone(scope), ionice })
})

/** What the Linux group launcher adds to `nice` for this caller: a
 * transient user scope where `systemd-run --user --scope` answers (scope
 * is none), else the probe's failure (a login session with no user
 * manager on its bus, say); the launch then runs niced without one. */
export const groupLauncher = Effect.fn("LaunchScope.groupLauncher")(function* () {
  const scope = yield* readProcess(["/usr/bin/systemd-run", ...SCOPE_PROBE.slice(1)]).pipe(
    Effect.as(Option.none<string>()),
    Effect.catchTag("AdmissionUnavailable", ({ detail }) => Effect.succeed(Option.some(detail ?? "systemd-run --user --scope failed"))))
  return { scope, ionice: ioniceAvailable() }
})

export const spawnOwned = Effect.fn("LaunchScope.spawn")(function* (
  argv: ReadonlyArray<string>, cwd: string, environment?: Readonly<Record<string, string>>, inherited?: number,
) {
  const child = yield* Effect.try({
    try: () => {
      const base = { cwd, env: environment && { ...environment } }
      if (Predicate.isNumber(inherited)) return spawn([...argv], { ...base, stdio: ["inherit", "inherit", "inherit", inherited] })
      return spawn([...argv], { ...base, stdio: ["inherit", "inherit", "inherit"] })
    },
    catch: (error) => unavailable(`cannot start ${argv[0] ?? "the command"}: ${String(error)}`),
  })
  const port: Actuation = {
    dispatch: (intent) => Effect.sync(() => {
      if (intent.target === "retained-child" && Predicate.isNull(child.exitCode) && Predicate.isNull(child.signalCode))
        child.kill("SIGTERM")
    }),
  }
  return {
    exited: Effect.tryPromise({ try: () => child.exited, catch: () => unavailable(`${argv[0] ?? "the command"}: no exit status`) }),
    stop: issue(port, [{ target: "retained-child", signal: "TERM" }]),
  }
})

export const Offer = Schema.Struct({
  version: Schema.Literal(1),
  id: OpaqueId,
  generation: Counter,
  owner: OpaqueId,
  argv: Schema.Array(Schema.String),
  environment: Schema.Record(Schema.String, Schema.String),
})
export type Offer = typeof Offer.Type
const wireOffer = Schema.fromJsonString(Offer)
const encodeOffer = Schema.encodeSync(wireOffer)
const decodeOffer = Schema.decodeUnknownEffect(wireOffer)
const MAX_OFFER = 512 * 1024
export const localEnvironment = () =>
  Object.fromEntries(Object.entries(env).flatMap(([key, value]) => {
    if (Predicate.isString(value)) return [[key, value] as const]
    return []
  }))

const runtimeParent = (host: BootHost) => `/run/user/${host.kernel.core.symbols.getuid()}`

/** The transient service receives literal argv and environment over one
 * operation-local private Unix socket. Neither is put in SQLite, unit
 * properties, diagnostics or process arguments of the service launcher. */
export const offerToService = Effect.fn("LaunchScope.offer")(function* (host: BootHost, offer: Offer) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = runtimeParent(host)
  const stat = yield* fs.lstat(root).pipe(Effect.mapError(unqualified))
  if (stat.type !== "Directory" || (stat.mode & 0o077) !== 0 || Option.getOrUndefined(stat.uid) !== host.kernel.core.symbols.getuid())
    return yield* unqualified()
  const directory = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "host-admit-" }).pipe(Effect.mapError(unqualified))
  const socket = path.join(directory, "start")
  const encoded = encodeOffer(offer)
  if (encoded.length > MAX_OFFER) return yield* new AdmissionUnavailable({ reason: "invalid-request" })
  yield* Effect.acquireRelease(Effect.try({
    try: () => {
      let accepted = false
      return listen({ unix: socket, socket: { open(peer) {
        if (accepted) { peer.end(); return }
        accepted = true
        peer.end(encoded)
      } } })
    },
    catch: unqualified,
  }), (server) => Effect.sync(() => server.stop(true)))
  return socket
})

const receive = (socket: string) => Effect.callback<string, AdmissionUnavailable>((resume) => {
  let peer = Option.none<Socket>()
  let text = ""
  const decoder = new TextDecoder()
  void connect({
    unix: socket,
    socket: {
      open: (each) => { peer = Option.some(each) },
      data: (each, bytes) => {
        text += decoder.decode(bytes, { stream: true })
        if (text.length > MAX_OFFER) {
          resume(Effect.fail(unqualified()))
          each.end()
        }
      },
      end: () => resume(Effect.succeed(text + decoder.decode())),
      connectError: () => resume(Effect.fail(unqualified())),
      error: () => resume(Effect.fail(unqualified())),
    },
  }).catch(() => resume(Effect.fail(unqualified())))
  return Effect.sync(() => { if (Option.isSome(peer)) peer.value.end() })
})

export const takeOffer = Effect.fn("LaunchScope.takeOffer")(function* (host: BootHost, socket: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.dirname(socket)
  const parent = runtimeParent(host)
  if (host.platform !== "linux" || path.dirname(directory) !== parent || path.basename(socket) !== "start" ||
    !path.basename(directory).startsWith("host-admit-")) return yield* unqualified()
  const stat = yield* fs.lstat(directory).pipe(Effect.mapError(unqualified))
  if (stat.type !== "Directory" || (stat.mode & 0o077) !== 0 || Option.getOrUndefined(stat.uid) !== host.kernel.core.symbols.getuid())
    return yield* unqualified()
  const text = yield* receive(socket).pipe(Effect.timeout(1000), Effect.mapError(unqualified))
  return yield* decodeOffer(text).pipe(Effect.mapError(unqualified))
})
