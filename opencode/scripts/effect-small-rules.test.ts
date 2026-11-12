/**
 * The four small rules at their two seams. At the lint CLI: `.oxlintrc.json` refuses, as errors
 * of the exact rule, every generated form of `effect/requireNamedEffectFn`, `effect/preferEffectFn`,
 * `effect/preferPredicateIsTagged` and `effect/noReduceAccumulatorCopy` under each supported
 * import alias, in every path class the config names, while it accepts named and untraced
 * operations, unspanned generators, locally shadowed names and nonmatching local functions, as
 * oxlint-plugin-effect 0.32.3 decides them. At run time: `forkTurns`, whose reducer was the one
 * accumulator copy, folds generated fork histories as an independent model of a turn does, and
 * leaves its input as it was.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Array as Arr, Effect, Option, Schema, type Scope } from "effect"
import { forkTurns, type Turn } from "../mods/btw/turns.ts"
import { HARD_CONFIG, spawn } from "./effect-debt.ts"

const REAL = process.cwd()
const CLI_TIMEOUT = 120_000
const TEST_TIMEOUT = 240_000

/** A seeded generator, so a failing case names its seed and replays. */
const generator = (seed: number) => {
  const state = { value: seed >>> 0 }
  const next = () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0
    const mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    const spread = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((spread ^ (spread >>> 14)) >>> 0) / 4294967296
  }
  const int = (below: number) => Math.floor(next() * below)
  const pick = <A>(values: ReadonlyArray<A>) => values[int(values.length)] ?? values[0]!
  return { int, pick }
}

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "effect-small-rules-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const put = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

const HardConfig = Schema.fromJsonString(
  Schema.Struct({
    settings: Schema.Struct({ effect: Schema.Struct({ testFiles: Schema.Array(Schema.String) }) }),
    overrides: Schema.Array(Schema.Struct({ files: Schema.Array(Schema.String) })),
  }),
)

/** The real hard config, its plugins reached at their real paths from a scratch workspace. */
const hardConfigText = () => readFileSync(path.join(REAL, HARD_CONFIG), "utf8").replaceAll('"./lint/', `"${path.join(REAL, "lint")}/`)

/** A concrete path a glob matches. */
const concrete = (glob: string) => glob.replaceAll("**/", "deep/er/").replaceAll("**", "deep/er/demo.ts").replaceAll("*", "demo")

/** Every class of path the config can treat apart: each area, test and spec modules, each test glob and each override's files. */
const pathClasses = () => {
  const config = Schema.decodeUnknownSync(HardConfig)(readFileSync(path.join(REAL, HARD_CONFIG), "utf8"))
  return Arr.dedupe([
    "decider/demo.ts",
    "mods/demo/model.ts",
    "mods/demo/memory/store.ts",
    "cmd/demo/server.ts",
    "cmd/demo/tui.tsx",
    "scripts/demo.ts",
    "root.ts",
    "mods/demo/model.test.ts",
    "cmd/demo/tui.test.tsx",
    "scripts/demo.spec.ts",
    "decider/demo.test.ts",
    ...Arr.map(config.settings.effect.testFiles, concrete),
    ...Arr.flatMap(config.overrides, (override) => Arr.map(override.files, concrete)),
  ])
}

const RULES = ["requireNamedEffectFn", "preferEffectFn", "preferPredicateIsTagged", "noReduceAccumulatorCopy"] as const
type Rule = (typeof RULES)[number]

/** The names an operation reaches Effect by: the export, a renamed export and the module namespace. */
const IMPORTS = ['import { Effect, Predicate } from "effect"', 'import { Effect as E } from "effect"', 'import * as Eff from "effect/Effect"']
const NAMESPACES = ["Effect", "E", "Eff"]

/** One line of code: `$` is a fresh name, `NS` the Effect namespace it is written with. */
interface Case {
  readonly rule: Rule | "none"
  readonly code: string
}

