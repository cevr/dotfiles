// The `commitments` and `follow_up` tools' pure parts: which fields each action takes, each call's command, the words
// of the answers, and the record's section (counts, at most ten ids a standing, owner-sourced first, the call that
// lists the rest), said again only when its ids change. The handlers over a store, refusals included, run on the
// simulated host (cmd/orchestrate/commitments.sim.test.ts).
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option, Result } from "effect"
import {
  beforeStart,
  type CommitmentsInput,
  commandOf,
  doneAnswer,
  followUpCommandOf,
  historyAnswer,
  inputRefusal,
  laneLine,
  listAnswer,
  listedOf,
  sectionKeys,
  sectionOf,
} from "./commitments-tool.ts"
import { type Actor, type Command, EMPTY, fold, type RecordEvent, type Snapshot, type StoredEvent } from "./record.ts"
import { decideCommand, type Facts } from "./standing.ts"

const T0 = Date.parse("2026-11-22T10:00:00.000Z")
const ROOT: Actor = { id: "ses_root", role: "root" }
const WORKER: Actor = { id: "ses_worker", role: "worker" }
const facts: Facts = { now: T0, onMain: new Set(), gone: new Set() }

type Writing = Parameters<typeof commandOf>[1]
/** The command a call makes; a test's call always makes one. */
const commandIn = (input: CommitmentsInput & { readonly action: Writing }): Command => Result.getOrThrow(commandOf(input, input.action))

interface Played {
  readonly snapshot: Snapshot
  readonly events: ReadonlyArray<RecordEvent>
}
/** The record after `commands`, each by `actor` at `T0` plus its index in seconds; every one is taken. */
const played = (commands: ReadonlyArray<Command>, actor: Actor = ROOT): Played =>
  commands.reduce(
    (held: Played, command, at) => {
      const events = Result.getOrThrow(decideCommand(held.snapshot, command, { actor, now: T0 + at * 1000 }))
      return { snapshot: fold(held.snapshot, events), events: [...held.events, ...events] }
    },
    { snapshot: EMPTY, events: [] },
  )
const stored = (events: ReadonlyArray<RecordEvent>): ReadonlyArray<StoredEvent> => events.map((event, at) => ({ ...event, seq: at + 1 }))

const parts = (ids: ReadonlyArray<string>) => ids.map((id) => ({ id, title: `the ${id} part` }))
const add = (ids: ReadonlyArray<string>, source_kind: "plan-part" | "owner-answer" = "plan-part") =>
  commandIn({ action: "add", source_kind, source_ref: "plan.md:1", parts: parts(ids) })
const assign = (id: string, owner_lane: string, after: CommitmentsInput["after"] = []) => commandIn({ action: "assign", id, owner_lane, after })

describe("inputRefusal", () => {
  test("a field the action does not take is refused by name, then a field it needs", () => {
    expect(inputRefusal({ action: "release", id: "a", why: "x" })).toEqual(Option.some("commitments: release takes no why; it takes id."))
    expect(inputRefusal({ action: "decide", id: "a" })).toEqual(Option.some("commitments: decide needs why."))
    expect(inputRefusal({ action: "list" })).toEqual(Option.none())
  })
})

describe("commandOf", () => {
  test("a review_by that is not an ISO time makes no command, and says which", () => {
    const refused = commandOf({ action: "assign", id: "p1", owner_lane: "u1", review_by: "next week" }, "assign")
    expect(Result.match(refused, { onFailure: (why) => why, onSuccess: () => "made" })).toBe('commitments: the review_by "next week" is not an ISO time')
  })

  test("a worker's follow-up is one unowned follow-up commitment, sourced to its call, with the owner it suggests", () => {
    const command = followUpCommandOf({ id: "f1", title: "a missing test", suggest_owner: "u2" }, "ses_worker", "call_9")
    const { snapshot, events } = played([command], WORKER)
    const row = Option.fromUndefinedOr(snapshot.commitments.get("f1"))
    expect(Option.map(row, (each) => [each.sourceKind, each.sourceRef, each.ownerLane, each.state])).toEqual(Option.some(["follow-up", "ses_worker:call_9", Option.none(), "open"]))
    // The suggestion is the promise's own field: the event keeps it; the row (Ergo's columns) has none.
    expect(Arr.map(events, (event) => event.happening)).toEqual([expect.objectContaining({ suggestOwner: Option.some("u2") })])
  })
})

