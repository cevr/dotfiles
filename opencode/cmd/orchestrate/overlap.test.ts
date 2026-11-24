// @reads all
// @reads-reason computed read at sim/canary.ts: fs.readFile(path).pipe(
import { expect, test } from "bun:test"
import { Array as Arr, Cause, Data, Effect, Exit, Layer, Option, Ref, Schema } from "effect"
import * as PrintableModule from "@dotfiles/opencode-orchestrate/printable"
import { noEvidence } from "@dotfiles/opencode-orchestrate/reasons"
import { CommitmentRecord } from "@dotfiles/opencode-orchestrate/service"
import { textsOf } from "../../sim/canary.ts"
import { simulationTest } from "../../sim/seed.ts"
import { generator } from "../../sim/runtime.ts"
import { KINDS, leaked } from "../../sim/tokens.ts"
import { scratch } from "../../tests/scratch.ts"
import { boot, WORK } from "./orch-tools-world.ts"
import { main, ranOf } from "./record.ts"

const { printable } = PrintableModule

const ALNUM = "Z9x8W7v6T5r4Q3p2N1m0LkJhGfEdCbAaUuVwXyYzRsStFiIoOBcDeMgHPqKn"
const UPPER = "Z9W8T7Q6N5L4J3G2E1C0AUVXYRSFIOBDMHPK"
const WORD = `${ALNUM}_-`
type Cell = string
type Pattern = readonly Cell[]
const literal = (text: string): Pattern => [...text]
const any = (length: number, chars = ALNUM): Pattern => Arr.makeBy(length, () => chars)
const key = (prefix: string, length: number, chars?: string): Pattern => [...literal(prefix), ...any(length, chars)]

// Independent fixture grammar: a cell names the characters the fixture may draw, not how a production regexp
// searches for a match. The annotation is the union we planted, even when one shape hides another's start.
const FORMS: ReadonlyArray<readonly [string, Pattern]> = [
  ["random", any(32)],
  ["bearer", key("Bearer ", 12, `${WORD}.~+/=`)],
  ["stripe", key("sk-", 16, WORD)],
  ["stripe-env", key("sk_live_", 16)],
  ["github", key("ghp_", 20)],
  ["github-pat", key("github_pat_", 20, `${ALNUM}_`)],
  ["slack", key("xoxb-", 10, `${ALNUM}-`)],
  ["aws", key("AKIA", 16, UPPER)],
  ["google", key("AIza", 35, WORD)],
  ["gitlab", key("glpat-", 20, WORD)],
  ["jwt", [...key("eyJ", 8, WORD), ".", ...any(8, WORD), ".", ...any(8, WORD)]],
  ["pem", [...literal("-----BEGIN PRIVATE KEY-----\n"), ...any(16, `${WORD}.~+/= \n`), ...literal("\n-----END PRIVATE KEY-----")]],
]

/** Both shapes must hold at a shared cell; incompatible offsets cannot occur in text. */
const overlay = (left: Pattern, right: Pattern, from: number): Option.Option<Pattern> => {
  const combined = [...left]
  for (let at = 0; at < right.length; at++) {
    const b = right[at]
    const a = Option.getOrElse(Arr.get(left, from + at), () => b)
    if (a === b) {
      combined[from + at] = b
      continue
    }
    const both = [...a].filter((char) => b.includes(char)).join("")
    if (both.length === 0) return Option.none()
    combined[from + at] = both
  }
  return Option.some(combined)
}

const isRandomFixture = (value: string): boolean => {
  const frequencies = new Map<string, number>()
  for (const c of value) frequencies.set(c, Option.getOrElse(Option.fromUndefinedOr(frequencies.get(c)), () => 0) + 1)
  return [...frequencies.values()].reduce((bits, count) => {
    const p = count / value.length
    return bits - p * Math.log2(p)
  }, 0) >= 4.2 && /[a-z]/i.test(value) && /\d/.test(value)
}

/** Choose each unconstrained character deterministically. Draw again if an annotated random window lacks entropy. */
const draw = (pattern: Pattern, randomOffsets: ReadonlyArray<number>): Option.Option<string> => {
  for (let seed = 0; seed < 4; seed++) {
    const text = pattern.map((cell, at) => cell[(at * 23 + seed * 19) % cell.length]).join("")
    if (randomOffsets.every((from) => isRandomFixture(text.slice(from, from + 32)))) return Option.some(text)
  }
  return Option.none()
}

const offsets = (length: number): ReadonlyArray<number> => Arr.range(0, length)
const randomAt = (kind: string, at: number): ReadonlyArray<number> => Arr.filter([at], () => kind === "random")

interface Composition {
  readonly pattern: Pattern
  readonly last: number
  readonly random: ReadonlyArray<number>
  readonly name: string
}

/** All placements starting at or after the previous token, including an immediately touching one. */
function* extend(base: Composition): Iterable<Composition> {
  for (const [kind, pattern] of FORMS) {
    for (let at = base.last; at <= base.pattern.length; at++) {
      const joined = overlay(base.pattern, pattern, at)
      if (Option.isSome(joined)) yield { pattern: joined.value, last: at, random: [...base.random, ...randomAt(kind, at)], name: `${base.name}/${kind}@${at}` }
    }
  }
}

