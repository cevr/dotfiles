// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The digest plugin on the simulated host (sim/world.ts), its log the memory one (sim/plugins.ts `digest`): the
// append RPC keeps a line it is given and refuses one that is not an event or too long, keeping nothing of it; and a
// writer on the same host (the queue plugin) reaches it through its relay, one line per change.
import { describe } from "bun:test"
import { Effect, Option, Predicate, Ref } from "effect"
import { decodeLine, DIGEST, DigestEvent, encodeLine, VERSION } from "@dotfiles/opencode-digest/event"
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import * as Plugins from "../../sim/plugins.ts"
import * as Read from "../../sim/readings.ts"
import * as Seed from "../../sim/seed.ts"
import { worldScript } from "../../sim/verify-world.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/digest/digest.sim.test.ts")

const WORK = "/scratch/project"
const T = Date.parse("2026-11-20T12:00:00Z")
const LINE = encodeLine(DigestEvent.cases.Check.make({ v: VERSION, t: T, root: "r", ok: true, text: "the accept check passed" }))
const SET =
  'verify: call queue {"set":[{"id":"pool","text":"Sidebar pool worker","state":"running"},{"id":"panes","text":"Close old Claude panes","state":"needs-you"}]}'

/** The memory log's lines, now. */
const linesOf = (memory: MemoryDigest.MemoryLines) => Ref.getUnsafe(memory.lines)

describe("the digest on the world", () => {
  seeded("the append RPC keeps an event's line, and refuses one that is not an event or too long, keeping nothing of it", ({ seed, expect }) =>
    Effect.gen(function* () {
      const memory = MemoryDigest.empty()
      const world = World.make({ seed, script: worldScript })
      yield* world.load(Plugins.digest(memory), { directory: WORK })
      const append = (input: { readonly line?: string }) => world.rpc(DIGEST.id, "append", input)
      const answers = [yield* append({ line: LINE }), yield* append({ line: "not json" }), yield* append({ line: `${LINE.slice(0, -1)},"x":"${"y".repeat(5_000)}"}` }), yield* append({})]
      expect(answers.map((answer) => Object.keys(Option.getOrElse(Option.liftPredicate(answer, Predicate.isObject), () => ({}))))).toEqual([
        [],
        ["refused"],
        ["refused"],
        ["refused"],
      ])
      expect(linesOf(memory)).toEqual([LINE])
    }),
  )

  seeded("the queue's changes reach the digest through its relay, one Item line per item", ({ seed, expect }) =>
    Effect.gen(function* () {
      const memory = MemoryDigest.empty()
      const world = World.make({ seed, script: worldScript })
      yield* world.load(Plugins.digest(memory), { directory: WORK })
      yield* world.load(Plugins.queue(), { directory: WORK })
      const root = yield* world.session(WORK, { title: "Queue root" })
      yield* world.prompt(root, SET)
      yield* world.until(() => Read.idle(world, root) && linesOf(memory).length >= 2, 60_000)
      const items = linesOf(memory).flatMap((line) => Option.toArray(Option.filter(decodeLine(line), (event) => event._tag === "Item")))
      expect(items.map((event) => event._tag === "Item" && [event.root, event.id, event.state])).toEqual([
        [root, "pool", "running"],
        [root, "panes", "needs-you"],
      ])
    }),
  )
})
