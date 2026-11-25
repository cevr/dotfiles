import { CryptoHasher, env, readableStreamToText, spawn } from "bun"
import { dlopen, FFIType } from "bun:ffi"
import { Array as Arr, Effect, FileSystem, Option, Predicate } from "effect"
import { AdmissionUnavailable, type Observation } from "../admission.ts"
import { availableParallelism, totalmem } from "node:os"
import { type Attestation, hostEnvelope, type Measurements, measureSupply, POLICY, type Ticks, type Volume } from "../host-supply.ts"
import { type Actuation, issue } from "./actuation.ts"

const absent = () => new AdmissionUnavailable({ reason: "unavailable" })
export const readProcess = Effect.fn("HostSupply.readProcess")(function* (argv: ReadonlyArray<string>) {
  const child = yield* Effect.try({
    try: () => spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: {
      LC_ALL: "C",
      XDG_RUNTIME_DIR: env["XDG_RUNTIME_DIR"],
      DBUS_SESSION_BUS_ADDRESS: env["DBUS_SESSION_BUS_ADDRESS"],
    } }),
    catch: absent,
  })
  const port: Actuation = { dispatch: (intent) => Effect.sync(() => {
    if (intent.target === "retained-child" && Predicate.isNull(child.exitCode) && Predicate.isNull(child.signalCode))
      child.kill("SIGTERM")
  }) }
  const [code, out] = yield* Effect.all([
    Effect.tryPromise({ try: () => child.exited, catch: absent }),
    Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: absent }),
  ], { concurrency: 2 }).pipe(
    Effect.onInterrupt(() => issue(port, [{ target: "retained-child", signal: "TERM" }])),
    Effect.timeout(1000),
    Effect.mapError(absent),
  )
  if (code !== 0) return yield* absent()
  return out.trim()
})

export type Platform = "darwin" | "linux"
const scalar = (raw?: string) => Option.fromNullishOr(raw).pipe(
  Option.filter((text) => /^\d+$/u.test(text)),
  Option.map(Number),
  Option.filter(Number.isSafeInteger),
)
const positive = (value: number) => value > 0
export const ref = (kind: string, value: string) =>
  `${kind}-${new CryptoHasher("sha256").update(value).digest("hex").slice(0, 32)}`

/** Process number alone, parentage and command are never birth identity. */
export const birthRef = (bootId: string, process: { readonly pid: number; readonly start: number }) =>
  ref("birth", `${bootId}:${process.pid}:${process.start}`)

const { i32, i64, ptr, u32 } = FFIType
const libc: Readonly<Record<Platform, string>> = { darwin: "/usr/lib/libSystem.B.dylib", linux: "libc.so.6" }
export const openKernel = (platform: Platform) => {
  const file = libc[platform]
  const core = dlopen(file, {
    clock_gettime: { args: [i32, ptr], returns: i32 },
    getpid: { args: [], returns: i32 },
    getppid: { args: [], returns: i32 },
    getuid: { args: [], returns: u32 },
    getpgrp: { args: [], returns: i32 },
    isatty: { args: [i32], returns: i32 },
    setpgid: { args: [i32, i32], returns: i32 },
    flock: { args: [i32, i32], returns: i32 },
    open: { args: [ptr, i32], returns: i32 },
    close: { args: [i32], returns: i32 },
    sysconf: { args: [i32], returns: i64 },
  })
  const mach = Option.liftPredicate(file, () => platform === "darwin").pipe(Option.map((library) => dlopen(library, {
    mach_host_self: { args: [], returns: u32 },
    host_statistics: { args: [u32, i32, ptr, ptr], returns: i32 },
    proc_pidinfo: { args: [i32, i32, i64, ptr, i32], returns: i32 },
    proc_pidfdinfo: { args: [i32, i32, i32, ptr, i32], returns: i32 },
    proc_listpids: { args: [u32, u32, ptr, i32], returns: i32 },
    tcgetpgrp: { args: [i32], returns: i32 },
    tcsetpgrp: { args: [i32, i32], returns: i32 },
    sigprocmask: { args: [i32, ptr, ptr], returns: i32 },
    kill: { args: [i32, i32], returns: i32 },
  })))
  const linux = Option.liftPredicate(file, () => platform === "linux").pipe(Option.map((library) => dlopen(library, {
    statx: { args: [i32, ptr, i32, u32, ptr], returns: i32 },
  })))
  const now = () => {
    const ts = new BigInt64Array(2)
    const monotonicClock = { darwin: 6, linux: 1 }
    if (core.symbols.clock_gettime(monotonicClock[platform], ts) !== 0) return Option.none()
    const millis = Number((ts[0] ?? -1n) * 1000n + (ts[1] ?? -1n) / 1_000_000n)
    return Option.liftPredicate(millis, (value) => Number.isSafeInteger(value) && value >= 0)
  }
  return { core, mach, linux, now }
}
export type Kernel = ReturnType<typeof openKernel>

