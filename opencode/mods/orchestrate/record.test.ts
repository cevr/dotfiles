// The record's domain: who may make each move, what each refuses, and what the fold keeps, without a store.
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { type Actor, type Command, Command as Commands, type Context, decide, EMPTY, fold, PartInput, type Snapshot } from "./record.ts"
import { decideCommand } from "./standing.ts"

const T0 = 1_800_000_000_000
const DAY = 86_400_000
const ROOT: Actor = { id: "ses_root", role: "root" }
const WORKER: Actor = { id: "ses_worker", role: "worker" }
const IMPORT: Actor = { id: "ergo-register", role: "import" }

/** Runs `command` against `snapshot`: the record after it, or why it was refused. */
const step = (snapshot: Snapshot, command: Command, actor: Actor = ROOT, now = T0): Result.Result<Snapshot, string> => {
  const context: Context = { actor, now }
  return Result.match(decideCommand(snapshot, command, context), {
    onFailure: (refused) => Result.fail(refused.reason),
    onSuccess: (events) => Result.succeed(fold(snapshot, events)),
  })
}

/** The record after `commands`, each of which must be taken. */
const after = (commands: ReadonlyArray<readonly [Command, Actor?, number?]>): Snapshot =>
  commands.reduce((snapshot, [command, actor, now]) => Result.getOrThrow(step(snapshot, command, actor, now)), EMPTY)

const reasonOf = (snapshot: Snapshot, command: Command, actor: Actor = ROOT): string =>
  Result.match(step(snapshot, command, actor), { onFailure: (why) => why, onSuccess: () => "taken" })

const add = (ids: ReadonlyArray<string>, sourceKind: "owner-answer" | "plan-part" | "follow-up" = "plan-part") =>
  Commands.cases.add.make({ run: "r1", sourceKind, sourceRef: "plan.md:1", parts: ids.map((id) => PartInput.make({ id, title: `part ${id}` })) })
const assign = (id: string, ownerLane: string, ownerSession: Option.Option<string> = Option.none()) => Commands.cases.assign.make({ id, ownerLane, ownerSession, after: [] })
const row = (snapshot: Snapshot, id: string) => Option.fromUndefinedOr(snapshot.commitments.get(id))

describe("add", () => {
  test("N parts make N open, unowned commitments in one call", () => {
    const snapshot = after([[add(["a", "b", "c"])]])
    expect([...snapshot.commitments.values()].map((each) => [each.id, each.state, Option.isNone(each.ownerLane)])).toEqual([
      ["a", "open", true],
      ["b", "open", true],
      ["c", "open", true],
    ])
  })

  test("a part with an owner is owned at once, with a review-by time 7 days on", () => {
    const owned = Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "p", parts: [PartInput.make({ id: "a", title: "A", ownerLane: Option.some("lane-a") })] })
    const snapshot = after([[owned]])
    expect(Option.map(row(snapshot, "a"), (each) => [each.ownerLane, each.reviewBy])).toEqual(Option.some([Option.some("lane-a"), Option.some("2027-01-22T08:00:00.000Z")]))
  })

  test("refuses a taken id, a non-slug id, an empty or long title, a quote not the owner's, and nothing", () => {
    const snapshot = after([[add(["a"])]])
    expect(reasonOf(snapshot, add(["a"]))).toBe("the id a is taken")
    expect(reasonOf(snapshot, add(["has space"]))).toContain("is not a slug")
    expect(reasonOf(snapshot, add([]))).toBe("an add names at least one part")
    const long = Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "p", parts: [PartInput.make({ id: "x", title: "t".repeat(201) })] })
    expect(reasonOf(snapshot, long)).toBe("the title of x is 201 characters, more than 200")
    const quoted = Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "p", quote: Option.some("words"), parts: [PartInput.make({ id: "y", title: "t" })] })
    expect(reasonOf(snapshot, quoted)).toContain("a quote is the owner's words")
  })

  test("a worker files only a follow-up or a bug, and never owned", () => {
    expect(reasonOf(EMPTY, add(["a"], "owner-answer"), WORKER)).toContain("a worker files only follow-up or bug")
    const owned = Commands.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "s:c", parts: [PartInput.make({ id: "a", title: "A", ownerLane: Option.some("lane-a") })] })
    expect(reasonOf(EMPTY, owned, WORKER)).toContain("suggest an owner instead")
    expect(reasonOf(EMPTY, add(["a"], "follow-up"), WORKER)).toBe("taken")
  })
})

