// The record's domain: who may make each move, what each refuses, and what the fold keeps, without a store.
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { type Actor, closeKindOf, type Command, type Commitment, Command as Commands, type Context, decide, EMPTY, fold, PartInput, type Snapshot } from "./record.ts"
import type { ReasonData } from "./reasons.ts"
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
/** A row's state, current reason and close kind, plainly. */
const closeOf = (each: Commitment) => ({ state: each.state, reason: Option.getOrNull(each.reason), kind: Option.getOrNull(closeKindOf(each)) })
/** The invariant the tests' decisions rest on, declared by the root; and that guarantee. */
const DOCUMENT = { path: "docs/record.md", blob: "b".repeat(40), commit: "c".repeat(40) }
const declare = (id = "one-writer", observed = DOCUMENT) => Commands.cases.invariant.make({ id, anchor: id, observed })
const GUARANTEE: ReasonData = { reasonClass: "guarantee", referent: "invariant/one-writer" }
const onCommitment = (id: string): ReasonData => ({ reasonClass: "dependency", referent: `commitment/${id}` })
const decideOn = (id: string, why = "covered", reason: ReasonData = GUARANTEE) => Commands.cases.decide.make({ id, why, reason })
const followUp = (id: string, reason: Option.Option<ReasonData>, key = "call-1") =>
  Commands.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: `ses_worker:${key}`, parts: [PartInput.make({ id, title: `found ${id}` })], reason })

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
    expect(reasonOf(snapshot, long)).toBe("column commitment.title is 201 characters, more than 200")
    const quoted = Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "p", quote: Option.some("words"), parts: [PartInput.make({ id: "y", title: "t" })] })
    expect(reasonOf(snapshot, quoted)).toContain("a quote is the owner's words")
  })

  test("a worker files only a follow-up or a bug, and never owned", () => {
    expect(reasonOf(EMPTY, add(["a"], "owner-answer"), WORKER)).toContain("a worker files only follow-up or bug")
    const owned = Commands.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "s:c", parts: [PartInput.make({ id: "a", title: "A", ownerLane: Option.some("lane-a") })], reason: Option.some(onCommitment("b")) })
    expect(reasonOf(after([[add(["b"])]]), owned, WORKER)).toContain("suggest an owner instead")
    expect(reasonOf(after([[add(["b"])]]), followUp("a", Option.some(onCommitment("b"))), WORKER)).toBe("taken")
  })
})

describe("who moves what", () => {
  test("a worker never owns, orders, reopens or gives a word", () => {
    const snapshot = after([[add(["a"])], [assign("a", "lane-a")]])
    expect(reasonOf(snapshot, assign("a", "lane-b"), WORKER)).toBe("owning a commitment is the root's: a worker cannot")
    expect(reasonOf(snapshot, Commands.cases.order.make({ ownerLane: "lane-a", ids: ["a"] }), WORKER)).toBe("an order is the root's: a worker cannot")
    expect(reasonOf(snapshot, Commands.cases.word.make({ run: "r1", word: "go" }), WORKER)).toBe("a manual word is the root's: a worker cannot")
  })

  test("a worker never closes; a root does, with a guarantee, and leaves a notice on an owner-sourced one", () => {
    const snapshot = after([[declare()], [add(["a"], "owner-answer")], [add(["f"])]])
    expect(reasonOf(snapshot, decideOn("a", "done elsewhere"), WORKER)).toBe("a close by decision is the root's: a worker cannot decide")
    expect(reasonOf(snapshot, decideOn("f", "done elsewhere"), WORKER)).toBe("a close by decision is the root's: a worker cannot decide")
    expect(reasonOf(snapshot, decideOn("a", "  "))).toBe("column commitment.decided_why is empty")
    const closed = after([[declare()], [add(["a"], "owner-answer")], [decideOn("a", "done elsewhere")]])
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
    const snapshot = after([[add(["a"], "owner-answer")], [assign("a", "lane-a")], [assign("a", "lane-b")], [declare()], [decideOn("a", "folded")], [Commands.cases.reopen.make({ id: "a" })]])
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
    expect(Result.isFailure(decide(EMPTY, decideOn("nope", "x"), { actor: ROOT, now: T0 }))).toBe(true)
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
    const rows = [imported("O-1", "open"), imported("L-1", "landed", { landedCommit: Option.some("abc1234") }), imported("D-1", "decided", { decidedWhy: Option.some("dropped") })]
    const once = after([[Commands.cases.import.make({ run: "wf1", rows }), IMPORT]])
    expect(Result.getOrThrow(decideCommand(once, Commands.cases.import.make({ run: "wf1", rows }), { actor: IMPORT, now: T0 }))).toEqual([])
    expect([...once.commitments.values()].map((each) => each.state)).toEqual(["open", "landed", "decided"])
    // A historical close, unclassified: no reason guessed from its note, and its own close kind.
    expect([...once.commitments.values()].map(closeOf)).toEqual([
      { state: "open", reason: null, kind: null },
      { state: "landed", reason: null, kind: null },
      { state: "decided", reason: null, kind: "historical" },
    ])
  })
})