test("intersecting and touching pairs and triples of secret shapes are replaced whole", () => {
  let pairs = 0
  let triples = 0
  let discarded = 0
  const failed: Array<string> = []
  const check = (each: Composition): boolean => {
    const token = draw(each.pattern, each.random)
    if (Option.isNone(token)) {
      discarded++
      return false
    }
    const output = printable(`before!qqqqqq${token.value}zzzzzz!after`)
    if (output !== "before![redacted]!after" && failed.length < 8) failed.push(each.name)
    return true
  }
  for (const [kind, pattern] of FORMS) {
    for (const pair of extend({ pattern, name: kind, last: 0, random: randomAt(kind, 0) })) {
      if (check(pair)) pairs++
      for (const triple of extend(pair)) if (check(triple)) triples++
    }
  }
  expect(pairs).toBeGreaterThan(FORMS.length ** 2)
  expect(triples).toBeGreaterThan(FORMS.length ** 3)
  expect({ generated: pairs + triples + discarded, pairs, triples, discarded })
    .toEqual({ generated: 206_174, pairs: 1_518, triples: 204_656, discarded: 0 })
  expect(failed).toEqual([])
})

const embedded = (at: number): string => {
  const mark = `AK${"IA"}${UPPER.slice(0, 16)}`
  const stem = ALNUM.slice(10, 36)
  return `${stem.slice(0, at)}${mark}${stem.slice(at)}`
}

test("a fixed-width recognizer inside a longer random run cannot expose either remainder", () => {
  const failures = offsets(26).filter((at) => {
    const value = embedded(at)
    return leaked(printable(value), { value, secrets: [value] }).length > 0
  })
  expect(failures).toEqual([])
})

test("a raw string cannot be turned into Printable by decoding an exported schema", () => {
  expect("Printable" in PrintableModule).toBe(false)
  const raw = embedded(12)
  const typed = printable(raw)
  const decodeRefusal = Schema.decodeUnknownExit(Schema.fromJsonString(PrintableModule.RecordRefused))
  const decodeFailure = Schema.decodeUnknownExit(Schema.fromJsonString(PrintableModule.RecordFailed))
  const decodeEvidence = Schema.decodeUnknownExit(Schema.fromJsonString(PrintableModule.EvidenceRefused))
  const cases = [
    decodeRefusal(`{"_tag":"RecordRefused","reason":"${raw}"}`),
    decodeFailure(`{"_tag":"RecordFailed","message":"${raw}"}`),
    decodeEvidence(`{"_tag":"EvidenceRefused","reason":"${raw}"}`),
    decodeRefusal(`{"_tag":"RecordRefused","reason":"${typed}"}`),
  ]
  expect(cases.map((result) => result._tag)).toEqual(["Failure", "Failure", "Failure", "Success"])
})

simulationTest("the host receives a redacted failure, not the raw defect, from either record tool", Effect.scoped(Effect.gen(function* () {
  const value = embedded(12)
  const defect = Effect.die(new Error(`scratch reader defect: ${value}`))
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
  const run = yield* boot(1, true, {}, () => Layer.merge(
    Layer.succeed(CommitmentRecord, CommitmentRecord.of({ read: defect, run: () => defect, replayed: () => defect, history: () => defect, events: defect })),
    noEvidence,
  ))
  const root = yield* run.world.session(WORK)
  const child = yield* run.world.session(WORK, { parentID: root })
  const answers = [
    yield* run.probe(root, "commitments", { action: "list" }),
    yield* run.probe(child, "follow_up", { id: "one", title: "one", reason_class: "dependency", referent: { kind: "commitment", id: "two" } }),
  ]
  const status = yield* run.probe(root, "orchestrate", { action: "status" })
  const logs = encode(run.world.logs())
  expect(answers.map((answer) => answer.error)).toEqual([true, true])
  expect(answers.every((answer) => answer.text.includes("scratch reader defect: [redacted]"))).toBe(true)
  expect(status.text).toContain("Commitments: the record did not read")
  expect(logs).toContain("scratch reader defect: [redacted]")
  expect(leaked(encode({ answers, status, logs }), { value, secrets: [value] }).length).toBe(0)
})))

const separators = [
  ["space", " "], ["tab", "\t"], ["line", "\n"], ["quote", "\""], ["backslash", "\\"], ["unicode space", "\u2003"],
] as const
const diagnosticForms = KINDS.map(([kind, draw]) => {
  if (kind === "bearer") {
    const body = ALNUM.slice(4, 20)
    return { kind, text: `Bearer ${body}`, secret: body }
  }
  return draw(generator(`record-diagnostic/${kind}`))
})

/** A native Error subclass: message and cause are own data, whereas stack is rendered lazily. */
class NativeDiagnostic extends Data.TaggedError("NativeDiagnostic")<{ readonly message: string; readonly cause?: Error }> {}