export const bootHost = Effect.fn("HostSupply.identity")(function* () {
  const fs = yield* FileSystem.FileSystem
  const system = yield* readProcess(["/usr/bin/uname", "-s"])
  if (system !== "Darwin" && system !== "Linux") return yield* absent()
  const systems = { Darwin: "darwin", Linux: "linux" } as const
  const platform = systems[system]
  const sysctl = (key: string) => readProcess(["/usr/sbin/sysctl", "-n", key])
  const read = (file: string) => fs.readFileString(file).pipe(Effect.mapError(absent), Effect.map((text) => text.trim()))
  const identities = {
    darwin: () => Effect.all([
      readProcess(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]).pipe(
        Effect.map((text) => text.match(/"IOPlatformUUID"\s*=\s*"([a-f\d-]+)"/iu)?.[1] ?? ""),
      ),
      sysctl("kern.bootsessionuuid"),
    ], { concurrency: 2 }),
    linux: () => Effect.all([read("/etc/machine-id"), read("/proc/sys/kernel/random/boot_id")], { concurrency: 2 }),
  }
  const [host, boot] = yield* identities[platform]()
  if (!/^[a-f\d-]{32,36}$/iu.test(host) || !/^[a-f\d-]{32,36}$/iu.test(boot)) return yield* absent()
  const kernel = yield* Effect.acquireRelease(Effect.try({ try: () => openKernel(platform), catch: absent }), (kernel) =>
    Effect.sync(() => {
      if (Option.isSome(kernel.mach)) kernel.mach.value.close()
      if (Option.isSome(kernel.linux)) kernel.linux.value.close()
      kernel.core.close()
    }),
  )
  return { hostId: ref("host", host), bootId: ref("boot", boot), platform, kernel }
})
export type BootHost = Effect.Success<ReturnType<typeof bootHost>>

export const linuxTicks = (text: string, at: number): Option.Option<Ticks> => {
  const cpu = text.split("\n").find((row) => row.startsWith("cpu "))
  const ticks = cpu?.trim().split(/\s+/u).slice(1, 9).map(scalar) ?? []
  if (ticks.length < 8) return Option.none()
  // user/nice already include guest and guest_nice (omitted above). iowait is
  // charged, not discarded as idle, because it may indicate blocked demand.
  return Option.map(Option.all(ticks), (values) => ({ at, total: values.reduce((sum, tick) => sum + tick, 0), idle: values[3] ?? 0 }))
}

export const darwinTicks = (kernel: Kernel, at: number): Option.Option<Ticks> => {
  if (Option.isNone(kernel.mach)) return Option.none()
  const symbols = kernel.mach.value.symbols
  const ticks = new Uint32Array(4)
  const count = new Uint32Array([ticks.length])
  if (symbols.host_statistics(symbols.mach_host_self(), 3, ticks, count) !== 0 || count[0] !== 4) return Option.none()
  return Option.some({ at, total: ticks.reduce((sum, tick) => sum + tick, 0), idle: ticks[2] ?? 0 })
}

export const clockOf = Effect.fn("HostSupply.clock")(function* (host: BootHost) {
  const at = yield* Effect.sync(host.kernel.now)
  if (Option.isNone(at)) return yield* absent()
  return at.value
})

const DF = "/bin/df"
const last = (text: string) => text.split("\n").at(-1)?.trim().split(/\s+/u)
export const volumeIdentity = Effect.fn("HostSupply.volumeIdentity")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const cwd = yield* fs.realPath(path).pipe(Effect.mapError(absent))
  const data = yield* readProcess([DF, "-kP", cwd])
  const fields = last(data)
  const totalBlocks = scalar(fields?.[1])
  const freeBlocks = scalar(fields?.[3])
  const mount = fields?.slice(5).join(" ")
  if (!fields?.[0] || !mount || Option.isNone(freeBlocks) || Option.isNone(totalBlocks)) return yield* absent()
  const stat = yield* fs.stat(cwd).pipe(Effect.mapError(absent))
  return { cwd, id: ref("volume", `${stat.dev}:${fields[0]}`), object: mount,
    capacityBytes: totalBlocks.value * 1024, freeBytes: freeBlocks.value * 1024, diskFloorBytes: POLICY.diskFloorBytes }
})

