// The verifier's round 2 redaction probe, adopted: three provider-shaped tokens (built from parts, invented bodies) put
// in every field each tool, a worker's follow_up, the lane hook and a land's claim can set, and as a CLI --actor. No
// answer or refusal repeats one, no TEXT column of the live schema holds one, and the status section shows none.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { Effect, Option } from "effect"
import * as Seed from "../../../sim/seed.ts"
import { scratch } from "../../../tests/scratch.ts"
import * as Tool from "../commitments-tool.ts"
import { type Actor, Command } from "../record.ts"
import { CommitmentRecord } from "../service.ts"
import { connectSync, textColumnsOf } from "./record.ts"

const SHAPES = {
  gh: ["gh", "p_", "Zq8xW2mN4vB7cR1tY6uI9oP3aS5dF0gH2jK4"].join(""),
  sk: ["sk", "-ant-api03-", "Q7wE2rT9yU4iO1pA6sD3fG8hJ5kL0zX"].join(""),
  ak: ["AK", "IA", "Q2W3E4R5T6Y7U8I9"].join(""),
}
const BODIES = Object.values(SHAPES).map((shape) => shape.slice(-14))
const leaks = (text: string): number => BODIES.filter((body) => text.includes(body)).length
const T = Date.parse("2026-11-22T10:00:00.000Z")
const ROOT: Actor = { id: "ses_rootA", role: "root" }
const WORKER: Actor = { id: "ses_child", role: "worker" }
const PLUGIN: Actor = { id: "orchestrate-land", role: "plugin" }
const READS: Tool.Reads = { facts: () => Effect.succeed({ now: T, onMain: new Set(), gone: new Set() }), register: () => Effect.fail("none") }

