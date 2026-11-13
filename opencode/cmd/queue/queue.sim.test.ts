// The queue on the simulated host (sim/world.ts), at 20 seeds: the verify-opencode skill's queue journey
// (`.claude/skills/verify-opencode/features/queue.md`), driven by the verify model
// (sim/verify-model.ts `worldScript`), the same prompts a verifier types into the real TUI. The plugin
// is `cmd/queue/server.ts`'s `make` on the world's context over its memory store (sim/plugins.ts `queue`).
//
// The owner asks the agent to set its queue, then to mark one item done; the tool answers the list as it
// stands, the queue RPC the sidebar reads answers each change with a new revision, a refused change is a
// tool error that changes nothing, a subagent's queue is its own, the queue outlives a reload, and a deleted
// session's queue goes. What the sidebar draws stays in tests/queue.test.ts.
import { describe } from "bun:test"
import { Effect, Schema } from "effect"
import { QUEUE, Snapshot } from "@dotfiles/opencode-queue/queue"
import * as Plugins from "../../sim/plugins.ts"
import * as Read from "../../sim/readings.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { worldScript } from "../../sim/verify-world.ts"

const { seeded } = Seed.runner("cmd/queue/queue.sim.test.ts")

const WORK = "/scratch/project"
const decode = Schema.decodeUnknownSync(Snapshot)

const SET =
  'verify: call queue {"set":[{"id":"pool","text":"Sidebar pool worker","state":"running"},{"id":"panes","text":"Close old Claude panes","state":"needs-you"}]}'
const DONE = 'verify: call queue {"upsert":[{"id":"panes","state":"done"}]}'
const REFUSED = 'verify: call queue {"upsert":[{"id":"pool","state":"blocked"}]}\nverify: say refused as it should be'

describe("the queue on the world", () => {
  seeded("the agent sets its queue and marks an item done; the tool and the RPC answer each change, a refusal changes nothing", ({ seed, expect }) =>
    Effect.gen(function* () {
      const world = World.make({ seed, script: worldScript })
      yield* world.load(Plugins.queue(), { directory: WORK })
      const root = yield* world.session(WORK, { title: "Queue root" })
      const get = (sessionID: string) => world.rpc(QUEUE.id, "get", { sessionID }).pipe(Effect.map(decode))
      expect(yield* get(root)).toEqual({ revision: 0, items: [] })

      yield* world.prompt(root, SET)
      yield* world.until(() => Read.texts(world, root).length === 1 && Read.idle(world, root), 60_000)
      expect(Read.answers(world, root, "queue")).toEqual(["Queue (2):\n● pool [running]: Sidebar pool worker\n! panes [needs-you]: Close old Claude panes"])
      expect(Read.texts(world, root)).toEqual(["verify: 1 call(s) done; the last answered: ! panes [needs-you]: Close old Claude panes"])
      const first = yield* get(root)
      expect([first.revision, first.items.map((item) => [item.id, item.state])]).toEqual([1, [["pool", "running"], ["panes", "needs-you"]]])

      yield* world.prompt(root, DONE)
      yield* world.until(() => Read.texts(world, root).length === 2 && Read.idle(world, root), 60_000)
      const second = yield* get(root)
      expect([second.revision, second.items.map((item) => [item.id, item.state])]).toEqual([2, [["pool", "running"], ["panes", "done"]]])

      yield* world.prompt(root, REFUSED)
      yield* world.until(() => Read.texts(world, root).length === 3 && Read.idle(world, root), 60_000)
      expect(Read.answers(world, root, "queue")[2]).toContain('Item "pool": unknown state "blocked"')
      expect(Read.texts(world, root)[2]).toBe("refused as it should be")
      expect((yield* get(root)).revision).toBe(2)
    }),
  )

  seeded("a subagent's queue is its own, the queue outlives a reload, and a deleted session's queue goes", ({ seed, expect }) =>
    Effect.gen(function* () {
      const world = World.make({ seed, script: worldScript })
      yield* world.load(Plugins.queue(), { directory: WORK })
      const root = yield* world.session(WORK, { title: "Queue root" })
      const child = yield* world.session(WORK, { title: "Queue child", parentID: root })
      const get = (sessionID: string) => world.rpc(QUEUE.id, "get", { sessionID }).pipe(Effect.map(decode))

      yield* world.prompt(root, 'verify: call queue {"set":[{"id":"a","text":"Parent\'s","state":"next"}]}')
      yield* world.prompt(child, 'verify: call queue {"set":[{"id":"b","text":"Child\'s","state":"running"}]}')
      yield* world.until(() => Read.texts(world, root).length >= 1 && Read.texts(world, child).length >= 1 && Read.idle(world, root) && Read.idle(world, child), 60_000)
      expect((yield* get(root)).items.map((item) => item.id)).toEqual(["a"])
      expect((yield* get(child)).items.map((item) => item.id)).toEqual(["b"])

      yield* world.restart
      expect(yield* get(root)).toEqual({ revision: 1, items: [{ id: "a", text: "Parent's", state: "next", owner: "mine" }] })

      yield* world.remove(root)
      yield* world.advance(1_000)
      expect(yield* get(root)).toEqual({ revision: 0, items: [] })
      expect(world.stale()).toEqual([])
    }),
  )
})
