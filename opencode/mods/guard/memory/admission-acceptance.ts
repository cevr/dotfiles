import { Effect, Option, Schema } from "effect"
import { type Observation, type ShellIdentity } from "../admission.ts"
import { widthOf, type Request } from "../admission-wire.ts"
import { POLICY, type Supply } from "../host-supply.ts"

export const owner = (id: string) => `fixture-${id}`
const classOf = (exclusive: boolean): Request["purpose"] => {
  if (exclusive) return "exclusive-check"
  return "check"
}

export const request = (id: string, cpuMilli = 1000, exclusive = false): Request => ({
  version: 1, requestId: id, principal: { kind: "external-runner", scopeId: id, epoch: 1 },
  purpose: classOf(exclusive), tier: "standard", deadlineBootMs: 100_000,
  demand: { width: Option.getOrElse(widthOf(Math.ceil(cpuMilli / 1000)), () => "unknown" as const),
    cpuMilli, memoryBytes: 0, ioClass: "idle", keys: [], volumeReservations: [{ volumeId: "volume-a", bytes: 0 }] },
})

export const supply = (input: {
  readonly now?: number
  readonly cores?: number
  readonly overrides?: Partial<Supply>
} = {}): Observation => {
  const { now = 0, cores = 16 } = input
  const free = { freeBytes: 12 * 2 ** 30, metadataFreeBytes: 2 ** 30, freeInodes: 50_000, diskFloorBytes: POLICY.diskFloorBytes }
  return {
    now,
    sample: {
      id: `sample-${now}`, at: now, effectiveCpuMilli: cores * 1000, outsideNoncriticalMilli: 0, protectedCpuMilli: POLICY.reserveCpuMilli,
      memoryBytes: 32 * 2 ** 30, pressure: "clear", qualification: "enforced", runnable: 0, managed: [],
      volumes: { "volume-a": free, "volume-b": free }, keys: ["device-a", "device-b"],
      ...input.overrides,
    },
  }
}

export interface ShellLaunchDriver {
  readonly permission: (shell: ShellIdentity, verdict: "pending" | "allowed" | "denied", origin: "model" | "native") => Effect.Effect<void>
  readonly bind: (shell: ShellIdentity, handle: string) => Effect.Effect<void>
  readonly owner: (shell: ShellIdentity, state: "terminal" | "handoff" | "unknown") => Effect.Effect<void>
  readonly finish: (shell: ShellIdentity, handle: string, state: "gone" | "live" | "unknown") => Effect.Effect<void>
  readonly restart: () => Effect.Effect<void>
  readonly launches: () => Effect.Effect<ReadonlyArray<string>>
  readonly held: () => Effect.Effect<ReadonlyArray<string>>
  readonly input: (shell: ShellIdentity, value: string) => Effect.Effect<void>
  readonly place: (shell: ShellIdentity, state: "verified" | "rejected") => Effect.Effect<void>
  readonly cancel: (shell: ShellIdentity) => Effect.Effect<void>
  readonly transportFailure: (shell: ShellIdentity, phase: "before-ack" | "after-bind") => Effect.Effect<void>
  readonly complete: (shell: ShellIdentity, exit: ShellExit) => Effect.Effect<void>
  readonly snapshot: () => Effect.Effect<{ readonly watermark: number; readonly shells: ReadonlyArray<string> }>
  readonly replay: (after: number) => Effect.Effect<ReadonlyArray<string>>
  readonly payloads: () => Effect.Effect<ReadonlyArray<string>>
  readonly wakes: () => Effect.Effect<ReadonlyArray<string>>
}

export type ShellExit = { readonly code: number } | { readonly signal: "SIGINT" | "SIGTERM" } | { readonly unknown: true }
export const shellProgram = {
  argv: ["/bin/sh", "-c", "fixture echo", "a b"],
  cwd: "/scratch/shell location",
  environment: { FIXTURE: "two words" },
  fd: "native-stdio",
}
export const encodeProgram = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({
  argv: Schema.Array(Schema.String), cwd: Schema.String,
  environment: Schema.Record(Schema.String, Schema.String), fd: Schema.String,
})))

/** The fork prerequisite drives these same expectations on its real seam.
 * An allowed call must launch once; denying every request cannot pass. */
