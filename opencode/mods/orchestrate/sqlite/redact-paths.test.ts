// The verifier's round 2 redaction probe, adopted: three provider-shaped tokens (built from parts, invented bodies) put
// in every field each tool, a worker's follow_up, the lane hook and a land's claim can set, and as a CLI --actor. No
// answer or refusal repeats one, no TEXT column of the live schema holds one, and the status section shows none.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import * as Seed from "../../../sim/seed.ts"
import { scratch } from "../../../tests/scratch.ts"
import * as Tool from "../commitments-tool.ts"
import { printable } from "../printable.ts"
import { type Actor, Command } from "../record.ts"
import { CommitmentRecord, Evidence } from "../service.ts"
import { evidenceOf } from "../reasons.ts"
import { hostServices } from "../../../sim/host-services.ts"
import { platform as ownPlatform } from "../node/platform.ts"
import { connected, textColumnsOf } from "./record.ts"

/** The host's files, paths and processes (the fork gives a plugin these), and the plugin's own digest. */
const platform = Layer.mergeAll(hostServices, ownPlatform)

const TOKENS = {
  gh: ["gh", "p_", "Zq8xW2mN4vB7cR1tY6uI9oP3aS5dF0gH2jK4"].join(""),
  sk: ["sk", "-ant-api03-", "Q7wE2rT9yU4iO1pA6sD3fG8hJ5kL0zX"].join(""),
  ak: ["AK", "IA", "Q2W3E4R5T6Y7U8I9"].join(""),
}
const BODIES = Object.values(TOKENS).map((token) => token.slice(-14))
const leaks = (text: string): number => BODIES.filter((body) => text.includes(body)).length
/** Any value as the JSON a caller would read: an answer, a refusal, the events a command wrote. */
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Any))
const parsedOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })))
const T = Date.parse("2026-11-22T10:00:00.000Z")
const ROOT: Actor = { id: "ses_rootA", role: "root" }
const WORKER: Actor = { id: "ses_child", role: "worker" }
const PLUGIN: Actor = { id: "orchestrate-land", role: "plugin" }
const READS: Tool.Reads = { facts: () => Effect.succeed({ now: T, onMain: new Set(), gone: new Set() }), register: () => Effect.fail(printable("none")), checkout: "/nonexistent/redact-checkout" }
/** What the evidence reader finds: one committed document; no receipt (a token-shaped path is never one). */
const EVIDENCE = evidenceOf(new Map(), new Map([["docs/record.md", { path: "docs/record.md", blob: "b".repeat(40), commit: "c".repeat(40) }]]))
const GUARANTEED = { reason_class: "guarantee", referent: { kind: "invariant", id: "one-writer" } } as const