const sampleVolume = Effect.fn("HostSupply.sampleVolume")(function* (host: BootHost, volume: Effect.Success<ReturnType<typeof volumeIdentity>>) {
  const { cwd, id, object, capacityBytes, freeBytes, diskFloorBytes } = volume
  const nodeFields = last(yield* readProcess([DF, "-ki", cwd]))
  const fsTypeOf = { linux: () => readProcess(["/usr/bin/stat", "-f", "-c", "%T", cwd]), darwin: () => Effect.succeed("apfs") }
  const fsType = yield* fsTypeOf[host.platform]()
  const inodeIndex = { darwin: 6, linux: 3 }
  let freeInodes: Option.Option<Volume["freeInodes"]> = scalar(nodeFields?.[inodeIndex[host.platform]])
  if (fsType === "btrfs") freeInodes = Option.some("dynamic")
  if (Option.isNone(freeInodes)) return yield* absent()
  // A Linux btrfs mount's metadata budget is not interchangeable with its
  // data budget. Unknown metadata is fail-closed rather than assumed free.
  let metadataFreeBytes = freeBytes
  if (fsType === "btrfs") metadataFreeBytes = yield* linuxMetadata(cwd)
  const sample: Volume = { capacityBytes, freeBytes, freeInodes: freeInodes.value, metadataFreeBytes, diskFloorBytes }
  return { id, sample, object }
})
export const volumeOf = (host: BootHost, path: string) =>
  volumeIdentity(path).pipe(Effect.flatMap((volume) => sampleVolume(host, volume)))

const linuxMetadata = Effect.fn("HostSupply.linuxMetadata")(function* (cwd: string) {
  const raw = yield* readProcess(["/usr/bin/btrfs", "filesystem", "usage", "-b", cwd])
  const totals = [...raw.matchAll(/^\s*Metadata,.*?Size:\s*(\d+),\s*Used:\s*(\d+)\s*$/gmu)]
  if (totals.length === 0) return yield* absent()
  return totals.reduce((headroom, [, size, used]) => headroom + Math.max(0, Number(size) - Number(used)), 0)
})

export const cgroupOf = (raw: string) => {
  const path = raw.trim().split("\n").find((line) => line.startsWith("0::"))?.slice(3)
  return Option.filter(Option.fromNullishOr(path), (value) => value.startsWith("/") && !value.split("/").includes(".."))
}
export const cpuMax = (text: string): Option.Option<number> => {
  const [quota, period] = text.trim().split(/\s+/u)
  const q = scalar(quota)
  const p = Option.filter(scalar(period), positive)
  if (Option.isNone(p)) return p
  if (quota === "max") return Option.some(Number.MAX_SAFE_INTEGER)
  return Option.map(q, (count) => Math.floor((count * 1000) / p.value))
}
export const cpuList = (text: string): Option.Option<number> => {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(text.trim())) return Option.none()
  let n = 0
  let last = -1
  for (const part of text.trim().split(",")) {
    const [start, high] = part.split("-")
    const low = scalar(start)
    if (Option.isNone(low)) return low
    const end = Option.getOrElse(scalar(high), () => low.value)
    if (end < low.value || low.value <= last) return Option.none()
    n += end - low.value + 1
    last = end
  }
  return Option.liftPredicate(n, Number.isSafeInteger)
}
const psi = (text: string, group: "some" | "full") => {
  const raw = text.split("\n").find((line) => line.startsWith(`${group} `))?.match(/\bavg10=(\d+(?:\.\d+)?) /u)?.[1]
  const value = Number(raw)
  return Option.liftPredicate(value, (n) => Number.isFinite(n) && n >= 0 && n <= 100)
}

const memField = (out: string, field: string) => scalar(out.split("\n").find((line) => line.startsWith(`${field}:`))?.trim().split(/\s+/u)[1])
const cpuField = (text: string, key: string) => scalar(text.split("\n").find((line) => line.startsWith(`${key} `))?.trim().split(/\s+/u)[1])

export const WORKLOAD_SLICE = "agentwork.slice"
export const CONTROL_SLICE = "opencodecontrol.slice"
export const SYSTEM_SLICE = "bite.slice"
interface LinuxBudget {
  readonly control: string
  readonly parent: string
  readonly cap: number
  readonly memoryCap: number
  readonly protected: ReadonlyArray<string>
}

const ioWeight = (text: string) => scalar(text.trim().split(/\s+/u)[1])
const qualifiedMeters = (cpu: string, events: string, pressures: ReadonlyArray<string>) =>
  [cpuField(cpu, "usage_usec"), cpuField(cpu, "throttled_usec"), cpuField(events, "oom"),
    ...pressures.map((text) => psi(text, "some"))].every(Option.isSome)

/** Where the Linux reads look: the cgroup mount, /proc, the online CPU list,
 * the user manager's slice lookup and the host's own processor count and
 * memory (the last resort when no file says), so a test runs them on a
 * fixture tree. */