const refused = (rule: Rule, code: string): Case => ({ rule, code })
const accepted = (code: string): Case => ({ rule: "none", code })

/** Each forbidden form of the rules that read the Effect namespace. */
const NAMESPACED_FORBIDDEN = [
  refused("requireNamedEffectFn", "const $ = NS.fn(function* () {})"),
  refused("requireNamedEffectFn", "const $ = NS.fn(function* (n: number) { return n })"),
  refused("requireNamedEffectFn", "const $ = NS.fn(() => NS.void)"),
  refused("requireNamedEffectFn", "const $ = NS.fn(function () { return NS.void })"),
  refused("requireNamedEffectFn", "const $ = NS.fn(function* () {}, NS.orDie)"),
  refused("preferEffectFn", "const $ = (n: number) => NS.gen(function* () { return n }).pipe(NS.withSpan(\"Demo.op\"))"),
  refused("preferEffectFn", "function $() { return NS.gen(function* () {}).pipe(NS.withSpan(\"Demo.op\")) }"),
  refused("preferEffectFn", "const $ = () => NS.gen(function* () { return 1 }).pipe(NS.map((n) => n), NS.withSpan(\"Demo.op\"))"),
  refused("preferEffectFn", "const $ = () => (NS.gen(function* () {}).pipe(NS.withSpan(\"Demo.op\", { attributes: { peer: 1 } })))"),
  refused("preferEffectFn", "const $ = () => NS.gen(function* () {}).withSpan(\"Demo.op\")"),
]

/** Each accepted form of the rules that read the Effect namespace: named and untraced operations, an unspanned or a value generator, a shadowed namespace and nonmatching local functions. */
const NAMESPACED_ACCEPTED = [
  accepted('const $ = NS.fn("Demo.op")(function* () {})'),
  accepted('const $ = NS.fn("Demo.op")(function* (n: number) { return n }, NS.orDie)'),
  accepted("const $ = NS.fnUntraced(function* () {})"),
  accepted("const $ = (n: number) => NS.gen(function* () { return n })"),
  accepted('const $ = NS.gen(function* () {}).pipe(NS.withSpan("Demo.op"))'),
  accepted('{ const NS = { fn: (f: unknown) => f, gen: (f: unknown) => ({ pipe: (g: unknown) => [f, g] }), withSpan: (s: string) => s }; const $ = NS.fn(function* () {}); const $ = () => NS.gen(function* () {}).pipe(NS.withSpan("Demo.op")) }'),
  accepted("{ const fn = (f: unknown) => f; const $ = fn(function* () {}) }"),
  accepted("{ const local = { fn: (f: unknown) => f }; const $ = local.fn(function* () {}) }"),
]

/** Each forbidden form of the rules that read no namespace. */
const PLAIN_FORBIDDEN = [
  refused("preferPredicateIsTagged", 'const $ = tagged._tag === "A" || tagged._tag === "B"'),
  refused("preferPredicateIsTagged", 'const $ = "A" === tagged._tag || tagged._tag === "B"'),
  refused("preferPredicateIsTagged", 'const $ = tagged._tag === "A" || tagged._tag === "B" || tagged._tag === "C"'),
  refused("preferPredicateIsTagged", 'const $ = tagged.inner._tag === "A" || tagged.inner._tag === "B"'),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>, item) => acc.concat([item]), [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>, item) => [...acc.slice(0, 1), item], [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>) => acc.toSorted(), [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>) => acc.toReversed(), [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>, item) => acc.with(0, item), [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>, item) => acc.toSpliced(0, 0, item), [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduceRight((acc: Array<string>, item) => acc.concat([item]), [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Record<string, string>, item) => Object.assign({}, acc, { [item]: item }), {})"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>) => Array.from(acc), [])"),
  refused("noReduceAccumulatorCopy", "const $ = items.reduce((acc: Array<string>, item) => { const before = acc; return before.concat([item]) }, [])"),
]