/** Every path's answer or refusal, as text, by the path's name. */
const paths = (store: CommitmentRecord["Service"]) =>
  Effect.gen(function* () {
    const said: Array<readonly [string, string]> = []
    const outcome = <A, E>(path: string, effect: Effect.Effect<A, E, CommitmentRecord | Evidence>) =>
      Effect.map(Effect.result(effect.pipe(Effect.provideService(CommitmentRecord, store), Effect.provideService(Evidence, EVIDENCE))), (done) => void said.push([path, jsonOf(done)]))
    const tool = (path: string, input: Tool.CommitmentsInput) => outcome(path, Tool.answerOf(input, ROOT, T, READS))
    const followUp = (path: string, input: Omit<Tool.FollowUpInput, "reason_class" | "referent"> & Partial<Pick<Tool.FollowUpInput, "reason_class" | "referent">>) =>
      outcome(path, Tool.followUpOf({ reason_class: "dependency", referent: { kind: "commitment", id: waited }, ...input }, WORKER, `c-${said.length}`, T, READS.checkout))
    const waited = "waited-on"
    yield* tool("add (waited on)", { action: "add", source_kind: "plan-part", source_ref: "plan:w", parts: [{ id: waited, title: "t" }] })
    yield* tool("invariant (declared)", { action: "invariant", id: "one-writer", doc_path: "docs/record.md", anchor: "one-writer" })
    const command = (path: string, sent: Command, actor: Actor) => outcome(path, store.run(sent, { actor, now: T }))
    const counter = { n: 0 }
    for (const [kind, token] of Object.entries(TOKENS)) {
      const id = () => `p${kind}${++counter.n}`
      yield* tool(`${kind} add.title`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: `do ${token}` }] })
      yield* tool(`${kind} add.source_ref`, { action: "add", source_kind: "plan-part", source_ref: `plan:${token}`, parts: [{ id: id(), title: "t" }] })
      yield* tool(`${kind} add.quote`, { action: "add", source_kind: "owner-ask", source_ref: "q:1", quote: `use ${token}`, parts: [{ id: id(), title: "t" }] })
      yield* tool(`${kind} add.plan`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", plan: `plan ${token}`, parts: [{ id: id(), title: "t" }] })
      yield* tool(`${kind} add.part`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", part: `part ${token}` }] })
      yield* tool(`${kind} add.parts.id`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: token, title: "t" }] })
      yield* tool(`${kind} add.parts.owner_lane`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", owner_lane: token }] })
      yield* tool(`${kind} add.parts.after.ref`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", after: [{ kind: "manual", ref: token }] }] })
      yield* tool(`${kind} add.run`, { action: "add", run: token, source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t" }] })
      yield* tool(`${kind} add.review_by`, { action: "add", source_kind: "plan-part", source_ref: "plan:x", parts: [{ id: id(), title: "t", review_by: token }] })
      const target = id()
      yield* tool(`${kind} add (target)`, { action: "add", source_kind: "owner-ask", source_ref: "q:2", parts: [{ id: target, title: "t" }] })
      yield* tool(`${kind} assign.owner_lane`, { action: "assign", id: target, owner_lane: token })
      yield* tool(`${kind} assign.owner_session`, { action: "assign", id: target, owner_lane: "lane-x", owner_session: token })
      yield* tool(`${kind} assign.after.ref`, { action: "assign", id: target, owner_lane: "lane-x", after: [{ kind: "commit-on-main", ref: token }] })
      yield* tool(`${kind} word.word`, { action: "word", word: token })
      yield* tool(`${kind} order.owner_lane`, { action: "order", owner_lane: token, ids: [target] })
      yield* tool(`${kind} decide.why`, { action: "decide", id: target, why: `because ${token}`, ...GUARANTEED })
      yield* tool(`${kind} decide.id`, { action: "decide", id: token, why: "x", ...GUARANTEED })
      yield* tool(`${kind} decide.referent.id`, { action: "decide", id: id(), why: "x", reason_class: "guarantee", referent: { kind: "invariant", id: token } })
      yield* tool(`${kind} defer.referent.id`, { action: "defer", id: waited, reason_class: "dependency", referent: { kind: "commitment", id: token } })
      yield* tool(`${kind} defer.referent.path`, { action: "defer", id: waited, reason_class: "measured", referent: { kind: "receipt", path: `tmp/orchestrate/${token}.json` } })
      yield* tool(`${kind} invariant.id`, { action: "invariant", id: token, doc_path: "docs/record.md", anchor: "a" })
      yield* tool(`${kind} invariant.doc_path`, { action: "invariant", id: id(), doc_path: `docs/${token}.md`, anchor: "a" })
      yield* tool(`${kind} invariant.anchor`, { action: "invariant", id: id(), doc_path: "docs/record.md", anchor: token })
      yield* tool(`${kind} landed.head`, { action: "landed", id: target, head: token })
      yield* tool(`${kind} list.owner`, { action: "list", owner: token })
      yield* tool(`${kind} history.id`, { action: "history", id: token })
      yield* followUp(`${kind} follow_up.id`, { id: token, title: "t" })
      yield* followUp(`${kind} follow_up.title`, { id: id(), title: `t ${token}` })
      yield* followUp(`${kind} follow_up.suggest_owner`, { id: id(), title: "t", suggest_owner: token })
      yield* followUp(`${kind} follow_up.suggest_owner (prose)`, { id: id(), title: "t", suggest_owner: `lane ${token}` })
      yield* followUp(`${kind} follow_up.run`, { id: id(), title: "t", run: token })
      yield* followUp(`${kind} follow_up.referent.id`, { id: id(), title: "t", referent: { kind: "commitment", id: token } })
      yield* followUp(`${kind} follow_up.referent.path`, { id: id(), title: "t", reason_class: "measured", referent: { kind: "receipt", path: `tmp/orchestrate/${token}.json` } })
      yield* followUp(`${kind} follow_up.key`, { id: id(), title: "t", key: token })
      yield* command(`${kind} lane.unit`, Command.cases.lane.make({ run: "default", unit: token }), ROOT)
      yield* command(`${kind} lane.startHead`, Command.cases.lane.make({ run: "default", unit: id(), startHead: Option.some(token) }), ROOT)
      yield* command(`${kind} lane.path`, Command.cases.lane.make({ run: "default", unit: id(), path: Option.some(`/w/${token}`) }), ROOT)
      const lane = id()
      yield* command(`${kind} lane (target)`, Command.cases.lane.make({ run: "default", unit: lane }), ROOT)
      yield* command(`${kind} hand_back.session`, Command.cases.hand_back.make({ run: "default", ownerLane: lane, role: "land", session: token, verdict: "done", head: Option.some("1".repeat(40)), claims: [lane] }), PLUGIN)
      yield* command(`${kind} hand_back.head`, Command.cases.hand_back.make({ run: "default", ownerLane: lane, role: "land", session: "ses_x", verdict: "done", head: Option.some(token), claims: [lane] }), PLUGIN)
      yield* command(`${kind} hand_back.role`, Command.cases.hand_back.make({ run: "default", ownerLane: lane, role: `r ${token}`, session: "ses_x", verdict: "done", head: Option.none(), claims: [] }), PLUGIN)
      yield* command(`${kind} actor.id (CLI --actor)`, Command.cases.word.make({ run: "default", word: `w${counter.n}` }), { id: token, role: "root" })
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
        const opened = yield* connected(file, { readonly: false, now: T })
        const said = yield* paths(opened.store)
        opened.close()
        expect(said.length).toBe(2 + 3 * 43)
        // The paths a guarantee and a dependency need are taken, so each token path is refused for its token alone.
        expect(said.slice(0, 2).map(([path, text]) => [path, parsedOf(text)._tag])).toEqual([["add (waited on)", "Success"], ["invariant (declared)", "Success"]])
        expect(said.filter(([, text]) => leaks(text) > 0).map(([path]) => path)).toEqual([])
        const db = new Database(file, { readonly: true })
        const leaked = textColumnsOf(db).filter((column) => {
          const [table, name] = column.split(".")
          return db.query<{ value: string }, []>(`SELECT coalesce(${name}, '') AS value FROM ${table}`).all().some((row) => leaks(row.value) > 0)
        })
        db.close()
        expect(leaked).toEqual([])
        const read = yield* connected(file, { readonly: true, now: T })
        const snapshot = yield* Effect.orDie(read.store.read)
        read.close()
        expect(leaks(Tool.sectionOf(Tool.listedOf(snapshot, { now: T, onMain: new Set(), gone: new Set() })).join("\n"))).toBe(0)
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ).pipe(Effect.provide(platform)),
)