describe("the answers", () => {
  test("add with three parts answers their ids, unowned; list shows each with its standing", () => {
    const command = add(["p1", "p2", "p3"])
    const { snapshot, events } = played([command])
    expect(doneAnswer(command, events, snapshot)).toBe("commitments: added p1, p2, p3. Unowned until assigned: p1, p2, p3.")
    expect(listAnswer({ action: "list" }, snapshot, facts).split("\n")).toEqual([
      "commitments: 3",
      ...["p1", "p2", "p3"].map((id) => `${id} [unowned] -: the ${id} part (plan-part plan.md:1; default)`),
    ])
    expect(listAnswer({ action: "list", standing: "held" }, snapshot, facts)).toBe("commitments: none match.")
  })

  test("an order answers every open commitment of its owner, started or not", () => {
    const order = commandIn({ action: "order", owner_lane: "u1", ids: ["p1"] })
    const before = played([add(["p1", "p2", "p3"]), assign("p1", "u1"), assign("p2", "u1")])
    const events = Result.getOrThrow(decideCommand(before.snapshot, order, { actor: ROOT, now: T0 + 9000 }))
    expect(doneAnswer(order, events, fold(before.snapshot, events))).toBe("commitments: started p1. u1's open commitments, each placed by this order: p1, p2.")
  })

  test("a root's decision on what the owner approved says the owner is told; history lists each event", () => {
    const decide = commandIn({ action: "decide", id: "o1", why: "not needed" })
    const { snapshot, events } = played([add(["o1"], "owner-answer"), decide])
    expect(doneAnswer(decide, events.slice(1), snapshot)).toBe("commitments: o1 closed by decision. The owner approved it: they are told, and can have it reopened.")
    const history = historyAnswer("o1", stored(events)).split("\n")
    expect(history.slice(1).map((line) => line.split(" ").slice(2, 7).join(" "))).toEqual(["promised by root ses_root", "decided open → decided by"])
    expect(historyAnswer("nope", [])).toBe("commitments: nope has no history: no such commitment.")
  })
})

describe("the section", () => {
  test("counts by standing, ten ids a standing with owner-sourced first, the rest by the list call; quiet when only held", () => {
    const plan = Arr.makeBy(11, (at) => `p${String(at + 1).padStart(2, "0")}`)
    const listed = played([add(plan), add(["o1"], "owner-answer")])
    expect(sectionOf(listedOf(listed.snapshot, facts))).toEqual([
      'Commitments: 12 open (12 unowned, 0 orphaned, 0 overdue, 0 due, 0 held). Only held is quiet: own (commitments({ action: "assign" })), order or decide each listed one.',
      '- unowned: o1, p01, p02, p03, p04, p05, p06, p07, p08, p09, and 2 more: commitments({ action: "list", standing: "unowned" })',
    ])
    const held = played([add(plan), add(["o1"], "owner-answer"), ...[...plan, "o1"].map((id) => assign(id, "root", [{ kind: "manual", ref: "later" }]))])
    expect(sectionOf(listedOf(held.snapshot, facts))).toEqual([])
  })

  test("its keys change only when its set of ids changes", () => {
    const first = sectionKeys(listedOf(played([add(["a", "b"])]).snapshot, facts))
    const second = sectionKeys(listedOf(played([add(["a", "b"]), assign("a", "root")]).snapshot, facts))
    expect(first).toEqual(["commitment:unowned:a", "commitment:unowned:b"])
    expect(second).toEqual(["commitment:unowned:b", "commitment:due:a"])
  })
})

describe("the lane's answer", () => {
  test("the record's line goes before the implementor's start, which stays last", () => {
    const answer = ["Lane u1 made at /w/u1.", "Start its implementor:", "agent({ … })"].join("\n")
    expect(beforeStart(answer, laneLine("u1", ["u1", "f1"])).split("\n")).toEqual([
      "Lane u1 made at /w/u1.",
      'Commitments of u1: u1, f1. Its hand-back claims what it lands; commitments({ action: "list", owner: "u1" }) lists them.',
      "Start its implementor:",
      "agent({ … })",
    ])
    expect(beforeStart("one\ntwo", "x")).toBe("one\nx\ntwo")
  })
})
