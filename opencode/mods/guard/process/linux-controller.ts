import { Effect, Option } from "effect"
import { AdmissionUnavailable } from "../admission.ts"
import type { Reply } from "../admission-wire.ts"
import { cgroupOf, cpuMax } from "./admission.ts"
import { issue, type Actuation } from "./actuation.ts"

const unqualified = (detail: string) => new AdmissionUnavailable({ reason: "unqualified", detail })
export type Liveness = "gone" | "live" | "unknown"
export type DescriptorState = "gone" | "held" | "unknown"

export interface LinuxManager<R = never> {
  readonly workloadRoot: Effect.Effect<string, AdmissionUnavailable, R>
  readonly currentGroup: Effect.Effect<string, AdmissionUnavailable, R>
  readonly read: (file: string) => Effect.Effect<string, AdmissionUnavailable, R>
  readonly exists: (file: string) => Effect.Effect<boolean, AdmissionUnavailable, R>
  readonly stop: (ownedUnit: string) => Effect.Effect<void, AdmissionUnavailable, R>
}

const mountedGroup = <R>(manager: LinuxManager<R>) => manager.currentGroup.pipe(
  Effect.map((text) => Option.map(cgroupOf(text), (path) => `/sys/fs/cgroup${path}`)),
)

export const attestLinux = Effect.fn("LinuxController.attest")(function* <R>(
  manager: LinuxManager<R>, unit: string, cpuMilli: number, memoryBytes: number,
) {
  const root = yield* manager.workloadRoot
  const expected = `${root}/${unit}.service`
  const actual = yield* mountedGroup(manager)
  if (!Option.exists(actual, (found) => found === expected))
    return yield* unqualified(`the helper runs in ${Option.getOrElse(actual, () => "no readable cgroup")}, not its unit ${expected}`)
  const read = (entry: string) => manager.read(`${expected}/${entry}`)
  const { cpu, max, swap, grouping } = yield* Effect.all({
    cpu: read("cpu.max"), max: read("memory.max"), swap: read("memory.swap.max"), grouping: read("memory.oom.group"),
  }, { concurrency: 2 })
  const bound = cpuMax(cpu)
  const memory = Number(max.trim())
  if (!Option.exists(bound, (value) => value > 0 && value <= cpuMilli) ||
    !Number.isSafeInteger(memory) || memory <= 0 || memory > memoryBytes || swap.trim() !== "0" || grouping.trim() !== "1")
    return yield* unqualified(`${expected} does not carry the lease's caps: cpu.max "${cpu.trim()}" (at most ${cpuMilli} mCPU), ` +
      `memory.max "${max.trim()}" (at most ${memoryBytes}), memory.swap.max "${swap.trim()}" (0), ` +
      `memory.oom.group "${grouping.trim()}" (1)`)
  return expected
})

export const stopLinux = Effect.fn("LinuxController.stop")(function* <R>(
  manager: LinuxManager<R>, path: string, owned: boolean,
) {
  const group = yield* mountedGroup(manager)
  const unit = path.split("/").at(-1)
  if (!owned || !Option.exists(group, (actual) => actual === path) || !unit || !/^host-admit-run-[a-f0-9]{32}\.service$/u.test(unit))
    return yield* unqualified(`refusing to stop ${path}: not this process's own one-use host-admit unit`)
  const port: Actuation<AdmissionUnavailable, R> = {
    dispatch: (intent) => {
      if (intent.target === "current-unit") return manager.stop(unit)
      return Effect.fail(unqualified(`no actuator for ${intent.target}`))
    },
  }
  yield* issue(port, [{ target: "current-unit", signal: "TERM" }])
})

export interface AttachIdentity {
  readonly id: string
  readonly owner: string
  readonly generation: number
}

/** One-use offer is decoded by the socket adapter, then matched to a
 * durable grant before entering the child's placement/claim fence. */
export const attachGrant = <A extends AttachIdentity & { readonly state: string }, O, E, R>(
  offered: AttachIdentity, grant: Option.Option<A>, accepted: (matched: A) => Effect.Effect<O, E, R>,
): Effect.Effect<O, E | AdmissionUnavailable, R> => {
  if (Option.isNone(grant)) return Effect.fail(new AdmissionUnavailable({ reason: "stale" }))
  const row = grant.value
  if (row.id !== offered.id || row.owner !== offered.owner || row.generation !== offered.generation || row.state !== "granted")
    return Effect.fail(new AdmissionUnavailable({ reason: "stale" }))
  return accepted(row)
}

/** A placed supervisor is still inert. Only the fresh durable claim makes
 * the passed (owned) executor reachable; a superseded grant may retry. */
export const runAfterClaim = <A, E, R>(reply: Pick<Reply, "state" | "reason">, exec: () => Effect.Effect<A, E, R>):
  Effect.Effect<Option.Option<A>, E | AdmissionUnavailable, R> => {
  if (reply.state === "queued" || reply.state === "granted") return Effect.succeed(Option.none())
  if (reply.state !== "running") return Effect.fail(new AdmissionUnavailable({ reason: reply.reason }))
  return exec().pipe(Effect.asSome)
}

export const linuxDrain = Effect.fn("LinuxController.drain")(function* <R>(
  manager: LinuxManager<R>, path: string, descriptor: DescriptorState,
): Effect.fn.Return<Liveness, never, R> {
  if (descriptor === "held") return "live"
  if (descriptor !== "gone") return "unknown"
  const events = yield* manager.read(`${path}/cgroup.events`).pipe(Effect.option)
  if (Option.isSome(events)) {
    if (/^populated 0$/mu.test(events.value)) return "gone"
    if (/^populated 1$/mu.test(events.value)) return "live"
    return "unknown"
  }
  const exists = yield* manager.exists(path).pipe(Effect.option)
  if (Option.exists(exists, (found) => !found)) return "gone"
  return "unknown"
})
