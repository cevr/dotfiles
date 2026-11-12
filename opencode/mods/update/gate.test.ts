import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { describeGate, gate, Gate, rootsOf, type SessionView } from "./gate.ts"

/** 2026-11-11T17:00:00Z, a Wednesday noon in Knowlton. */
const WEDNESDAY_NOON = 1_794_416_400_000
/** 2026-11-14T17:00:00Z, a Saturday noon in Knowlton: the Sabbath. */
const SATURDAY_NOON = 1_794_675_600_000

const session = (id: string, at: Partial<Omit<SessionView, "id">> = {}): SessionView => ({
  id,
  parentID: Option.none(),
  busy: false,
  compacting: false,
  ...at,
})

describe("the restart gate", () => {
  test("a busy root session holds the restart, and the gate names it", () => {
    const held = gate(WEDNESDAY_NOON, rootsOf([session("ses_idle"), session("ses_work", { busy: true })]))
    expect(held).toEqual(Gate.Busy({ roots: ["ses_work"] }))
    expect(describeGate(held)).toBe("root sessions at work: ses_work")
  })

  test("a root session that compacts holds the restart too", () => {
    expect(gate(WEDNESDAY_NOON, rootsOf([session("ses_compact", { compacting: true })]))).toEqual(Gate.Busy({ roots: ["ses_compact"] }))
  })

  test("idle root sessions open it, however many subagents still run or compact", () => {
    const sessions = [
      session("ses_root"),
      session("ses_sub", { parentID: Option.some("ses_root"), busy: true }),
      session("ses_sub2", { parentID: Option.some("ses_root"), compacting: true }),
    ]
    expect(rootsOf(sessions).map((root) => root.id)).toEqual(["ses_root"])
    expect(gate(WEDNESDAY_NOON, rootsOf(sessions))).toEqual(Gate.Open())
  })

  test("no session at all opens it", () => {
    expect(gate(WEDNESDAY_NOON, [])).toEqual(Gate.Open())
  })

  test("over the Sabbath rest it never opens, idle or not, and says when the rest ends", () => {
    const held = gate(SATURDAY_NOON, [])
    expect(Gate.$is("Sabbath")(held)).toBe(true)
    if (!Gate.$is("Sabbath")(held)) return
    expect(held.until).toBeGreaterThan(SATURDAY_NOON)
    expect(held.until - SATURDAY_NOON).toBeLessThan(12 * 3_600_000)
    expect(gate(held.until, [])).toEqual(Gate.Open())
    expect(describeGate(held)).toStartWith("the Sabbath rest, until 2026-11-14T")
  })
})