/** Each accepted form of the rules that read no namespace: other subjects and operators, the named refinement, a catchIf predicate, a fresh local accumulator and shadowed copiers. */
const PLAIN_ACCEPTED = [
  accepted('const $ = tagged._tag === "A" || other._tag === "B"'),
  accepted('const $ = tagged._tag === "A"'),
  accepted('const $ = tagged._tag === "A" && tagged.kind === "B"'),
  accepted('const $ = tagged._tag !== "A" || tagged._tag !== "B"'),
  accepted('const $ = Predicate.isTagged(tagged, "A") || Predicate.isTagged(tagged, "B")'),
  accepted('const $ = Effect.catchIf(Effect.fail(tagged), (error) => error._tag === "A" || error._tag === "B", () => Effect.void)'),
  accepted("const $ = items.reduce((acc: Array<string>, item) => { acc.push(item); return acc }, [])"),
  accepted("const $ = items.reduce((total, item) => total + item.length, 0)"),
  accepted("const $ = items.reduce((acc: Array<string>, item) => others.concat([item]), [])"),
  accepted("{ const Object = { assign: (...all: Array<unknown>) => all }; const $ = items.reduce((acc: Record<string, string>, item) => Object.assign({}, acc, { [item]: item }), {}) }"),
  accepted("{ const Array = { from: (all: unknown) => all }; const $ = items.reduce((acc: Array<string>) => Array.from(acc), []) }"),
]

const PRELUDE = ['const tagged = { _tag: "A", kind: "B", inner: { _tag: "A" } }', 'const other = { _tag: "B" }', 'const items = ["a", "b"]', "const others: Array<string> = []"]

const POSITIONS = ["module", "block", "function", "callback"] as const
type Position = (typeof POSITIONS)[number]

/** The lines that open and close a block at `position`, the `index`th of its file. */
const wrap = (position: Position, index: number): readonly [open: string, close: string] =>
  (({
    module: ["", ""],
    block: ["{", "}"],
    function: [`export function scope${index}() {`, "}"],
    callback: [`export const run${index} = [0].map(() => {`, "})"],
  }) as const)[position]

/** Each case at the line it was written on, in one file. */
interface Placed {
  readonly rule: Rule | "none"
  readonly code: string
  readonly line: number
  readonly position: Position
}

/** A fixture file: its imports, the prelude, then each case at a generated position, every name fresh. */
const fixtureFile = (random: ReturnType<typeof generator>, imports: ReadonlyArray<string>, cases: ReadonlyArray<Case>) => {
  const lines = [...imports, ...PRELUDE]
  const counter = { value: 0 }
  const fresh = () => {
    counter.value += 1
    return `name${counter.value}`
  }
  const placed = Arr.map(cases, (each, index): Placed => {
    const position = random.pick(POSITIONS)
    const [open, close] = wrap(position, index)
    lines.push(open)
    lines.push(each.code.replaceAll("$", () => fresh()))
    const line = lines.length
    lines.push(close)
    return { rule: each.rule, code: each.code, line, position }
  })
  return { text: `${lines.join("\n")}\n`, placed }
}

/** Every case, the namespaced ones once under each Effect name. */
const allCases = () => [
  ...Arr.flatMap(NAMESPACES, (namespace) => Arr.map([...NAMESPACED_FORBIDDEN, ...NAMESPACED_ACCEPTED], (each) => ({ ...each, code: each.code.replaceAll("NS", namespace) }))),
  ...PLAIN_FORBIDDEN,
  ...PLAIN_ACCEPTED,
]

const OxlintReport = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.optionalKey(Schema.String),
        filename: Schema.String,
        severity: Schema.String,
        labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Number }) })),
      }),
    ),
  }),
)

const CODES = new Map<string, Rule>(Arr.map(RULES, (rule) => [`effect(${rule})`, rule] as const))