export interface LinuxSources {
  readonly cgroupRoot: string
  readonly proc: string
  readonly cpuOnline: string
  readonly processors: number
  readonly memoryBytes: number
  readonly slice: (unit: string) => Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem>
}
export const hostSources = (): LinuxSources => ({
  cgroupRoot: "/sys/fs/cgroup", proc: "/proc", cpuOnline: "/sys/devices/system/cpu/online",
  processors: availableParallelism(), memoryBytes: totalmem(),
  slice: (unit) => readProcess(["/usr/bin/systemctl", "--user", "show", unit, "-p", "ControlGroup", "--value"]).pipe(
    Effect.map((text) => Option.liftPredicate(text, (value) => value.length > 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  ),
})

const textOf = Effect.fn("HostSupply.text")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(Effect.option)
})
const number = (text: string) => scalar(text.trim())
/** Each directory from `path` up to the cgroup root, nearest first. */
const chainOf = (root: string, path: string) => {
  const names = path.slice(root.length).split("/").filter(Boolean)
  return [...names.map((_, i) => `${root}/${names.slice(0, names.length - i).join("/")}`), root]
}

/** Whether this kernel weighs IO at all: a weight policy (io.cost or BFQ)
 * gives every cgroup with the io controller an `io.weight`; none has one
 * without it (the workbox's 6.12 kernel). */
const ioOf = Effect.fn("HostSupply.ioWeights")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  const found = yield* Effect.forEach(entries.slice(0, 256), (entry) =>
    fs.exists(`${root}/${entry}/io.weight`).pipe(Effect.orElseSucceed(() => false)), { concurrency: 4 })
  if (found.some(Boolean)) return "weighted" as const
  return "unavailable" as const
})

interface Requirement {
  readonly file: string
  readonly needs: string
  readonly holds: (text: string) => boolean
}
const requirement = (file: string, needs: string, holds: Requirement["holds"]): Requirement => ({ file, needs, holds })
const atLeast = (minimum: number) => (text: string) => Option.exists(number(text), (value) => value >= minimum)

/** What an enforced host carries, in the order a shortfall is named: the
 * workload slice's caps and meters, then each protected sibling's floors.
 * The IO weights count only on a kernel that weighs IO. */
const requirements = (control: string, protectedScopes: ReadonlyArray<string>, io: Attestation["io"],
  value: (file: string) => Option.Option<string>): ReadonlyArray<Requirement> => {
  const weighted = io === "weighted"
  const memoryCap = Option.flatMap(value(`${control}/memory.max`), number)
  const withinCap = (text: string, above: number) =>
    Option.exists(Option.all([number(text), memoryCap]), ([used, cap]) => used >= above && used <= cap)
  const pressures = ["cpu.pressure", "memory.pressure", ...["io.pressure"].filter(() => weighted)]
  return [
    requirement(`${control}/cpu.max`, "a finite CPU cap of at least one core (CPUQuota=)",
      (text) => Option.exists(cpuMax(text), (cap) => cap !== Number.MAX_SAFE_INTEGER && cap >= 1000)),
    requirement(`${control}/cpu.weight`, "CPU weight 20 (CPUWeight=20)", (text) => Option.exists(number(text), (weight) => weight === 20)),
    ...[requirement(`${control}/io.weight`, "IO weight at most 100 (IOWeight=)",
      (text) => Option.exists(ioWeight(text), (weight) => weight <= 100))].filter(() => weighted),
    requirement(`${control}/memory.max`, "a finite memory cap (MemoryMax=)", (text) => Option.isSome(number(text))),
    requirement(`${control}/memory.high`, "a memory high mark above 0, at most memory.max (MemoryHigh=)", (text) => withinCap(text, 1)),
    requirement(`${control}/memory.swap.max`, "a swap cap (MemorySwapMax=)", (text) => Option.isSome(number(text))),
    requirement(`${control}/memory.current`, "memory use within memory.max", (text) => withinCap(text, 0)),
    requirement(`${control}/pids.max`, "a finite task cap (TasksMax=)", atLeast(1)),
    requirement(`${control}/cpu.stat`, "usage_usec and throttled_usec counters",
      (text) => Option.isSome(cpuField(text, "usage_usec")) && Option.isSome(cpuField(text, "throttled_usec"))),
    requirement(`${control}/memory.events`, "an oom counter", (text) => Option.isSome(cpuField(text, "oom"))),
    ...pressures.map((name) => requirement(`${control}/${name}`, "a pressure reading (some avg10=)", (text) => Option.isSome(psi(text, "some")))),
    ...protectedScopes.flatMap((scope) => [
      requirement(`${scope}/cpu.weight`, "CPU weight at least 1000 (CPUWeight=1000)", atLeast(1000)),
      ...[requirement(`${scope}/io.weight`, "IO weight at least 1000 (IOWeight=1000)",
        (text) => Option.exists(ioWeight(text), (weight) => weight >= 1000))].filter(() => weighted),
      requirement(`${scope}/memory.min`, "a memory floor above 0 (MemoryMin=)", atLeast(1)),
      requirement(`${scope}/memory.low`, "a memory low mark above 0 (MemoryLow=)", atLeast(1)),
    ]),
  ]
}