/** One set of original recognized values through each diagnostic representation, before escaping can alter it. */
const diagnostics = () => diagnosticForms.flatMap(({ kind, text, secret }) => separators.map(([label, separator]) => {
  let separated = text
  if (kind === "bearer" && label !== "quote" && label !== "backslash") separated = `Bearer${separator}${secret}`
  const original = `before${separator}${separated}${separator}after`
  const native = new NativeDiagnostic({ message: original })
  return { label: `${kind}/${label}`, body: secret, original, representations: [
    original,
    native,
    new NativeDiagnostic({ message: "outer scratch defect", cause: native }),
    Cause.die({ cause: Cause.die(original) }),
    { diagnostic: [{ [original]: original }] },
    [original, { inner: original }],
  ] }
}))

test("the CLI rewrites original diagnostic leaves before formatting separators, nested errors, arrays or object fields", () => {
  const cases = diagnostics()
  expect(cases.length).toBe(12 * 6)
  const escaped = cases.flatMap(({ label, body, original, representations }) => representations.flatMap((value, at) => {
    const ran = ranOf(Exit.die(value))
    const stdout = ranOf(Exit.succeed(PrintableModule.diagnostic(value)))
    const refused = ranOf(Exit.fail(PrintableModule.diagnostic(value)))
    return Arr.filter([`${label}/${at}`], () =>
      ran.code !== 1 || stdout.code !== 0 || refused.code !== 1 || [ran.err, stdout.out, refused.err].some((text) =>
        !text.includes("[redacted]") || leaked(text, { value: original, secrets: [body] }).length > 0))
  }))
  expect(escaped).toEqual([])
})

test("opaque defects never invoke getters or render hooks", () => {
  const body = ALNUM.slice(0, 18)
  let calls = 0
  const get = () => {
    calls++
    return `Bearer\t${body}`
  }
  const value = { get message() { return get() }, toString: get, toJSON: get }
  expect(ranOf(Exit.die(value)).err).toContain("record/opaque-defect")
  expect(calls).toBe(0)
})

simulationTest("registered tool refusals, status and logs redact diagnostic leaves before the host renders them", Effect.scoped(Effect.gen(function* () {
  const current = yield* Ref.make<unknown>("scratch")
  const defect = Ref.get(current).pipe(Effect.flatMap(Effect.die))
  const run = yield* boot(1, true, {}, () => Layer.merge(
    Layer.succeed(CommitmentRecord, CommitmentRecord.of({ read: defect, run: () => defect, replayed: () => defect, history: () => defect, events: defect })),
    noEvidence,
  ))
  const root = yield* run.world.session(WORK)
  const child = yield* run.world.session(WORK, { parentID: root })
  const follow = { id: "one", title: "one", reason_class: "dependency", referent: { kind: "commitment", id: "two" } }
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
  let exercised = 0
  for (const { body, original, representations } of diagnostics()) {
    for (const defect of representations) {
      yield* Ref.set(current, defect)
      const from = run.world.logs().length
      const a = yield* run.probe(root, "commitments", { action: "list" })
      const b = yield* run.probe(child, "follow_up", follow)
      const status = yield* run.probe(root, "orchestrate", { action: "status" })
      const log = encode(run.world.logs().slice(from))
      const outputs = [a.text, b.text, status.text, log]
      expect([a.error, b.error, status.error]).toEqual([true, true, false])
      expect(outputs.every((text) => text.includes("[redacted]") && leaked(text, { value: original, secrets: [body] }).length === 0)).toBe(true)
      exercised += outputs.length
    }
  }
  expect(exercised).toBe(12 * 6 * 6 * 4)
})))

simulationTest("CLI list, history, export and the stored bytes agree for overlapping tokens at every offset", Effect.gen(function* () {
  using dir = scratch("record-overlap-")
  const path = `${dir.path}/record.db`
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
  const call = (action: string, fields: Schema.Json) => main([action, "--json", encode(fields), "--file", path], dir.path)
  const values = offsets(26).map(embedded)
  const parts = values.map((value, i) => ({ id: `part-${i}`, title: `keep this text!${value}!`, part: value }))
  const added = yield* call("add", { source_kind: "owner-answer", source_ref: "ses_owner:q1", quote: values[0], parts })
  const listed = yield* call("list", { all: true })
  const history = yield* call("history", { id: "part-12" })
  const exported = yield* call("export", {})
  const answers = [added, listed, history, exported]
  const bytes = yield* textsOf([path, `${path}-wal`])
  expect(answers.map((answer) => answer.code)).toEqual([0, 0, 0, 0])
  expect(listed.out).toContain("keep this text![redacted]!")
  expect(exported.out).toContain("keep this text![redacted]!")
  expect(bytes.some((file) => file.includes("keep this text![redacted]!"))).toBe(true)
  const outputs = [...bytes, ...answers.flatMap((answer) => [answer.out, answer.err])]
  expect(values.some((value) => outputs.some((output) => leaked(output, { value, secrets: [value] }).length !== 0))).toBe(false)
}))
