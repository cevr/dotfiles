// The compaction windows from compact.json, capped, else the defaults.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { DEFAULTS, parseWindows, windowsOf } from "./compaction.ts"

describe("the compaction windows", () => {
  test("compact.json's windows, capped at each role's; a former name counts unless the current one is set", () => {
    expect(
      parseWindows(JSON.stringify({ windows: { planner: 50_000, "orchestrate-reviewer": 120_000, worker: -1, root: 2e6 } })),
    ).toEqual(Option.some({ planner: 50_000, verifier: 120_000 }))
    expect(parseWindows(JSON.stringify({ windows: { verifier: 90_000, "orchestrate-reviewer": 120_000 } }))).toEqual(
      Option.some({ verifier: 90_000 }),
    )
    expect(windowsOf(JSON.stringify({ windows: { planner: 900_000, worker: 150_000, root: 600_000 } }))).toEqual({
      ...DEFAULTS,
      planner: 400_000,
      worker: 150_000,
      root: 600_000,
    })
  })

  test("no file, or a broken one, gives the defaults", () => {
    expect(windowsOf(undefined)).toEqual(DEFAULTS)
    expect(parseWindows("{")).toEqual(Option.none())
    expect(windowsOf("{")).toEqual(DEFAULTS)
    expect(windowsOf("null")).toEqual(DEFAULTS)
    expect(windowsOf(JSON.stringify({ windows: "big" }))).toEqual(DEFAULTS)
    expect(DEFAULTS).toEqual({ planner: 400_000, implementor: 400_000, verifier: 400_000, worker: 200_000, root: 400_000 })
  })
})