/** The workload controller as the tree proves it. Never a failure: a
 * missing or wrong file makes the host `unattested`, naming that file. */
export const linuxBudget = Effect.fn("HostSupply.linuxBudget")(function* (sources: LinuxSources = hostSources()) {
  const root = sources.cgroupRoot
  const io = yield* ioOf(root)
  const relative = Option.filter(yield* sources.slice(WORKLOAD_SLICE), (path) =>
    path.startsWith("/") && !path.split("/").includes("..") && path.endsWith(`/${WORKLOAD_SLICE}`))
  if (Option.isNone(relative)) return {
    budget: Option.none<LinuxBudget>(),
    attestation: { controller: "unattested", io, file: WORKLOAD_SLICE,
      why: `the user manager has no active ${WORKLOAD_SLICE} (systemctl --user show ${WORKLOAD_SLICE} -p ControlGroup is empty)` },
  } satisfies { readonly budget: Option.Option<LinuxBudget>; readonly attestation: Attestation }
  const control = `${root}${relative.value}`
  const parent = control.slice(0, control.lastIndexOf("/"))
  const protectedScopes = [`${parent}/${CONTROL_SLICE}`, `${root}/${SYSTEM_SLICE}`]
  const files = new Map<string, Option.Option<string>>()
  const value = (file: string) => files.get(file) ?? Option.none()
  const wanted = requirements(control, protectedScopes, io, () => Option.none()).map(({ file }) => file)
  const texts = yield* Effect.forEach(wanted, textOf, { concurrency: 4 })
  wanted.forEach((file, i) => files.set(file, texts[i] ?? Option.none()))
  const shortfall = requirements(control, protectedScopes, io, value).find(({ file, holds }) => !Option.exists(value(file), holds))
  if (shortfall) return {
    budget: Option.none<LinuxBudget>(),
    attestation: { controller: "unattested", io, file: shortfall.file,
      why: `${Option.match(value(shortfall.file), { onNone: () => "missing", onSome: () => "out of range" })}: needs ${shortfall.needs}` },
  } satisfies { readonly budget: Option.Option<LinuxBudget>; readonly attestation: Attestation }
  const cap = Option.getOrElse(Option.flatMap(value(`${control}/cpu.max`), cpuMax), () => 0)
  const memoryCap = Option.getOrElse(Option.flatMap(value(`${control}/memory.max`), number), () => 0)
  return {
    budget: Option.some<LinuxBudget>({ control, cap, memoryCap, parent, protected: protectedScopes }),
    attestation: { controller: "enforced", io },
  } satisfies { readonly budget: Option.Option<LinuxBudget>; readonly attestation: Attestation }
})
export type LinuxAttestation = Effect.Success<ReturnType<typeof linuxBudget>>

/** CPU from the nearest cpuset.cpus.effective up the tree, else the online
 * CPUs, else the processor count; every ancestor's cpu.max and memory.max
 * bound it. Each limit is optional data: an absent file is no limit. */