export const shellLaunchLaws = (driver: ShellLaunchDriver, equal: (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) => void) =>
  Effect.gen(function* () {
    const first = { id: "shell-a", owner: "session-a", ownerEpoch: 1, attempt: 21 }
    const second = { id: "shell-b", owner: "session-b", ownerEpoch: 2, attempt: 21 }
    const denied = { id: "shell-rejected", owner: "session-a", ownerEpoch: 1, attempt: 23 }
    yield* driver.permission(denied, "pending", "model")
    yield* driver.permission(denied, "denied", "model")
    yield* driver.bind(denied, "rejected")
    yield* driver.permission(first, "pending", "model")
    equal(yield* driver.held(), [])
    equal(yield* driver.launches(), [])
    yield* driver.permission(first, "allowed", "model")
    yield* driver.permission(second, "allowed", "native")
    yield* driver.bind(first, "scope-a")
    equal(yield* driver.launches(), ["shell-a"])
    yield* driver.bind(first, "scope-a")
    yield* driver.restart()
    yield* driver.owner(first, "handoff")
    yield* driver.bind(second, "scope-b")
    equal(yield* driver.launches(), ["shell-a"])
    yield* driver.owner(first, "terminal")
    yield* driver.finish(first, "scope-a", "live")
    yield* driver.finish(first, "scope-a", "unknown")
    yield* driver.finish({ ...first, attempt: 9 }, "scope-a", "gone")
    equal(yield* driver.held(), ["shell-a"])
    yield* driver.finish(first, "scope-a", "gone")
    yield* driver.bind(second, "scope-b")
    equal(yield* driver.launches(), ["shell-a", "shell-b"])
    yield* driver.finish(first, "scope-a", "gone")
    equal(yield* driver.held(), ["shell-b"])
    yield* driver.input(second, "literal input: two words")
    yield* driver.complete(second, { signal: "SIGINT" })
    equal(yield* driver.payloads(), [
      `shell-a:${encodeProgram(shellProgram)}`, `shell-b:${encodeProgram(shellProgram)}`,
      "shell-b:stdout:literal input: two words", "shell-b:exit:SIGINT",
    ])
    yield* driver.finish(second, "scope-b", "gone")
    const cancelled = { id: "shell-c", owner: "session-c", ownerEpoch: 4, attempt: 1 }
    const uncertain = { id: "shell-d", owner: "session-d", ownerEpoch: 5, attempt: 1 }
    const next = { id: "shell-e", owner: uncertain.owner, ownerEpoch: 6, attempt: 1 }
    const missing = { id: "shell-lost", owner: "session-c", ownerEpoch: 4, attempt: 2 }
    const rejected = { id: "shell-placement", owner: "session-placement", ownerEpoch: 8, attempt: 1 }
    const base = yield* driver.snapshot()
    equal(base.shells, ["shell-a", "shell-b"])
    yield* driver.permission(cancelled, "allowed", "model")
    yield* driver.cancel(cancelled)
    yield* driver.bind(cancelled, "scope-c")
    yield* driver.permission(rejected, "allowed", "model")
    yield* driver.place(rejected, "rejected")
    yield* driver.bind(rejected, "scope-rejected")
    yield* driver.transportFailure(missing, "before-ack")
    yield* driver.bind(missing, "scope-lost")
    equal(yield* driver.launches(), ["shell-a", "shell-b"])
    yield* driver.permission(uncertain, "allowed", "native")
    yield* driver.bind(uncertain, "scope-d")
    const pinned = yield* driver.snapshot()
    yield* driver.transportFailure(uncertain, "after-bind")
    yield* driver.restart()
    yield* driver.bind(uncertain, "scope-d")
    yield* driver.owner(uncertain, "unknown")
    yield* driver.owner(uncertain, "handoff")
    equal(yield* driver.held(), ["shell-d"])
    yield* driver.owner(uncertain, "terminal")
    yield* driver.permission(next, "allowed", "native")
    yield* driver.complete(uncertain, { code: 17 })
    equal(yield* driver.wakes(), ["session-b:2"])
    equal(yield* driver.held(), ["shell-d"])
    yield* driver.finish(uncertain, "scope-d", "gone")
    yield* driver.bind(next, "scope-e")
    yield* driver.complete(next, { code: 0 })
    yield* driver.finish(next, "scope-e", "gone")
    equal(yield* driver.wakes(), ["session-b:2", "session-d:6"])
    equal(yield* driver.launches(), ["shell-a", "shell-b", "shell-d", "shell-e"])
    equal(yield* driver.replay(pinned.watermark), [
      "shell-d:owner:unknown", "shell-d:owner:handoff", "shell-d:owner:terminal", "shell-e:authorized",
      "shell-d:ended:17", "shell-d:drained", "shell-e:bound", "shell-e:ended:0", "shell-e:drained",
    ])
    equal(yield* driver.replay(base.watermark), [
      "shell-c:authorized", "shell-c:cancelled", "shell-placement:authorized", "shell-placement:cancelled",
      "shell-d:authorized", "shell-d:bound",
      "shell-d:owner:unknown", "shell-d:owner:handoff", "shell-d:owner:terminal", "shell-e:authorized",
      "shell-d:ended:17", "shell-d:drained", "shell-e:bound", "shell-e:ended:0", "shell-e:drained",
    ])
    const interrupted = { id: "shell-interrupted", owner: "session-interrupted", ownerEpoch: 9, attempt: 1 }
    yield* driver.permission(interrupted, "allowed", "native")
    yield* driver.bind(interrupted, "scope-interrupted")
    const interruptedPin = yield* driver.snapshot()
    yield* driver.transportFailure(interrupted, "after-bind")
    yield* driver.complete(interrupted, { unknown: true })
    yield* driver.finish(interrupted, "scope-interrupted", "gone")
    yield* driver.complete(interrupted, { code: 0 })
    yield* driver.restart()
    equal(yield* driver.replay(interruptedPin.watermark), ["shell-interrupted:ended:unknown", "shell-interrupted:drained"])
    equal(yield* driver.replay(interruptedPin.watermark + 1), ["shell-interrupted:drained"])
    equal(yield* driver.held(), [])
    equal(yield* driver.launches(), ["shell-a", "shell-b", "shell-d", "shell-e", "shell-interrupted"])
  })
