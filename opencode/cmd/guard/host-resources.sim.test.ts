import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Option, Path, Result } from "effect"
import { type Input } from "@dotfiles/opencode-guard/admission"
import { type Reply } from "@dotfiles/opencode-guard/admission-wire"
import {
  EMPTY_OWNER, EMPTY_USAGE, holderOf, NO_PROOF, readHolderSnapshot, resourceHolders, resourceRef, UNKNOWN_OWNER,
} from "@dotfiles/opencode-guard/host-resources"
import { request, supply } from "@dotfiles/opencode-guard/memory/admission-acceptance"
import { type ProcessPin } from "@dotfiles/opencode-guard/process/launchers"
import { inheritedController, verifyInheritance } from "@dotfiles/opencode-guard/process/ownership"
import { open } from "@dotfiles/opencode-guard/sqlite/admission"
import { simulationRunner } from "../../sim/seed.ts"

const { seeded } = simulationRunner("cmd/guard/host-resources.sim.test.ts")
const host = { hostId: "host-fixture", bootId: "boot-fixture" }
const sample = supply({ cores: 12 })
const openFixture = Effect.fn("openFixture")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "host-ownership-" })
  const file = path.join(yield* fs.realPath(scratch), "fixture.sqlite")
  const a = yield* open(file, host)
  const b = yield* open(file, host)
  return { a, b }
})

const launchRequest = (name: string): Input => ({
  op: "request", owner: `caller-${name}`,
  request: { ...request(`launch-${name}`), principal: { kind: "native-shell", scopeId: `session-${name}`, epoch: 4 } },
})
const claim = (id: Reply["id"], name: string, binding: string): Input =>
  ({ op: "claim", id: Option.getOrElse(Option.fromNullishOr(id), () => "missing-grant"), owner: `caller-${name}`, generation: 1, binding })

seeded("independent callers cannot both start work in the same native binding", ({ expect }) =>
  Effect.scoped(Effect.gen(function* () {
    const { a, b } = yield* openFixture()
    const one = yield* a.ledger.transact(launchRequest("one"), sample)
    const two = yield* b.ledger.transact(launchRequest("two"), sample)
    expect([one.reply.state, two.reply.state]).toEqual(["granted", "granted"])
    const launched: string[] = []
    for (const [name, client, id] of [["one", a, one.reply.id], ["two", b, two.reply.id]] as const) {
      const next = yield* client.ledger.transact(claim(id, name, "shared-binding"), sample)
      if (next.reply.state === "running") launched.push(name)
    }
    expect(launched).toEqual(["one"])
  })).pipe(Effect.provide(BunServices.layer)),
)

seeded("a detached live child joins the original session by the inherited binding, not parent pid", ({ expect }) =>
  Effect.scoped(Effect.gen(function* () {
    const { a, b } = yield* openFixture()
    const offered = yield* a.ledger.transact(launchRequest("one"), sample)
    const child = { parentPid: 1, pid: 725, start: 150, binding: "inherited-pin" }
    const pin: ProcessPin = {
      ...host, ref: child.binding, pid: 300, start: 10, group: 300,
      cgroup: Option.none(), descriptor: { file: "/fixture/private", device: "1", inode: "2" },
    }
    const id = Option.getOrThrow(Option.fromNullishOr(offered.reply.id))
    const start = yield* a.bind({ id, owner: "caller-one", generation: 1 }, pin, sample)
    expect(start.reply.state).toBe("running")
    const survey = yield* readHolderSnapshot(b.holder)
    const evidence = Option.getOrThrow(yield* verifyInheritance(host.bootId, pin, child, () => Effect.succeed([child])))
    const owning = inheritedController(survey, evidence)
    expect(Option.flatMap(owning, (row) => Option.fromNullishOr(row.owner.sessionId)).pipe(Option.getOrElse(() => "unknown session")))
      .toBe("session-one")
    expect(Option.map(owning, (row) => row.state)).toEqual(Option.some("live"))
  })).pipe(Effect.provide(BunServices.layer)),
)

seeded("the shared inventory joins scanner measurements without replacing the current controller", ({ expect }) =>
  Effect.scoped(Effect.gen(function* () {
    const { a, b } = yield* openFixture()
    const offered = yield* a.ledger.transact(launchRequest("one"), sample)
    yield* a.ledger.transact(claim(offered.reply.id, "one", "scope-world"), sample)
    const view = yield* readHolderSnapshot(a.holder)
    const controller = Option.getOrThrow(Option.fromNullishOr(view.records[0]))
    const at = Option.getOrThrow(resourceRef(controller))
    const scan = holderOf({
      ...host, version: 1, resourceId: at.resourceId, incarnation: at.incarnation, holderId: "scanner-row",
      revision: Option.none(), kind: "process-tree", owner: UNKNOWN_OWNER, relation: "observation",
      parentResourceId: Option.none(), dependsOn: [], placement: { volumeId: Option.none(), objectRef: Option.none(), confinementRef: Option.none() },
      lease: Option.none(), usage: {
        cpuMilli: Option.some(250), cpuWindowMs: Option.some(50), memoryBytes: Option.none(), memoryBasis: Option.none(),
        allocatedBytes: Option.none(), exclusiveBytes: Option.none(), sharedBytes: Option.none(), extentGroupRef: Option.none(),
        ports: Option.none(), deviceSlots: Option.none(),
      },
      observedAtMs: 1, sampleBootMs: 1, lastUseAtMs: Option.none(), coverage: "partial",
      state: "unknown", proof: NO_PROOF, protection: "unknown", producerId: "scanner", producerSeq: 1,
    })
    const denied = yield* Effect.result(b.holder.putObservations("scanner", [{ ...scan, holderId: at.holderId, state: "terminal" }], 1))
    expect(Result.isFailure(denied)).toBe(true)
    const [measurement] = yield* b.holder.putObservations("scanner", [scan], 1)
    const work = resourceHolders(yield* readHolderSnapshot(a.holder), at)
    const reclaim = resourceHolders(yield* readHolderSnapshot(b.holder), at)
    expect(work).toEqual(reclaim)
    expect(work).toEqual(Option.some([controller, measurement]))
    expect(measurement?.owner).toEqual(EMPTY_OWNER)
    expect(measurement?.usage).toEqual({ ...EMPTY_USAGE, cpuMilli: 250, cpuWindowMs: 50 })
  })).pipe(Effect.provide(BunServices.layer)),
)
