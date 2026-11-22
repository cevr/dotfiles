// Standings, computed at each read, and the pass: exactly one standing per open commitment; a pass lands only a
// claimed commit on the default branch and wakes the root once per assignment.
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { type Actor, type Command, Command as Commands, fold, EMPTY, PartInput, type Snapshot } from "./record.ts"
import { checkOf, checkpointOf, decideCommand, decidePass, type Facts, passedOf, STANDINGS, standingOf } from "./standing.ts"

const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const ROOT: Actor = { id: "ses_root", role: "root" }
const PLUGIN: Actor = { id: "plugin", role: "plugin" }

const after = (commands: ReadonlyArray<Command>, now = T0): Snapshot =>
  commands.reduce((snapshot, command) => fold(snapshot, Result.getOrThrow(decideCommand(snapshot, command, { actor: ROOT, now }))), EMPTY)

const facts = (fields: Partial<Facts> = {}): Facts => ({ now: T0, onMain: new Set(), gone: new Set(), ...fields })
const add = (ids: ReadonlyArray<string>) => Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "p", parts: ids.map((id) => PartInput.make({ id, title: id })) })
const assign = (id: string, ownerLane: string, after: ReadonlyArray<{ readonly kind: "commit-on-main" | "manual" | "date" | "commitment-closed"; readonly ref: string }> = []) =>
  Commands.cases.assign.make({ id, ownerLane, ownerSession: Option.none(), after, reviewBy: Option.some(T0 + 10 * HOUR) })
const standing = (snapshot: Snapshot, id: string, given: Facts) => Option.map(Option.fromUndefinedOr(snapshot.commitments.get(id)), (row) => standingOf(snapshot, row, given))

describe("standingOf", () => {
  const snapshot = after([add(["u", "o", "d", "h", "w"]), assign("o", "gone-lane"), assign("d", "lane"), assign("h", "lane", [{ kind: "commit-on-main", ref: "c9" }]), assign("w", "lane", [{ kind: "manual", ref: "go" }])])

  test("each open commitment is in the first standing that applies", () => {
    const now = facts({ gone: new Set(["gone-lane"]) })
    expect(["u", "o", "d", "h", "w"].map((id) => standing(snapshot, id, now))).toEqual((["unowned", "orphaned", "due", "held", "held"] as const).map((each) => Option.some(each)))
  })

  test("past its review-by time an owned one is overdue, a wait included; the root's lane is never gone", () => {
    const late = facts({ now: T0 + 11 * HOUR, gone: new Set(["lane", "root"]) })
    expect(standing(snapshot, "w", facts({ now: T0 + 11 * HOUR }))).toEqual(Option.some("overdue"))
    const rooted = after([add(["r"]), assign("r", "root")])
    expect(standing(rooted, "r", late)).toEqual(Option.some("overdue"))
  })

  test("a commit wait is met when git says the commit is on the default branch", () => {
    expect(standing(snapshot, "h", facts({ onMain: new Set(["c9"]) }))).toEqual(Option.some("due"))
  })

  test("the check lists every open commitment in exactly one standing", () => {
    const check = checkOf(snapshot, facts({ gone: new Set(["gone-lane"]) }))
    const listed = STANDINGS.flatMap((each) => check[each])
    expect(listed.toSorted()).toEqual(["d", "h", "o", "u", "w"])
    expect(checkpointOf(snapshot, facts()).byOwner.get("-")).toEqual(["u"])
  })
})

describe("the pass", () => {
  const claimed = after([
    add(["a", "b"]),
    assign("a", "lane"),
    assign("b", "lane"),
    Commands.cases.hand_back.make({ run: "r1", ownerLane: "lane", role: "implementor", session: "ses_w", verdict: "ready", head: Option.some("c1"), claims: ["a"] }),
  ])

  test("lands only a claimed commit that is on the default branch, and nobody else can say landed", () => {
    const off = Result.getOrThrow(decidePass(claimed, facts(), Option.none(), { actor: PLUGIN, now: T0 }))
    expect(passedOf(off).landed).toEqual([])
    const on = Result.getOrThrow(decidePass(claimed, facts({ onMain: new Set(["c1"]) }), Option.none(), { actor: PLUGIN, now: T0 }))
    expect(passedOf(on).landed).toEqual(["a"])
    expect(Option.map(Option.fromUndefinedOr(fold(claimed, on).commitments.get("a")), (row) => [row.state, row.landedCommit])).toEqual(Option.some(["landed", Option.some("c1")]))
  })

  test("wakes the root once for each commitment newly due, and not again until it is assigned again", () => {
    const first = Result.getOrThrow(decidePass(claimed, facts(), Option.some("ses_root"), { actor: PLUGIN, now: T0 }))
    expect(passedOf(first).woke).toEqual(Option.some({ root: "ses_root", ids: ["a", "b"] }))
    const woken = fold(claimed, first)
    expect(Result.getOrThrow(decidePass(woken, facts(), Option.some("ses_root"), { actor: PLUGIN, now: T0 + HOUR }))).toEqual([])
    const reassigned = fold(woken, Result.getOrThrow(decideCommand(woken, assign("b", "lane-2"), { actor: ROOT, now: T0 + HOUR })))
    expect(passedOf(Result.getOrThrow(decidePass(reassigned, facts(), Option.some("ses_root"), { actor: PLUGIN, now: T0 + HOUR }))).woke).toEqual(Option.some({ root: "ses_root", ids: ["b"] }))
  })

  test("with no root nothing is woken: the check keeps listing it as due", () => {
    const pass = Result.getOrThrow(decidePass(claimed, facts(), Option.none(), { actor: PLUGIN, now: T0 }))
    expect(pass).toEqual([])
    expect(checkOf(claimed, facts()).due).toEqual(["a", "b"])
  })
})