const linuxEffective = Effect.fn("HostSupply.linuxEffective")(function* (sources: LinuxSources, budget: Option.Option<LinuxBudget>) {
  const root = sources.cgroupRoot
  const online = Option.flatMap(yield* textOf(sources.cpuOnline), cpuList).pipe(Option.filter(positive))
  const hostCpus = Option.getOrElse(online, () => Math.max(1, sources.processors))
  const own = Option.flatMap(yield* textOf(`${sources.proc}/self/cgroup`), cgroupOf)
  const at = Option.match(budget, {
    onSome: ({ control }) => control,
    onNone: () => Option.match(own, { onSome: (relative) => `${root}${relative}`, onNone: () => root }),
  })
  const cpusets = yield* Effect.forEach(chainOf(root, at), (path) => textOf(`${path}/cpuset.cpus.effective`), { concurrency: 4 })
  const slots = Option.getOrElse(Arr.findFirst(cpusets, (text) => Option.exists(Option.flatMap(text, cpuList), positive)).pipe(
    Option.flatMap((text) => Option.flatMap(text, cpuList))), () => hostCpus)
  const bounded = chainOf(root, Option.match(budget, { onSome: ({ parent }) => parent, onNone: () => at }))
  const [caps, memories] = yield* Effect.all([
    Effect.forEach(bounded, (path) => textOf(`${path}/cpu.max`).pipe(Effect.map(Option.flatMap(cpuMax))), { concurrency: 4 }),
    Effect.forEach(bounded, (path) => textOf(`${path}/memory.max`).pipe(Effect.map(Option.flatMap(memoryMax))), { concurrency: 4 }),
  ], { concurrency: 2 })
  const memoryLimit = Option.filter(Option.some(Math.min(...Arr.getSomes(memories))),
    (bytes) => Number.isSafeInteger(bytes) && bytes < Number.MAX_SAFE_INTEGER)
  const limits = {
    hostCpuMilli: hostCpus * 1000,
    effectiveCpuMilli: Math.min(hostCpus * 1000, slots * 1000, ...Arr.getSomes(caps)),
  }
  return Option.match(budget, {
    onNone: () => ({ ...limits, memoryLimit }),
    onSome: ({ cap, memoryCap }) => ({ ...limits, memoryLimit: Option.none<number>(), containedCpuMilli: cap,
      containedMemoryBytes: Math.min(memoryCap, ...Arr.getSomes(memories)) }),
  })
})

const memoryMax = (text: string) => {
  const value = text.trim()
  if (value === "max") return Option.some(Number.MAX_SAFE_INTEGER)
  return scalar(value)
}

export interface MeteredScope {
  readonly binding: string
  readonly path: string
  readonly cpuMilli: number
}

const counterOf = Effect.fn("HostSupply.counter")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(`${path}/cpu.stat`).pipe(Effect.mapError(absent), Effect.map((text) => cpuField(text, "usage_usec")))
})

const checkedCounter = Effect.fn("HostSupply.scopedCounter")(function* (scope: MeteredScope) {
  const fs = yield* FileSystem.FileSystem
  const read = (entry: string) => fs.readFileString(`${scope.path}/${entry}`).pipe(Effect.mapError(absent))
  const [quota, stat, current, events, cpu, memory, io] = yield* Effect.all([
    read("cpu.max"), read("cpu.stat"), read("memory.current"), read("memory.events"),
    read("cpu.pressure"), read("memory.pressure"), read("io.pressure"),
  ], { concurrency: 2 })
  const actual = cpuMax(quota)
  if (!Option.exists(actual, (cores) => cores > 0 && cores <= scope.cpuMilli) ||
    Option.isNone(scalar(current.trim())) || !qualifiedMeters(stat, events, [cpu, memory, io])) return Option.none()
  return cpuField(stat, "usage_usec")
})

const delta = (first: Option.Option<number>, last: Option.Option<number>) =>
  Option.filter(Option.map(Option.all([first, last]), ([before, after]) => after - before), (n) => n >= 0)
export const linuxPressure = ({ cpu, memory, io, swap }: {
  readonly cpu: number; readonly memory: number; readonly io: number; readonly swap: number
}): Measurements["pressure"] => {
  if (cpu >= 50 || memory >= 10 || io >= 25) return "hold"
  if (cpu >= 20 || memory >= 2 || io >= 10 || swap >= 1024) return "degraded"
  return "clear"
}
const swapPages = (text: string) => Option.map(Option.all([cpuField(text, "pswpin"), cpuField(text, "pswpout")]), ([a, b]) => a + b)

