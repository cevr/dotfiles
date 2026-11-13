// The feature map's reader (verify-map.ts): a feature file's lists, the features a change touches, a changed
// path from the repository's root, and the head's fresh seeds.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { listed, parseFeature, swarmFrom, touched, underOpencode, undriven } from "./verify-map.ts"

const FILE = [
  "# Queue",
  "",
  "The agent's live queue.",
  "",
  "## Driving it with the world",
  "",
  "- **World suites:** `cmd/queue/queue.sim.test.ts`, `cmd/queue/other.sim.test.ts`",
  "- **Code:** `mods/queue/`, `cmd/queue/`",
  "",
  "## Driving it with real OpenCode",
  "",
  "- **Real:** `tests/queue.test.ts`",
].join("\n")

describe("the feature map", () => {
  test("a feature file reads as its id, title, world suites, real checks and code", () => {
    expect(parseFeature("queue.md", FILE)).toEqual({
      id: "queue",
      title: "Queue",
      world: ["cmd/queue/queue.sim.test.ts", "cmd/queue/other.sim.test.ts"],
      real: ["tests/queue.test.ts"],
      code: ["mods/queue/", "cmd/queue/"],
    })
  })

  test("a list the file lacks, or writes with no backticked word, is empty", () => {
    expect(listed(FILE, "Regression")).toEqual([])
    expect(listed("- **World suites:** none yet.", "World suites")).toEqual([])
  })

  test("a change touches each feature whose code holds a changed path", () => {
    const queue = parseFeature("queue.md", FILE)
    const guard = parseFeature("guard.md", "# Guard\n- **Code:** `mods/guard/`, `sim/`")
    expect(touched([queue, guard], ["mods/queue/item.ts"]).map((feature) => feature.id)).toEqual(["queue"])
    expect(touched([queue, guard], ["sim/host.ts", "cmd/queue/server.ts"]).map((feature) => feature.id)).toEqual(["queue", "guard"])
    expect(touched([queue, guard], ["README.md"])).toEqual([])
  })

  test("a world suite under a feature's own code that its drive skips is undriven; one under sim/ or listed is not", () => {
    const queue = parseFeature("queue.md", FILE)
    const suites = ["cmd/queue/queue.sim.test.ts", "cmd/queue/other.sim.test.ts", "cmd/queue/late.sim.test.tsx", "cmd/queue/server.test.ts", "sim/world.sim.test.ts", "cmd/guard/guard.sim.test.ts"]
    expect(undriven(queue, suites)).toEqual(["cmd/queue/late.sim.test.tsx"])
    const shared = parseFeature("guard.md", "# Guard\n- **World suites:** `cmd/guard/guard.sim.test.ts`\n- **Code:** `mods/guard/`, `cmd/guard/`, `sim/`")
    expect(undriven(shared, suites)).toEqual([])
  })

  test("a changed path is read from opencode/, and one outside it is none", () => {
    expect(underOpencode("opencode/mods/queue/item.ts")).toEqual(Option.some("mods/queue/item.ts"))
    expect(underOpencode("skills/orchestrate/SKILL.md")).toEqual(Option.none())
  })

  test("a head always plays the same fresh seeds, another head others", () => {
    expect(swarmFrom("7f5120d89d32")).toBe(swarmFrom("7f5120d00000"))
    expect(swarmFrom("7f5120d89d32")).not.toBe(swarmFrom("944f545b0000"))
  })
})