describe("who moves what", () => {
  test("a worker never owns, orders, reopens or gives a word", () => {
    const snapshot = after([[add(["a"])], [assign("a", "lane-a")]])
    expect(reasonOf(snapshot, assign("a", "lane-b"), WORKER)).toBe("owning a commitment is the root's: a worker cannot")
    expect(reasonOf(snapshot, Commands.cases.order.make({ ownerLane: "lane-a", ids: ["a"] }), WORKER)).toBe("an order is the root's: a worker cannot")
    expect(reasonOf(snapshot, Commands.cases.word.make({ run: "r1", word: "go" }), WORKER)).toBe("a manual word is the root's: a worker cannot")
  })

  test("a worker never closes an owner-sourced commitment; a root does, with a reason, and leaves a notice", () => {
    const snapshot = after([[add(["a"], "owner-answer")]])
    expect(reasonOf(snapshot, Commands.cases.decide.make({ id: "a", why: "done elsewhere" }), WORKER)).toBe("only the root closes what the owner approved")
    expect(reasonOf(snapshot, Commands.cases.decide.make({ id: "a", why: "  " }))).toBe("the reason (why) is empty")
    const closed = after([[add(["a"], "owner-answer")], [Commands.cases.decide.make({ id: "a", why: "done elsewhere" })]])
    expect(Option.map(row(closed, "a"), (each) => [each.state, each.decidedWhy, Option.isSome(each.noticeUntil)])).toEqual(Option.some(["decided", Option.some("done elsewhere"), true]))
  })

  test("a release is the root's or the owner's own session's", () => {
    const snapshot = after([[add(["a"])], [assign("a", "lane-a", Option.some("ses_worker"))]])
    expect(reasonOf(snapshot, Commands.cases.release.make({ id: "a" }), { id: "ses_other", role: "worker" })).toBe("only the root, or the owner's own session, releases a commitment")
    expect(reasonOf(snapshot, Commands.cases.release.make({ id: "a" }), WORKER)).toBe("taken")
  })

  test("only an import imports", () => {
    expect(reasonOf(EMPTY, Commands.cases.import.make({ run: "wf1", rows: [] }))).toBe("only an import imports")
  })
})

describe("the fold", () => {
  test("re-owning keeps a commitment open; reopening makes it open and unowned with its history kept", () => {
    const snapshot = after([[add(["a"], "owner-answer")], [assign("a", "lane-a")], [assign("a", "lane-b")], [Commands.cases.decide.make({ id: "a", why: "folded" })], [Commands.cases.reopen.make({ id: "a" })]])
    expect(Option.map(row(snapshot, "a"), (each) => [each.state, each.ownerLane, each.noticeUntil, each.decidedWhy])).toEqual(Option.some(["open", Option.none(), Option.none(), Option.none()]))
  })

  test("a word given before an assignment meets its manual wait then", () => {
    const waiting = Commands.cases.assign.make({ id: "a", ownerLane: "lane-a", ownerSession: Option.none(), after: [{ kind: "manual", ref: "go" }] })
    const snapshot = after([[add(["a"])], [Commands.cases.word.make({ run: "r1", word: "go" }), ROOT, T0], [waiting, ROOT, T0 + DAY]])
    expect(Option.map(row(snapshot, "a"), (each) => each.after.map((wait) => wait.metAt))).toEqual(Option.some([Option.some("2027-01-15T08:00:00.000Z")]))
  })

  test("an order starts only the ids it names and only once", () => {
    const order = Commands.cases.order.make({ ownerLane: "lane-a", ids: ["a"] })
    const snapshot = after([[add(["a", "b"])], [assign("a", "lane-a")], [assign("b", "lane-a")], [order, ROOT, T0], [order, ROOT, T0 + DAY]])
    expect(["a", "b"].map((id) => Option.flatMap(row(snapshot, id), (each) => each.startedAt))).toEqual([Option.some("2027-01-15T08:00:00.000Z"), Option.none()])
  })

  test("a refused command's decision is a refusal, never events: decide is total over the record", () => {
    expect(Result.isFailure(decide(EMPTY, Commands.cases.decide.make({ id: "nope", why: "x" }), { actor: ROOT, now: T0 }))).toBe(true)
  })
})

describe("import", () => {
  const imported = (id: string, state: "open" | "landed" | "decided", fields: Partial<{ landedCommit: Option.Option<string>; decidedWhy: Option.Option<string> }> = {}) => ({
    id,
    row: {
      title: `row ${id}`,
      sourceKind: "plan-part" as const,
      sourceRef: "register",
      quote: Option.none(),
      plan: Option.none(),
      part: Option.none(),
      rank: Option.none(),
      ownerLane: Option.none(),
      ownerSession: Option.none(),
      state,
      startedAt: Option.none(),
      reviewBy: Option.none(),
      head: Option.none(),
      requestPath: Option.none(),
      landedCommit: fields.landedCommit ?? Option.none(),
      decidedWhy: fields.decidedWhy ?? Option.none(),
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      after: [],
    },
    history: [],
  })

  test("refuses a row that does not map, by its id and column", () => {
    expect(reasonOf(EMPTY, Commands.cases.import.make({ run: "wf1", rows: [imported("L-1", "landed")] }), IMPORT)).toBe("row L-1, column landed_commit: a landed row needs the commit on the default branch")
  })

  test("a second import of the same rows changes nothing", () => {
    const rows = [imported("O-1", "open"), imported("L-1", "landed", { landedCommit: Option.some("abc123") }), imported("D-1", "decided", { decidedWhy: Option.some("dropped") })]
    const once = after([[Commands.cases.import.make({ run: "wf1", rows }), IMPORT]])
    expect(Result.getOrThrow(decideCommand(once, Commands.cases.import.make({ run: "wf1", rows }), { actor: IMPORT, now: T0 }))).toEqual([])
    expect([...once.commitments.values()].map((each) => each.state)).toEqual(["open", "landed", "decided"])
  })
})