const linuxSupply = Effect.fn("HostSupply.linux")(function* (host: BootHost, scopes: ReadonlyArray<MeteredScope>) {
  const fs = yield* FileSystem.FileSystem
  const read = (p: string) => fs.readFileString(p).pipe(Effect.mapError(absent))
  const { budget, attestation } = yield* linuxBudget(hostSources())
  const { memoryLimit, ...limits } = yield* linuxEffective(hostSources(), budget)
  const metered = Option.match(budget, {
    onNone: () => [],
    onSome: ({ control }) => scopes.filter((scope) => scope.path.startsWith(`${control}/host-admit-`)),
  })
  const bareProtected = Option.match(budget, { onNone: () => [], onSome: ({ protected: scopes }) => scopes })
  const counters = () => Effect.all([
    Effect.forEach(bareProtected, counterOf, { concurrency: 2 }),
    Effect.forEach(metered, checkedCounter, { concurrency: 1 }),
  ], { concurrency: 2 }).pipe(Effect.map(([base, live]) => [...base, ...live]))
  const start = yield* clockOf(host)
  const [first, vmBefore, usageBefore] = yield* Effect.all([
    read("/proc/stat"), read("/proc/vmstat"),
    counters(),
  ], { concurrency: 2 })
  yield* Effect.sleep(160)
  const [second, vmAfter, usageAfter, mem, cpu, memory, io] = yield* Effect.all([
    read("/proc/stat"), read("/proc/vmstat"),
    counters(),
    read("/proc/meminfo"), read("/proc/pressure/cpu"), read("/proc/pressure/memory"), read("/proc/pressure/io"),
  ], { concurrency: 4 })
  const end = yield* clockOf(host)
  const fields = Option.all({
    before: linuxTicks(first, start), after: linuxTicks(second, end), runnable: cpuField(second, "procs_running"),
    memKB: memField(mem, "MemAvailable"), totalKB: memField(mem, "MemTotal"), cpuPSI: psi(cpu, "some"), memPSI: psi(memory, "some"), ioPSI: psi(io, "some"),
    swap: delta(swapPages(vmBefore), swapPages(vmAfter)),
  })
  if (Option.isNone(fields) || end <= start) return yield* absent()
  const { before, after, runnable, memKB, totalKB, cpuPSI, memPSI, ioPSI, swap } = fields.value
  const usage = usageAfter.map((after, i) => {
    const [before = Option.none()] = usageBefore.slice(i)
    return Option.match(delta(before, after), { onNone: () => -1, onSome: (step) => step / (end - start) })
  })
  const countProtected = bareProtected.length
  const protectedLowerBoundMilli = usage.slice(0, countProtected).reduce((sum, use) => sum + Math.max(0, Math.floor(use)), 0)
  const managed = metered.map((scope, i) => ({ binding: scope.binding, measuredCpuMilli: Math.ceil(usage[i + countProtected] ?? -1), enforcedCpuMilli: scope.cpuMilli }))
  const bound = (bytes: number) => Option.match(memoryLimit, { onNone: () => bytes, onSome: (limit) => Math.min(bytes, limit) })
  return {
    ...limits, before, after, runnable, memoryBytes: bound(memKB * 1024), totalMemoryBytes: bound(totalKB * 1024),
    controllerAvailable: Option.isSome(budget), attestation,
    pressure: linuxPressure({ cpu: cpuPSI, memory: memPSI, io: ioPSI, swap }),
    qualified: Option.isSome(budget) && usage.every((value) => value >= 0) && metered.length === scopes.length,
    managed, protectedLowerBoundMilli,
  } satisfies Omit<Measurements, "id" | "platform" | "volumes" | "keys">
})

const macCounter = (text: string, name: string) =>
  scalar(text.split("\n").find((line) => line.startsWith(`${name}:`))?.trim().split(/\s+/u).at(-1)?.replace(/\.$/u, ""))
const macPressure = (level: number, headroom: number, pages: ReadonlyArray<number>): Measurements["pressure"] => {
  if (level >= 4 || headroom < 10) return "hold"
  if (level !== 1 || headroom < 25 || pages.some((delta) => delta > 1024)) return "degraded"
  return "clear"
}