/** Lints `files` in `root` with the real hard config: per file, per line, the four rules' errors. */
const lint = Effect.fn("EffectSmallRulesTest.lint")(function* (root: string, files: ReadonlyArray<string>) {
  const linted = yield* spawn([path.join(REAL, "node_modules/.bin/oxlint"), "--threads=3", "--format=json", "-c", HARD_CONFIG, ...files], root, CLI_TIMEOUT)
  expect({ stderr: linted.stderr }).toEqual({ stderr: "" })
  const found = Arr.flatMap(Schema.decodeUnknownSync(OxlintReport)(linted.stdout).diagnostics, (each) =>
    Option.toArray(
      Option.map(
        Option.flatMap(Option.fromUndefinedOr(each.code), (code) => Option.fromUndefinedOr(CODES.get(code))),
        (rule) => ({ file: each.filename, line: Option.getOrElse(Option.map(Arr.head(each.labels), (label) => label.span.line), () => 0), rule, severity: each.severity }),
      ),
    ),
  )
  return (file: string, line: number) => Arr.filter(found, (each) => each.file === file && each.line === line)
})

const differs = (outcome: { readonly want: ReadonlyArray<string>; readonly got: ReadonlyArray<string> }) => outcome.got.join() !== outcome.want.join()

const lintSeed = Effect.fn("EffectSmallRulesTest.lintSeed")(function* (seed: number) {
  const root = yield* scratch
  put(root, HARD_CONFIG, hardConfigText())
  const random = generator(seed)
  const cases = allCases()
  const fixtures = Arr.map(pathClasses(), (file) => ({ file, ...fixtureFile(random, IMPORTS, cases) }))
  const bare = { file: "mods/demo/bare.ts", ...fixtureFile(random, [], PLAIN_FORBIDDEN) }
  for (const fixture of [...fixtures, bare]) put(root, fixture.file, fixture.text)
  const errors = yield* lint(root, Arr.map([...fixtures, bare], ({ file }) => file))
  const outcomes = Arr.flatMap(fixtures, ({ file, placed }) =>
    Arr.map(placed, (each) => ({
      file,
      code: each.code,
      position: each.position,
      want: Arr.map(
        Arr.filter([each.rule], (rule) => rule !== "none"),
        (rule) => `${rule}:error`,
      ),
      got: Arr.map(errors(file, each.line), (error) => `${error.rule}:${error.severity}`),
    })),
  )
  const bareOutcomes = Arr.map(bare.placed, (each) => ({
    code: each.code,
    want: Arr.filter([each.rule], (rule) => rule === "noReduceAccumulatorCopy"),
    got: Arr.map(errors(bare.file, each.line), (error) => error.rule),
  }))
  return {
    wrong: Arr.filter(outcomes, differs),
    bareWrong: Arr.filter(bareOutcomes, differs),
    refusals: Arr.filter(outcomes, (outcome) => outcome.want.length > 0).length,
    files: fixtures.length,
    positions: new Set(Arr.flatMap(fixtures, ({ placed }) => Arr.map(placed, (each) => each.position))),
  }
})

describe(`${HARD_CONFIG}: the four small rules over generated fixtures`, () => {
  test.concurrent(
    "refuses each forbidden form as an error of its own rule under each Effect name, in every path class and position; accepts named, untraced, unspanned, shadowed and nonmatching forms",
    () =>
      runScoped(
        Effect.gen(function* () {
          const found = yield* lintSeed(20261112)
          expect({ wrong: found.wrong, bareWrong: found.bareWrong }).toEqual({ wrong: [], bareWrong: [] })
          expect(found.files).toBeGreaterThan(40)
          expect(found.refusals).toBe(found.files * (NAMESPACES.length * NAMESPACED_FORBIDDEN.length + PLAIN_FORBIDDEN.length))
          expect(found.positions).toEqual(new Set(POSITIONS))
        }),
      ),
    TEST_TIMEOUT,
  )
})

