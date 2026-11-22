// The `commitments` and `follow_up` tools' handlers over the memory record: what each call answers and refuses, and
// the record's section (counts, at most ten ids a standing, owner-sourced first, the call that lists the rest), said
// again only when its ids change.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Option, Result } from "effect"
import * as Seed from "../../sim/seed.ts"
import {
  answerOf,
  beforeStart,
  type CommitmentsInput,
  followUpOf,
  inputRefusal,
  laneLine,
  listedOf,
  type Reads,
  sectionKeys,
  sectionOf,
} from "./commitments-tool.ts"
import * as MemoryRecord from "./memory/record.ts"
import type { Actor } from "./record.ts"
import { CommitmentRecord } from "./service.ts"
import type { Facts } from "./standing.ts"

const T0 = Date.parse("2026-11-22T10:00:00.000Z")
const ROOT: Actor = { id: "ses_root", role: "root" }
const WORKER: Actor = { id: "ses_worker", role: "worker" }
const facts = (now = T0): Facts => ({ now, onMain: new Set(), gone: new Set() })
const READS: Reads = { facts: () => Effect.succeed(facts()), register: () => Effect.fail("no register in this test") }

const call = (input: CommitmentsInput, actor: Actor = ROOT, now = T0) => Effect.result(answerOf(input, actor, now, READS))
const said = (input: CommitmentsInput, actor: Actor = ROOT, now = T0) => Effect.orDie(answerOf(input, actor, now, READS))
const section = Effect.gen(function* () {
  const listed = listedOf(yield* (yield* CommitmentRecord).read, facts())
  return { lines: sectionOf(listed), keys: sectionKeys(listed) }
})
const parts = (ids: ReadonlyArray<string>) => ids.map((id) => ({ id, title: `the ${id} part` }))
const add = (ids: ReadonlyArray<string>, source_kind: "plan-part" | "owner-answer" = "plan-part"): CommitmentsInput => ({ action: "add", source_kind, source_ref: "plan.md:1", parts: parts(ids) })
const recorded = <A, E>(name: string, body: Effect.Effect<A, E, CommitmentRecord>) => Seed.effect(name, Effect.provide(body, MemoryRecord.layer))

describe("inputRefusal", () => {
  test("a field the action does not take is refused by name, then a field it needs", () => {
    expect(inputRefusal({ action: "release", id: "a", why: "x" })).toEqual(Option.some("commitments: release takes no why; it takes id."))
    expect(inputRefusal({ action: "decide", id: "a" })).toEqual(Option.some("commitments: decide needs why."))
    expect(inputRefusal({ action: "list" })).toEqual(Option.none())
  })
})

describe("answerOf", () => {
  recorded(
    "add with three parts makes three open, unowned commitments, and list shows them",
    Effect.gen(function* () {
      expect(yield* said(add(["p1", "p2", "p3"]))).toBe("commitments: added p1, p2, p3. Unowned until assigned: p1, p2, p3.")
      const listed = yield* said({ action: "list" })
      expect(listed.split("\n")).toEqual(["commitments: 3", ...["p1", "p2", "p3"].map((id) => `${id} [unowned] -: the ${id} part (plan-part plan.md:1; default)`)])
      expect(yield* said({ action: "list", standing: "held" })).toBe("commitments: none match.")
    }),
  )

  recorded(
    "a review_by that is not an ISO time is refused, and nothing is written",
    Effect.gen(function* () {
      yield* said(add(["p1"]))
      const refused = yield* call({ action: "assign", id: "p1", owner_lane: "u1", review_by: "next week" })
      expect(Result.match(refused, { onFailure: (why) => why, onSuccess: () => "answered" })).toBe('commitments: the review_by "next week" is not an ISO time')
      expect(yield* said({ action: "list", owner: "u1" })).toBe("commitments: none match.")
    }),
  )

  recorded(
    "an order starts the named ones and answers every open commitment of its owner",
    Effect.gen(function* () {
      yield* said(add(["p1", "p2", "p3"]))
      for (const id of ["p1", "p2"]) yield* said({ action: "assign", id, owner_lane: "u1" })
      expect(yield* said({ action: "order", owner_lane: "u1", ids: ["p1"] })).toBe("commitments: started p1. u1's open commitments, each placed by this order: p1, p2.")
    }),
  )

  recorded(
    "a worker cannot close what the owner approved; a root can, and the answer says the owner is told",
    Effect.gen(function* () {
      yield* said(add(["o1"], "owner-answer"))
      const refused = yield* call({ action: "decide", id: "o1", why: "not needed" }, WORKER)
      expect(refused._tag).toBe("Failure")
      expect(yield* said({ action: "decide", id: "o1", why: "not needed" })).toBe("commitments: o1 closed by decision. The owner approved it: they are told, and can have it reopened.")
      const history = (yield* said({ action: "history", id: "o1" })).split("\n")
      expect(history.slice(1).map((line) => line.split(" ")[2])).toEqual(["promised", "decided"])
    }),
  )

  recorded(
    "history of an id never promised says so",
    Effect.gen(function* () {
      expect(yield* said({ action: "history", id: "nope" })).toBe("commitments: nope has no history: no such commitment.")
    }),
  )
})