const darwinSupply = Effect.fn("HostSupply.darwin")(function* (host: BootHost) {
  const start = yield* clockOf(host)
  const before = darwinTicks(host.kernel, start)
  const first = yield* readProcess(["/usr/bin/vm_stat"])
  yield* Effect.sleep(160)
  const [coresText, stats, pressureText, vm, processes, swap] = yield* Effect.all([
    readProcess(["/usr/sbin/sysctl", "-n", "hw.activecpu"]), readProcess(["/usr/bin/memory_pressure", "-Q"]),
    readProcess(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"]), readProcess(["/usr/bin/vm_stat"]),
    readProcess(["/bin/ps", "-ax", "-o", "stat="]), readProcess(["/usr/sbin/sysctl", "-n", "vm.swapusage"]),
  ], { concurrency: 3 })
  const end = yield* clockOf(host)
  const pages = ["Pageouts", "Swapouts", "Pages occupied by compressor"].map((key) =>
    Option.map(Option.all([macCounter(first, key), macCounter(vm, key)]), ([previous, current]) => current - previous))
  const fields = Option.all({
    before, after: darwinTicks(host.kernel, end), cores: Option.filter(scalar(coresText), positive), level: scalar(pressureText),
    headroom: scalar(stats.match(/System-wide memory free percentage:\s*(\d+)%/u)?.[1]),
    physical: Option.filter(scalar(stats.match(/system has (\d+) \(/iu)?.[1]), positive),
    pages: Option.all(pages),
  })
  if (Option.isNone(fields) || !/\bused = [\d.]+[KMG]/u.test(swap)) return yield* absent()
  const { before: startTicks, after, cores, level, headroom, physical, pages: growth } = fields.value
  return {
    before: startTicks, after, hostCpuMilli: cores * 1000, effectiveCpuMilli: cores * 1000,
    runnable: processes.split("\n").filter((state) => state.trim().startsWith("R")).length,
    memoryBytes: Math.floor(physical * Math.min(headroom, 100) / 100),
    totalMemoryBytes: physical, controllerAvailable: true,
    pressure: macPressure(level, headroom, growth),
    qualified: true, managed: [], protectedLowerBoundMilli: 0,
  } satisfies Omit<Measurements, "id" | "platform" | "volumes" | "keys">
})

export const CORE_KEYS: ReadonlyArray<string> = ["gate", "vm", "trace", "build"]
const darwinLimits = Effect.fn("HostSupply.darwinLimits")(function* () {
  const [cpu, memory] = yield* Effect.all([
    readProcess(["/usr/sbin/sysctl", "-n", "hw.activecpu"]), readProcess(["/usr/sbin/sysctl", "-n", "hw.memsize"]),
  ], { concurrency: 2 })
  const capacity = Option.all([scalar(cpu), scalar(memory)])
  if (Option.isNone(capacity)) return yield* absent()
  const [cores, totalMemoryBytes] = capacity.value
  return { effectiveCpuMilli: cores * 1000, totalMemoryBytes, controllerAvailable: true }
})

/** Never a failure: each limit it cannot read is no limit, and the host's
 * own processor count and memory stand in for /proc. */
export const linuxLimits = Effect.fn("HostSupply.linuxLimits")(function* (sources: LinuxSources = hostSources()) {
  const { budget, attestation } = yield* linuxBudget(sources)
  const { memoryLimit, ...limits } = yield* linuxEffective(sources, budget)
  const total = Option.flatMap(yield* textOf(`${sources.proc}/meminfo`), (text) => memField(text, "MemTotal")).pipe(
    Option.filter(positive), Option.map((kb) => kb * 1024))
  const memory = Option.getOrElse(total, () => sources.memoryBytes)
  return {
    ...limits, totalMemoryBytes: Option.match(memoryLimit, { onNone: () => memory, onSome: (limit) => Math.min(memory, limit) }),
    controllerAvailable: Option.isSome(budget), attestation,
  }
})

/** The Linux envelope from `sources` alone, no volumes: what the fixture tests read. */
export const linuxEnvelope = (sources: LinuxSources) => linuxLimits(sources).pipe(
  Effect.map((capacity) => hostEnvelope({ ...capacity, platform: "linux", volumes: {}, keys: CORE_KEYS })),
)

export const envelopeOf = Effect.fn("HostSupply.envelope")(function* (host: BootHost, targets: ReadonlyArray<string>) {
  const limits = { darwin: darwinLimits, linux: linuxLimits }
  const [read, capacity] = yield* Effect.all([
    Effect.forEach(targets, (target) => volumeIdentity(target).pipe(Effect.option), { concurrency: 2 }),
    limits[host.platform](),
  ], { concurrency: 2 })
  const volumes = Object.fromEntries(Arr.getSomes(read).map((volume) =>
    [volume.id, volume]))
  return hostEnvelope({ ...capacity, platform: host.platform, volumes, keys: CORE_KEYS })
})

export const observationOf = Effect.fn("HostSupply.sample")(function* (
  host: BootHost, targets: ReadonlyArray<string>, metered: ReadonlyArray<MeteredScope> = [],
): Effect.fn.Return<Observation, AdmissionUnavailable, FileSystem.FileSystem> {
  const started = yield* clockOf(host)
  const identities = Arr.getSomes(yield* Effect.forEach(targets, (path) => volumeIdentity(path).pipe(Effect.option), { concurrency: 2 }))
  const volumes = Arr.getSomes(yield* Effect.forEach(identities, (volume) => sampleVolume(host, volume).pipe(Effect.option), { concurrency: 2 }))
  const measure = { darwin: () => darwinSupply(host), linux: () => linuxSupply(host, metered) }
  const measurements = yield* measure[host.platform]()
  const now = yield* clockOf(host)
  const observed = {
    ...measurements, id: `sample-${measurements.after.at}`, platform: host.platform, keys: CORE_KEYS,
    volumes: Object.fromEntries(volumes.map(({ id, sample }) => [id, sample])),
  }
  const envelope = hostEnvelope({ ...observed, volumes: Object.fromEntries(identities.map((volume) => [volume.id, volume])) })
  if (now - started > POLICY.freshnessMs) return { now, envelope }
  const sample = measureSupply(observed, envelope)
  if (Option.isNone(sample)) return { now, envelope }
  return { now, envelope, sample: sample.value }
})