/** What the model of a turn makes of one message: a question opens a turn, a readable step adds to the open one, anything else is passed over. */
type Action =
  | { readonly kind: "open"; readonly question: string }
  | { readonly kind: "step"; readonly id: string; readonly text: string; readonly error: ReadonlyArray<string> }
  | { readonly kind: "pass" }

/** One generated message: the JSON the host stores, and what the model makes of it. */
interface Message {
  readonly json: string
  readonly action: Action
}

const SINCE = 1_000
const PASS: Action = { kind: "pass" }

/** Parts of a step that are not its text: other kinds, and text parts the host's shape refuses. */
const NON_TEXT_PARTS = ['{"type":"reasoning","text":"thinking"}', '{"type":"tool","name":"read"}', '{"type":"text"}', '{"type":"text","text":3}', "null"]

/** Errors the host's shape refuses: the whole step is unreadable. */
const MALFORMED_ERRORS = ['"overloaded"', "{}", '{"message":5}', "null"]

/** Messages the fold cannot read, each made after the fork: never a turn. */
const unreadable = (created: number) => [
  "null",
  "7",
  '"user"',
  "{}",
  `{"type":"user","time":{"created":${created}}}`,
  `{"type":"user","text":4,"time":{"created":${created}}}`,
  `{"type":"synthetic","text":"the note","time":{"created":${created}}}`,
  `{"type":"assistant","time":{"created":${created}}}`,
  `{"type":"assistant","id":"msg_x","content":"text","time":{"created":${created}}}`,
  '{"type":"user","text":"no time"}',
  '{"type":"user","text":"bad time","time":{"created":"late"}}',
]

/** A step's part: its JSON and the text it adds. */
const partOf = (random: ReturnType<typeof generator>, at: number) =>
  random.pick([
    { json: `{"type":"text","id":"p","text":"text ${at}"}`, text: `text ${at}` },
    { json: '{"type":"text","id":"p","text":""}', text: "" },
    { json: random.pick(NON_TEXT_PARTS), text: "" },
  ])

/** A step's error: its JSON fields, the turn's error, and whether the host can read it. */
const faultOf = (random: ReturnType<typeof generator>, at: number) =>
  random.pick([
    { json: "", error: [], readable: true },
    { json: "", error: [], readable: true },
    { json: `,"error":{"type":"provider","message":"failed ${at}"}`, error: [`failed ${at}`], readable: true },
    { json: `,"error":${random.pick(MALFORMED_ERRORS)}`, error: [], readable: false },
  ])

/** One generated message at index `at`, made before, at or after the fork. */
const messageOf = (random: ReturnType<typeof generator>, at: number): Message => {
  const kind = random.pick(["user", "user", "step", "step", "step", "unreadable"] as const)
  const created = random.pick([SINCE - 1 - random.int(50), SINCE, SINCE + 1 + random.int(50)])
  const own = created >= SINCE
  if (kind === "unreadable") return { json: random.pick(unreadable(created)), action: PASS }
  if (kind === "user") {
    const json = `{"type":"user","id":"msg_q${at}","text":"question ${at}","time":{"created":${created}}}`
    if (!own) return { json, action: PASS }
    return { json, action: { kind: "open", question: `question ${at}` } }
  }
  const parts = Arr.map(Arr.range(1, random.int(4)), () => partOf(random, at))
  const fault = faultOf(random, at)
  const json = `{"type":"assistant","id":"msg_${at}","content":[${Arr.map(parts, (part) => part.json).join(",")}]${fault.json},"time":{"created":${created},"completed":${created + 1}}}`
  if (!own || !fault.readable) return { json, action: PASS }
  return { json, action: { kind: "step", id: `msg_${at}`, text: Arr.map(parts, (part) => part.text).join(""), error: fault.error } }
}

/** A turn with its optional fields as Options, and the keys it carries. */
interface Seen {
  readonly question: string
  readonly answer: string
  readonly replyID: Option.Option<string>
  readonly error: Option.Option<string>
  readonly keys: ReadonlyArray<string>
}

