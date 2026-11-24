import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option, Path } from "effect"
import { type Input } from "@dotfiles/opencode-guard/admission"
import { request, supply } from "@dotfiles/opencode-guard/memory/admission-acceptance"
import { open } from "@dotfiles/opencode-guard/sqlite/admission"
import * as Seed from "../../sim/seed.ts"

const { seeded } = Seed.runner("cmd/guard/host-resources.sim.test.ts")
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
const claim = (id: string | null, name: string, binding: string): Input =>
  ({ op: "claim", id: id ?? "missing-grant", owner: `caller-${name}`, generation: 1, binding })

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
    const child = { parentPid: 1, binding: "inherited-pin" }
    const start = yield* a.ledger.transact(claim(offered.reply.id, "one", child.binding), sample)
    expect(start.reply.state).toBe("running")
    const survey = yield* b.holder.list(0)
    const owning = survey.records.find((holder) => holder.placement.confinementRef === child.binding)
    expect(Option.fromNullishOr(owning?.owner.sessionId).pipe(Option.getOrElse(() => "unknown session")))
      .toBe("session-one")
    expect(owning?.state).toBe("live")
  })).pipe(Effect.provide(BunServices.layer)),
)
