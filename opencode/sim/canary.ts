// A token-shaped canary and every way to put it in a call: the probe of the record's one rule that no refusal, answer,
// row or log repeats a caller's string it did not validate first (commitments.sim.test.ts, record-cli.test.ts).
import { Effect, FileSystem, Predicate, Schema } from "effect"
import { hostServices } from "./host-services.ts"

/** A GitHub token's shape, from parts, its body invented: what no answer, row or log may repeat. */
export const CANARY = ["gh", "p_", "Cn4ry7Xq2Wv9Lm3Bt8Zs1Kd6Hf0Jp5Rg4Ty2"].join("")

/** A call's JSON. */
export type Json = string | number | boolean | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** A call's fields. */
export type Fields = { readonly [key: string]: Json }

const isList = (value: Json): value is ReadonlyArray<Json> => Array.isArray(value)
const isFields = (value: Json): value is Fields => Predicate.isObject(value)

/**
 * Each way to put the canary in `call`, one call per way: every leaf (a string, a number, a flag) replaced by it, and
 * beside every object's keys one more key of its text.
 */
export const canaried = (call: Json): ReadonlyArray<Json> => {
  if (isList(call)) return call.flatMap((item, at) => canaried(item).map((each): Json => [...call.slice(0, at), each, ...call.slice(at + 1)]))
  if (isFields(call)) return canariedFields(call)
  return [CANARY]
}

/** `canaried` of an object: one more key of the canary's text, then each field's ways. */
export const canariedFields = (call: Fields): ReadonlyArray<Fields> => [
  { ...call, [CANARY]: 1 },
  ...Object.entries(call).flatMap(([key, value]) => canaried(value).map((each) => ({ ...call, [key]: each }))),
]

const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Whether the canary is anywhere in `value`, once written as JSON (a log line, an answer). */
export const mentions = <A>(value: A): boolean => jsonOf(value).includes(CANARY)

/** Each file's bytes as text, an absent file as nothing: a record's database and its write-ahead log, to search. */
export const textsOf = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.forEach(paths, (path) =>
      fs.readFile(path).pipe(
        Effect.map((bytes) => new TextDecoder().decode(bytes)),
        Effect.orElseSucceed(() => ""),
      ),
    )
  }).pipe(Effect.provide(hostServices))

/** The commitments calls the canary goes into, one per action and reason form, each valid on a record holding a1 and a2. */
export const COMMITMENT_CALLS: ReadonlyArray<Fields> = [
  {
    action: "add",
    run: "r1",
    source_kind: "plan-part",
    source_ref: "plan.md:1",
    plan: "plan-a",
    parts: [{ id: "c1", title: "one", part: "p1", rank: "B", owner_lane: "lane-a", after: [{ kind: "manual", ref: "go" }], review_by: "2026-12-01T00:00:00.000Z" }],
  },
  { action: "add", source_kind: "owner-answer", source_ref: "ses_owner:q1", quote: "yes, do it", parts: [{ id: "c2", title: "two" }] },
  { action: "assign", id: "a1", owner_lane: "lane-a", owner_session: "ses_a", after: [{ kind: "manual", ref: "go" }], review_by: "2026-12-01T00:00:00.000Z" },
  { action: "order", owner_lane: "lane-a", ids: ["a1"] },
  { action: "release", id: "a1" },
  { action: "invariant", id: "one-writer", doc_path: "docs/record.md", anchor: "one-writer" },
  { action: "decide", id: "a2", why: "held", reason_class: "guarantee", referent: { kind: "invariant", id: "one-writer" } },
  { action: "defer", id: "a2", reason_class: "dependency", referent: { kind: "commitment", id: "a1" } },
  { action: "defer", id: "a2", reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/red.json" } },
  { action: "reopen", id: "a1" },
  { action: "word", run: "r1", word: "go" },
  { action: "route", hand_back: 1, as: "routed" },
  { action: "landed", id: "a1", head: "abc1234" },
  { action: "list", owner: "lane-a", standing: "due", run: "r1", age: 1, all: true },
  { action: "history", id: "a1" },
  { action: "import", run: "r1", from: "/nonexistent/loop-probe-x/register.db", map: "ergo-register" },
]

/** The follow_up calls the canary goes into: a dependency and a measurement. */
export const FOLLOW_UP_CALLS: ReadonlyArray<Fields> = [
  { id: "f1", title: "a flake", rank: "C", suggest_owner: "lane-a", key: "k1", reason_class: "dependency", referent: { kind: "commitment", id: "a1" } },
  { id: "f2", title: "a flake", key: "k2", reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/red.json" } },
]