describe("reasons", () => {
  const RECEIPT = { path: "tmp/orchestrate/r1/check.json", receiptSha: "a".repeat(64), outputSha: "b".repeat(64), exit: 0, run: "r1", checkout: "c".repeat(40) }
  const MEASURED: ReasonData = { reasonClass: "measured", referent: `receipt/${RECEIPT.path}` }

  test("a worker's follow-up names a dependency or a measurement the plugin checks; a guarantee or none is refused", () => {
    const snapshot = after([[declare()], [add(["b"])]])
    expect(reasonOf(snapshot, followUp("f", Option.none()), WORKER)).toBe("a follow-up names its reason: reason_class (dependency or measured) and its referent; difficulty is not one")
    expect(reasonOf(snapshot, followUp("f", Option.some(GUARANTEE)), WORKER)).toBe("a guarantee is a close's reason, not a filing's: file with a dependency or a measurement")
    expect(reasonOf(snapshot, followUp("f", Option.some(onCommitment("b"))), WORKER)).toBe("taken")
    expect(Option.flatMap(row(after([[add(["b"])], [followUp("f", Option.some(onCommitment("b"))), WORKER]]), "f"), (each) => each.reason)).toEqual(Option.some(onCommitment("b")))
  })

  test("a measurement takes only the receipt the evidence reader read, never the caller's word", () => {
    const filed = (observed: Option.Option<typeof RECEIPT>) => Commands.cases.add.make({ ...followUp("f", Option.some(MEASURED)), observed })
    expect(reasonOf(EMPTY, filed(Option.none()), WORKER)).toBe("the receipt was not read by the evidence reader: a measured reason names a receipt the plugin reads")
    expect(reasonOf(EMPTY, filed(Option.some({ ...RECEIPT, path: "tmp/orchestrate/r1/other.json" })), WORKER)).toBe("the receipt was not read by the evidence reader: a measured reason names a receipt the plugin reads")
    expect(reasonOf(EMPTY, filed(Option.some(RECEIPT)), WORKER)).toBe("taken")
  })

  test("a dependency is an open commitment, not itself, with no cycle and no closed link in its chain", () => {
    const snapshot = after([[declare()], [add(["a", "b", "c", "d"])], [Commands.cases.defer.make({ id: "b", reason: onCommitment("c") })], [decideOn("d")]])
    expect(reasonOf(snapshot, Commands.cases.defer.make({ id: "a", reason: onCommitment("a") }))).toBe("a cannot wait on itself")
    expect(reasonOf(snapshot, Commands.cases.defer.make({ id: "a", reason: onCommitment("nope") }))).toContain("is no commitment of this repository's record")
    expect(reasonOf(snapshot, Commands.cases.defer.make({ id: "a", reason: onCommitment("d") }))).toBe("the dependency d is decided, not open: a dependency names work still owed")
    expect(reasonOf(snapshot, Commands.cases.defer.make({ id: "c", reason: onCommitment("b") }))).toBe("the dependency b waits on c, the commitment itself: a cycle")
    const chained = after([[declare()], [add(["a", "b", "c"])], [Commands.cases.defer.make({ id: "b", reason: onCommitment("c") })], [decideOn("c")]])
    expect(reasonOf(chained, Commands.cases.defer.make({ id: "a", reason: onCommitment("b") }))).toBe("the dependency b waits through c, which is decided: no path around a closed prerequisite")
    expect(reasonOf(snapshot, Commands.cases.defer.make({ id: "a", reason: onCommitment("b") }))).toBe("taken")
  })

  test("decide is the root's, with a guarantee on a declared invariant: no measured close, no close on a dependency", () => {
    const snapshot = after([[declare()], [add(["a", "b"])]])
    expect(reasonOf(snapshot, decideOn("a", "x", MEASURED))).toBe("a measurement orders work, it never closes it: decide takes a guarantee; defer takes a measurement")
    expect(reasonOf(snapshot, decideOn("a", "x", onCommitment("b")))).toBe("a dependency is work still owed: it never closes a commitment; defer it on the dependency instead")
    expect(reasonOf(snapshot, decideOn("a", "x", { reasonClass: "guarantee", referent: "invariant/never" }))).toContain("the invariant never is not declared")
    expect(reasonOf(snapshot, decideOn("a", "x", { reasonClass: "guarantee", referent: "spec-item/s1" }))).toBe("a spec-item referent is not available yet: it ships with spec-items (unit C)")
    // Unit C's `ask/` pointer is no referent a command takes: the command does not even construct.
    expect(() => decideOn("a", "x", { reasonClass: "guarantee", referent: "ask/q1" })).toThrow("Schema validation failed")
    expect(reasonOf(snapshot, decideOn("a", "x"), { id: "plugin", role: "plugin" })).toBe("a close by decision is the root's: a plugin cannot decide")
    const closed = after([[declare()], [add(["a"])], [decideOn("a")]])
    expect(Option.map(row(closed, "a"), closeOf)).toEqual(Option.some({ state: "decided", reason: GUARANTEE, kind: "guarantee" }))
  })

  test("defer keeps a commitment open with its reason; reopen clears a close's reason and history keeps it", () => {
    const deferred = after([[declare()], [add(["a", "b"])], [Commands.cases.defer.make({ id: "a", reason: onCommitment("b") })]])
    expect(Option.map(row(deferred, "a"), (each) => [each.state, each.reason])).toEqual(Option.some(["open", Option.some(onCommitment("b"))]))
    const reopened = after([[declare()], [add(["a"])], [decideOn("a")], [Commands.cases.reopen.make({ id: "a" })]])
    expect(Option.map(row(reopened, "a"), closeOf)).toEqual(Option.some({ state: "open", reason: null, kind: null }))
    expect(reasonOf(reopened, decideOn("a", "again"), WORKER)).toBe("a close by decision is the root's: a worker cannot decide")
  })

  test("a follow-up retried with its key files nothing again; the key on another finding is refused", () => {
    const once = after([[add(["b"])], [followUp("f", Option.some(onCommitment("b"))), WORKER]])
    expect(Result.getOrThrow(decideCommand(once, followUp("f", Option.some(onCommitment("b"))), { actor: WORKER, now: T0 }))).toEqual([])
    expect(reasonOf(once, followUp("g", Option.some(onCommitment("b"))), WORKER)).toBe("this idempotency key filed another follow-up already: a new finding takes a new key")
    expect(reasonOf(once, followUp("g", Option.some(onCommitment("b")), "call-2"), WORKER)).toBe("taken")
  })

  test("an invariant is the root's; the same declaration again is nothing, another document under its id is refused", () => {
    expect(reasonOf(EMPTY, declare(), WORKER)).toBe("declaring an invariant is the root's: a worker cannot")
    const declared = after([[declare()]])
    expect(Result.getOrThrow(decideCommand(declared, declare(), { actor: ROOT, now: T0 }))).toEqual([])
    expect(reasonOf(declared, declare("one-writer", { ...DOCUMENT, blob: "d".repeat(40) }))).toBe("the invariant one-writer is declared already, for another document or revision: a changed invariant takes a new id")
  })

  test("an owner-answer placeholder its add splits closes as placed, by the plugin, in the same command", () => {
    const answer = Commands.cases.add.make({ run: "r1", sourceKind: "owner-answer", sourceRef: "ses_root:q1", parts: [PartInput.make({ id: "q1", title: "their answer" })] })
    const split = Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:1", plan: Option.some("q1"), parts: [PartInput.make({ id: "q1-a", title: "part a" })] })
    const events = Result.getOrThrow(decideCommand(after([[answer]]), split, { actor: ROOT, now: T0 }))
    expect(events.map((each) => [each.happening._tag, each.actor.role])).toEqual([["promised", "root"], ["placed", "plugin"]])
    const placed = after([[answer], [split]])
    expect(Option.map(row(placed, "q1"), closeOf)).toEqual(Option.some({ state: "decided", reason: null, kind: "placed" }))
    expect(Option.map(row(placed, "q1"), (each) => Option.isSome(each.noticeUntil))).toEqual(Option.some(false))
    // A plan that is no open owner-answer closes nothing.
    const plain = after([[add(["p"])], [Commands.cases.add.make({ ...split, plan: Option.some("p") })]])
    expect(Option.map(row(plain, "p"), (each) => each.state)).toEqual(Option.some("open"))
  })
})
