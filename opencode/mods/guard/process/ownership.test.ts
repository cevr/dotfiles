import { Effect, Option, Result } from "effect"
import { expect, it } from "effect-bun-test"
import { EMPTY_OWNER, EMPTY_PLACEMENT, EMPTY_USAGE, controllerDraft, resourceRef } from "../host-resources.ts"
import { POLICY } from "../host-supply.ts"
import { birthRef } from "./admission.ts"
import {
  Authority, changeControl, newControl, OwnershipEvent, verifyInheritance,
} from "./ownership.ts"

const host = { hostId: "fixture-host", bootId: "fixture-boot" }
const pin = {
  bootId: host.bootId, ref: "inherited-binding", pid: 400, group: 400, start: 500,
  cgroup: Option.none(), descriptor: { device: "3", inode: "62", file: "/fixture/private" },
}

it.effect("only an exact boot and birth still holding the managed descriptor can join after reparenting", () =>
  Effect.gen(function* () {
    for (let i = 0; i < 128; i++) {
      const parents = [1, 400]
      const parentPid = Option.getOrThrow(Option.fromNullishOr(parents[i % 5 % 2]))
      const child = { pid: 420, start: 600, parentPid }
      const boots = ["prior-boot", host.bootId, host.bootId]
      const bootId = Option.getOrThrow(Option.fromNullishOr(boots[i % 3]))
      const reports = [
        [],
        [{ ...child, start: 601 }],
        [{ ...child, pid: 421 }],
        [child],
      ]
      const witnessed = Option.getOrThrow(Option.fromNullishOr(reports[i % reports.length]))
      const asked: number[] = []
      const joined = yield* verifyInheritance(bootId, pin, child, (pid) => Effect.sync(() => {
        asked.push(pid)
        return witnessed
      }))
      if (bootId === host.bootId) expect(asked).toEqual([child.pid])
      else expect(asked).toEqual([])
      if (bootId === host.bootId && i % reports.length === 3)
        expect(joined).toEqual(Option.some({ bootId, binding: pin.ref, birthRef: birthRef(bootId, child) }))
      else expect(joined).toEqual(Option.none())
    }
    expect(birthRef(host.bootId, { pid: 420, start: 600 })).not.toBe(birthRef(host.bootId, { pid: 420, start: 601 }))
  }),
)

const actor = Authority.make({
  ...host, epoch: 1, authorityId: "launcher",
  owner: { ...EMPTY_OWNER, authorityId: "launcher", class: "service" },
})
const row = { ...controllerDraft({
  ...host, holderId: "controller", incarnation: "incarnation", resourceId: "res",
  kind: "server", owner: actor.owner, dependsOn: [], parentResourceId: Option.none(),
  placement: { ...EMPTY_PLACEMENT, objectRef: "object" },
  coverage: "partial", protection: "eligible-class", usage: EMPTY_USAGE,
}), revision: 1 }
const at = Option.getOrThrow(resourceRef(row))

it.effect("lifecycle evidence is scoped, fresh and cannot stand in for a missing start bind", () =>
  Effect.sync(() => {
    const initial = newControl(actor.epoch)
    const bind = OwnershipEvent.cases.bind.make({ at, objectRef: "object", confinementRef: "fence" })
    const bound = changeControl(row, initial, actor, bind, 50, false)
    expect(Result.isSuccess(bound)).toBe(true)
    const fact = OwnershipEvent.cases.reconcile.make({
      at, objectRef: "object", fact: "live", witness: "example-ref", sequence: 1, sampleBootMs: 40,
    })
    const reason = Result.match({ onSuccess: () => "accepted", onFailure: (value: string) => value })
    expect(reason(changeControl(row, initial, actor, fact, 50, false))).toBe("stale")
    if (Result.isSuccess(bound)) {
      const { row, control } = bound.success
      const gone = { ...fact, fact: "gone" as const }
      expect(reason(changeControl(row, control, actor, gone, 39, false))).toBe("stale")
      expect(reason(changeControl(row, control, actor, gone, 41 + POLICY.freshnessMs, false))).toBe("stale")
      const fresh = changeControl(row, control, actor, gone, 40 + POLICY.freshnessMs, false)
      expect(Result.getOrThrow(fresh).row).toMatchObject({
        state: "terminal", proof: { validUntilBootMs: 40 + POLICY.freshnessMs },
      })
    }
  }),
)