describe("followUpOf", () => {
  recorded(
    "a worker's follow-up is one unowned follow-up commitment, sourced to its call, with the owner it suggests",
    Effect.gen(function* () {
      expect(yield* Effect.orDie(followUpOf({ id: "f1", title: "a missing test", suggest_owner: "u2" }, WORKER, "call_9", T0))).toBe("follow_up: filed f1, unowned; the root owns or decides it.")
      const record = yield* CommitmentRecord
      const row = Option.fromUndefinedOr((yield* record.read).commitments.get("f1"))
      expect(Option.map(row, (each) => [each.sourceKind, each.sourceRef, each.ownerLane])).toEqual(Option.some(["follow-up", "ses_worker:call_9", Option.none()]))
      // The suggestion is the promise's own field: the event keeps it, the row (Ergo's columns) has none.
      const promised = Arr.findFirst(yield* record.history("commitment", "f1"), (event) => event.happening._tag === "promised")
      expect(Option.map(promised, (event) => event.happening)).toEqual(Option.some(expect.objectContaining({ suggestOwner: Option.some("u2") })))
      const again = yield* Effect.result(followUpOf({ id: "f1", title: "the same id" }, WORKER, "call_10", T0))
      expect(again._tag).toBe("Failure")
    }),
  )
})

describe("the section", () => {
  recorded(
    "counts by standing, ten ids a standing with owner-sourced first, the rest by the list call; quiet when only held",
    Effect.gen(function* () {
      const plan = Arr.makeBy(11, (at) => `p${String(at + 1).padStart(2, "0")}`)
      yield* said(add(plan))
      yield* said(add(["o1"], "owner-answer"), ROOT, T0 + 1000)
      const { lines } = yield* section
      expect(lines).toEqual([
        'Commitments: 12 open (12 unowned, 0 orphaned, 0 overdue, 0 due, 0 held). Only held is quiet: own (commitments({ action: "assign" })), order or decide each listed one.',
        '- unowned: o1, p01, p02, p03, p04, p05, p06, p07, p08, p09, and 2 more: commitments({ action: "list", standing: "unowned" })',
      ])
      for (const id of [...plan, "o1"]) yield* said({ action: "assign", id, owner_lane: "root", after: [{ kind: "manual", ref: "later" }] })
      expect((yield* section).lines).toEqual([])
    }),
  )

  recorded(
    "its keys change only when its set of ids changes",
    Effect.gen(function* () {
      yield* said(add(["a", "b"]))
      const first = (yield* section).keys
      yield* said({ action: "assign", id: "a", owner_lane: "root", review_by: "2026-11-30T00:00:00.000Z" })
      const second = (yield* section).keys
      expect(first).toEqual(["commitment:unowned:a", "commitment:unowned:b"])
      expect(second).toEqual(["commitment:unowned:b", "commitment:due:a"])
      expect((yield* section).keys).toEqual(second)
    }),
  )
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
