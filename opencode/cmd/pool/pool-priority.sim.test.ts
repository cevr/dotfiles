// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
import { Effect, Option } from "effect"
import { simulationRunner } from "../../sim/seed.ts"
import { fleet, fixture, quota, refunds, WORK } from "./pool-reset-backed-pace.fixture.ts"

const { seeded } = simulationRunner("cmd/pool/pool-priority.sim.test.ts")

seeded("owner replies and compaction bypass worker pace, hard quota still holds every session", ({ expect }) => Effect.gen(function* () {
  const made = fixture({ a: quota(0.999, 0) }, refunds)
  const { world, session, primary } = yield* fleet(made)
  const root = yield* world.session(WORK, { title: "Orchestrator" })
  const worker = yield* session("held_worker")
  yield* world.prompt(worker, "wait for weekly pace")
  yield* world.advance(1_000)
  expect(primary()).toHaveLength(0)
  yield* world.prompt(root, "owner can still communicate")
  yield* world.advance(1_000)
  expect(primary()).toHaveLength(1)
  yield* world.compact(root)
  yield* world.advance(1_000)
  expect(world.requests().filter((request) => request.kind === "compaction" && request.sessionID === root)).toHaveLength(1)
  const before = world.provider().received().filter((request) => request.path === "/v1/messages").length
  made.reading.a = quota(1, 0)
  yield* world.advance(7_000)
  yield* world.prompt(root, "now the actual provider quota is exhausted")
  yield* world.advance(1_000)
  expect(world.provider().received().filter((request) => request.path === "/v1/messages")).toHaveLength(before)
  expect(Option.fromUndefinedOr(world.messages(root).find((message) => message.type === "error"))._tag).toBe("Some")
}))