const seen = (turn: Turn): Seen => ({
  question: turn.question,
  answer: turn.answer,
  replyID: Option.fromUndefinedOr(turn.replyID),
  error: Option.fromUndefinedOr(turn.error),
  keys: Object.keys(turn).toSorted(),
})

/** The model of a fork's turns, folded on the actions alone: each question opens a turn, each step joins its text to the open turn's and names it. */
const modelTurns = (actions: ReadonlyArray<Action>): ReadonlyArray<Seen> => {
  const turns: Array<Seen> = []
  for (const action of actions) {
    if (action.kind === "open") turns.push({ question: action.question, answer: "", replyID: Option.none(), error: Option.none(), keys: ["answer", "question"] })
    if (action.kind === "step" && turns.length > 0) {
      const open = turns[turns.length - 1]!
      turns[turns.length - 1] = {
        question: open.question,
        answer: Arr.filter([open.answer, action.text], (text) => text !== "").join("\n\n"),
        replyID: Option.some(action.id),
        error: Arr.head(action.error),
        keys: ["answer", ...Arr.map(action.error, () => "error"), "question", "replyID"],
      }
    }
  }
  return turns
}

const Messages = Schema.fromJsonString(Schema.Array(Schema.Json))

/** A generated fork history of up to 24 messages. */
const historyOf = (seed: number) => {
  const random = generator(seed)
  return Arr.map(Arr.range(0, random.int(24)), (at) => messageOf(random, at))
}

describe("forkTurns over generated fork histories", () => {
  test("folds each history as the model of a turn does, alike on every call, leaving the messages as they were", () => {
    const failures = Arr.flatMap(Arr.range(1, 400), (seed) => {
      const history = historyOf(seed)
      const text = `[${Arr.map(history, (message) => message.json).join(",")}]`
      const messages = Object.freeze(Schema.decodeUnknownSync(Messages)(text))
      const first = forkTurns(messages, SINCE)
      const kept = Arr.map(first, seen)
      const second = forkTurns(messages, SINCE)
      const want = modelTurns(Arr.map(history, (message) => message.action))
      const outcome = {
        first: Arr.map(first, seen),
        second: Arr.map(second, seen),
        kept: Bun.deepEquals(Arr.map(first, seen), kept, true),
        fresh: first !== second,
        unchanged: Bun.deepEquals(messages, Schema.decodeUnknownSync(Messages)(text), true),
      }
      return Arr.filter([{ seed, text, outcome }], () => !Bun.deepEquals(outcome, { first: want, second: want, kept: true, fresh: true, unchanged: true }, true))
    })
    expect(failures).toEqual([])
  })

  test("worked examples: a later step without an error clears the earlier one, and only the last turn grows", () => {
    const messages = Schema.decodeUnknownSync(Messages)(
      `[${[
        `{"type":"user","text":"one?","time":{"created":${SINCE}}}`,
        `{"type":"assistant","id":"msg_1","content":[{"type":"text","text":"first"}],"error":{"message":"rate limited"},"time":{"created":${SINCE + 1}}}`,
        `{"type":"assistant","id":"msg_2","content":[],"time":{"created":${SINCE + 2}}}`,
        `{"type":"user","text":"two?","time":{"created":${SINCE + 3}}}`,
        `{"type":"assistant","id":"msg_3","content":[{"type":"text","text":"second"}],"error":{"message":"cut off"},"time":{"created":${SINCE + 4}}}`,
      ].join(",")}]`,
    )
    expect(forkTurns(messages, SINCE)).toEqual([
      { question: "one?", answer: "first", replyID: "msg_2" },
      { question: "two?", answer: "second", replyID: "msg_3", error: "cut off" },
    ])
    expect(forkTurns(messages.slice(0, 2), SINCE)).toEqual([{ question: "one?", answer: "first", replyID: "msg_1", error: "rate limited" }])
    expect(forkTurns([], SINCE)).toEqual([])
  })
})
