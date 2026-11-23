// @reads all
// @reads-reason computed read at mods/pool/store/store.ts: names: (path) => Effect.try({ try: () => readdirSync(path), catch: (cause) => cause }),
// The work plugin on the simulated host (sim/world.ts), at 20 seeds: `cmd/work/server.ts`'s `make` on the
// world's context over its memory doubles (sim/plugins.ts `work`), driven by the verify model
// (sim/verify-model.ts `worldScript`). The agent makes a workspace with `work`, lists it with the alias
// `rift`, and lands it with `work`; each answer is the model's, and the land's accept check wakes the
// session through the world's `session.synthetic`.
import { describe } from "bun:test"
import { Effect } from "effect"
import * as MemoryDebts from "@dotfiles/opencode-work/memory/debts"
import * as MemoryLanding from "@dotfiles/opencode-work/memory/landing"
import * as MemoryRifts from "@dotfiles/opencode-work/memory/rifts"
import * as Plugins from "../../sim/plugins.ts"
import * as Read from "../../sim/readings.ts"
import * as Seed from "../../sim/seed.ts"
import { worldScript } from "../../sim/verify-world.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/work/work.sim.test.ts")

const SOURCE = "/code/app"

const CREATE = 'verify: call work {"action":"create","branch":"feat/x"}'
const LIST = 'verify: call rift {"action":"list"}'
const LAND = 'verify: call work {"action":"land","workspaces":["feat-x"]}'

describe("the work plugin on the world", () => {
  seeded("the agent makes a workspace with work, lists it with the alias rift and lands it, and the accept check wakes it", ({ seed, expect }) =>
    Effect.gen(function* () {
      const world = World.make({ seed, script: worldScript })
      const doubles = {
        rifts: MemoryRifts.world([SOURCE]),
        landing: MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept") }),
        debts: MemoryDebts.world(),
      }
      yield* world.load(Plugins.work(doubles), { directory: SOURCE, options: { workrift: false } })
      const root = yield* world.session(SOURCE, { title: "Work root" })

      yield* world.prompt(root, CREATE)
      yield* world.until(() => Read.texts(world, root).length === 1 && Read.idle(world, root), 60_000)
      expect(Read.answers(world, root, "work")[0]).toStartWith("Created the workspace /code/.work/app/feat-x from /code/app, on branch feat/x.")

      yield* world.prompt(root, LIST)
      yield* world.until(() => Read.texts(world, root).length === 2 && Read.idle(world, root), 60_000)
      expect(Read.answers(world, root, "rift")).toEqual(["Workspaces of /code/app:\n- /code/.work/app/feat-x · branch feat/x · clean"])

      yield* world.prompt(root, LAND)
      yield* world.until(() => Read.texts(world, root).length >= 3 && Read.idle(world, root) && doubles.landing.steps.some((step) => step.startsWith("accept ")), 60_000)
      expect(Read.answers(world, root, "work")[1]).toStartWith("Landed 1 workspace(s) as one push")
      expect([...doubles.rifts.rifts.keys()]).toEqual(["/code/.work/app/integrate", "/code/.work/app/land-accept"])
    }),
  )
})
