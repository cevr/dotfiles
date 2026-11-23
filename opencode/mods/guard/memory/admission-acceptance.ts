import { Effect } from "effect"
import { type Observation, type ShellIdentity } from "../admission.ts"
import type { Request } from "../admission-wire.ts"
import { POLICY, type Supply } from "../host-supply.ts"

export const owner = (id: string) => `fixture-${id}`
const classOf = (exclusive: boolean): Request["purpose"] => {
  if (exclusive) return "exclusive-check"
  return "check"
}

export const request = (id: string, cpuMilli = 1000, exclusive = false): Request => ({
  version: 1, requestId: id, principal: { kind: "external-runner", scopeId: id, epoch: 1 },
  purpose: classOf(exclusive), tier: "standard", deadlineBootMs: 100_000,
  demand: { cpuMilli, memoryBytes: 0, ioClass: "idle", keys: [], volumeReservations: [{ volumeId: "volume-a", bytes: 0 }] },
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
}

/** The fork prerequisite drives these same expectations on its real seam.
 * An allowed call must launch once; denying every request cannot pass. */
export const shellLaunchLaws = (driver: ShellLaunchDriver, equal: (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) => void) =>
  Effect.gen(function* () {
    const first = { id: "shell-a", owner: "session-a", attempt: 1 }
    const second = { id: "shell-b", owner: "session-b", attempt: 2 }
    yield* driver.permission(first, "pending", "model")
    equal(yield* driver.held(), [])
    yield* driver.permission(first, "denied", "model")
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
  })