/** Every path's answer or refusal, as text, by the path's name. */
const paths = (store: ReturnType<typeof connectSync>["store"]) =>
  Effect.gen(function* () {
    const said: Array<readonly [string, string]> = []
    const outcome = <A, E>(path: string, effect: Effect.Effect<A, E, CommitmentRecord>) =>
      Effect.map(Effect.result(Effect.provideService(effect, CommitmentRecord, store)), (done) => void said.push([path, JSON.stringify(done) ?? ""]))
    const tool = (path: string, input: Record<string, unknown>) => outcome(path, Tool.answerOf(input as Tool.CommitmentsInput, ROOT, T, READS))
    const followUp = (path: string, input: Record<string, unknown>) => outcome(path, Tool.followUpOf(input as Tool.FollowUpInput, WORKER, `c-${said.length}`, T))
    const command = (path: string, sent: Command, actor: Actor) => outcome(path, store.run(sent, { actor, now: T }))
    const counter = { n: 0 }
    for (const [shape, token] of Object.entries(SHAPES)) {
      const id = () => `p${shape}${++counter.n}`
      yield* tool(`${shape} add.title`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: `do ${token}` }] })
      yield* tool(`${shape} add.source_ref`, { action: "add", source_kind: "plan-part", source_ref: `plan:${token}`, parts: [{ id: id(), title: "t" }] })
      yield* tool(`${shape} add.quote`, { action: "add", source_kind: "owner-ask", source_ref: "q:1", quote: `use ${token}`, parts: [{ id: id(), title: "t" }] })
      yield* tool(`${shape} add.plan`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", plan: `plan ${token}`, parts: [{ id: id(), title: "t" }] })
      yield* tool(`${shape} add.part`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", part: `part ${token}` }] })
      yield* tool(`${shape} add.parts.id`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: token, title: "t" }] })
      yield* tool(`${shape} add.parts.owner_lane`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", owner_lane: token }] })
      yield* tool(`${shape} add.parts.after.ref`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", after: [{ kind: "manual", ref: token }] }] })
      yield* tool(`${shape} add.run`, { action: "add", run: token, source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t" }] })
      yield* tool(`${shape} add.review_by`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", review_by: token }] })
      const target = id()
      yield* tool(`${shape} add (target)`, { action: "add", source_kind: "owner-ask", source_ref: "q:2", parts: [{ id: target, title: "t" }] })
      yield* tool(`${shape} assign.owner_lane`, { action: "assign", id: target, owner_lane: token })
      yield* tool(`${shape} assign.owner_session`, { action: "assign", id: target, owner_lane: "lane-x", owner_session: token })
      yield* tool(`${shape} assign.after.ref`, { action: "assign", id: target, owner_lane: "lane-x", after: [{ kind: "commit-on-main", ref: token }] })
      yield* tool(`${shape} word.word`, { action: "word", word: token })
      yield* tool(`${shape} order.owner_lane`, { action: "order", owner_lane: token, ids: [target] })
      yield* tool(`${shape} decide.why`, { action: "decide", id: target, why: `because ${token}` })
      yield* tool(`${shape} decide.id`, { action: "decide", id: token, why: "x" })
      yield* tool(`${shape} landed.head`, { action: "landed", id: target, head: token })
      yield* tool(`${shape} list.owner`, { action: "list", owner: token })
      yield* tool(`${shape} history.id`, { action: "history", id: token })
      yield* followUp(`${shape} follow_up.id`, { id: token, title: "t" })
      yield* followUp(`${shape} follow_up.title`, { id: id(), title: `t ${token}` })
      yield* followUp(`${shape} follow_up.suggest_owner`, { id: id(), title: "t", suggest_owner: token })
      yield* followUp(`${shape} follow_up.suggest_owner (prose)`, { id: id(), title: "t", suggest_owner: `lane ${token}` })
      yield* followUp(`${shape} follow_up.run`, { id: id(), title: "t", run: token })
      yield* command(`${shape} lane.unit`, Command.cases.lane.make({ run: "default", unit: token }), ROOT)
      yield* command(`${shape} lane.startHead`, Command.cases.lane.make({ run: "default", unit: id(), startHead: Option.some(token) }), ROOT)
      yield* command(`${shape} lane.path`, Command.cases.lane.make({ run: "default", unit: id(), path: Option.some(`/w/${token}`) }), ROOT)
      const lane = id()
      yield* command(`${shape} lane (target)`, Command.cases.lane.make({ run: "default", unit: lane }), ROOT)
      yield* command(`${shape} hand_back.session`, Command.cases.hand_back.make({ run: "default", ownerLane: lane, role: "land", session: token, verdict: "done", head: Option.some("1".repeat(40)), claims: [lane] }), PLUGIN)
      yield* command(`${shape} hand_back.head`, Command.cases.hand_back.make({ run: "default", ownerLane: lane, role: "land", session: "ses_x", verdict: "done", head: Option.some(token), claims: [lane] }), PLUGIN)
      yield* command(`${shape} hand_back.role`, Command.cases.hand_back.make({ run: "default", ownerLane: lane, role: `r ${token}`, session: "ses_x", verdict: "done", head: Option.none(), claims: [] }), PLUGIN)
      yield* command(`${shape} actor.id (CLI --actor)`, Command.cases.word.make({ run: "default", word: `w${counter.n}` }), { id: token, role: "root" })
    }
    return said
  })

Seed.effect(
  "a token in any field any path sets is in no answer, no refusal, no TEXT column and not the section",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-redact-")),
    (dir) =>
      Effect.gen(function* () {
        const file = `${dir.path}/redact.db`
        const opened = connectSync(file, { readonly: false, now: T })
        const said = yield* paths(opened.store)
        opened.close()
        expect(said.length).toBe(3 * 34)
        expect(said.filter(([, text]) => leaks(text) > 0).map(([path]) => path)).toEqual([])
        const db = new Database(file, { readonly: true })
        const leaked = textColumnsOf(db).filter((column) => {
          const [table, name] = column.split(".")
          return db.query<{ value: string | null }, []>(`SELECT ${name} AS value FROM ${table}`).all().some((row) => leaks(row.value ?? "") > 0)
        })
        db.close()
        expect(leaked).toEqual([])
        const read = connectSync(file, { readonly: true, now: T })
        const snapshot = yield* Effect.orDie(read.store.read)
        read.close()
        expect(leaks(Tool.sectionOf(Tool.listedOf(snapshot, { now: T, onMain: new Set(), gone: new Set() })).join("\n"))).toBe(0)
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
)
