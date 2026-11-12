/**
 * The wake process tests' wait and lifecycle policy at the real lint CLI. `.oxlintrc.json` keeps
 * `noFixedWaitInTests`, `noNewPromise`, `noPromiseChainsInTests` and `noTestLifecycleHooks` as
 * errors in exactly `mods/wake/process/runner.test.ts`, `checks.test.ts`, the test-only helper
 * `readiness.ts` and its `readiness.test.ts`. Generated forms at generated positions in those four
 * files are refused as errors of their exact rules: Bun.sleep and Bun.sleepSync, Effect.sleep
 * through an aliased named or namespace import, setTimeout from timers/promises under an alias,
 * a timer-only Promise, Promise construction and statics direct, through globalThis, a held alias
 * and a destructured static, then/catch/finally chains, and each lifecycle hook. Effect's own
 * catch, a Schedule-driven repeat, a Promise imported from a local module and a local object's own
 * sleep are accepted. Every other path lints these forms exactly as the config without that
 * override does, so the override switches nothing on elsewhere and nothing off anywhere. The real
 * four files carry none of the four rules' findings, and the helper is classified as test code in
 * both configs and the debt policy.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Array as Arr, Effect, Option, Order, Schema, type Scope } from "effect"
import { type CallExpression, parseSync, Visitor } from "oxc-parser"
import { DEBT_CONFIG, HARD_CONFIG, POLICY, Policy, ruleOf, spawn } from "./effect-debt.ts"

const REAL = process.cwd()
const CLI_TIMEOUT = 120_000
const TEST_TIMEOUT = 240_000

const OWNED = ["mods/wake/process/runner.test.ts", "mods/wake/process/checks.test.ts", "mods/wake/process/readiness.ts", "mods/wake/process/readiness.test.ts"]
const HELPER = "mods/wake/process/readiness.ts"
const RULES = ["noFixedWaitInTests", "noNewPromise", "noPromiseChainsInTests", "noTestLifecycleHooks"] as const
type Rule = (typeof RULES)[number]
const RULE_IDS = Arr.map(RULES, (rule) => `effect/${rule}`)

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
type Random = ReturnType<typeof generator>

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "effect-process-policy-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const put = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

const Override = Schema.Struct({
  files: Schema.Array(Schema.String),
  excludeFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  rules: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})
type Override = typeof Override.Type
const Settings = Schema.Struct({ effect: Schema.Struct({ testFiles: Schema.Array(Schema.String) }) })
const HardConfig = Schema.fromJsonString(Schema.Struct({ overrides: Schema.Array(Override), settings: Settings }))
const DebtConfig = Schema.fromJsonString(Schema.Struct({ settings: Settings }))

const hardText = () => readFileSync(path.join(REAL, HARD_CONFIG), "utf8")
const hard = () => Schema.decodeUnknownSync(HardConfig)(hardText())

const touchesRules = (override: Override) => Arr.some(Object.keys(override.rules ?? {}), (rule) => RULE_IDS.includes(rule))
const ownsFiles = (override: Override) => Arr.some(override.files, (file) => OWNED.includes(file))

/** The hard config without the override that names the four files: what every other path must lint as. */
const baselineText = () => {
  const codec = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
  const config = Schema.decodeUnknownSync(codec)(hardText())
  const kept = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(Arr.filter(hard().overrides, (override) => !(ownsFiles(override) && touchesRules(override))))
  return Schema.encodeSync(codec)({ ...config, overrides: kept })
}

/** A config's text with its plugins reached at their real paths from a scratch workspace. */
const rooted = (text: string) => text.replaceAll('"./lint/', `"${path.join(REAL, "lint")}/`)

/** One generated form: the imports it needs, its statement (`$` a fresh name), and the rules it must be refused as. */
interface Case {
  readonly imports: ReadonlyArray<string>
  readonly code: string
  readonly want: ReadonlyArray<Rule>
}

const refused = (code: string, ...want: ReadonlyArray<Rule>): Case => ({ imports: [], code, want })
const refusedWith = (imports: ReadonlyArray<string>, code: string, ...want: ReadonlyArray<Rule>): Case => ({ imports, code, want })
const accepted = (imports: ReadonlyArray<string>, code: string): Case => ({ imports, code, want: [] })

const FORBIDDEN: ReadonlyArray<Case> = [
  refused("const $ = async () => { await Bun.sleep(5) }", "noFixedWaitInTests"),
  refused("const $ = () => { Bun.sleepSync(5) }", "noFixedWaitInTests"),
  refused("const $ = Bun.sleep(5)", "noFixedWaitInTests"),
  refusedWith(['import { Effect as $Fx } from "effect"'], "const $ = $Fx.gen(function* () { yield* $Fx.sleep(5) })", "noFixedWaitInTests"),
  refusedWith(['import * as $Fx from "effect/Effect"'], "const $ = $Fx.gen(function* () { yield* $Fx.sleep(5) })", "noFixedWaitInTests"),
  refusedWith(['import { Effect as $Fx } from "effect"'], "const $ = $Fx.sleep(5)", "noFixedWaitInTests"),
  refusedWith(['import { setTimeout as $nap } from "node:timers/promises"'], "const $ = async () => { await $nap(5) }", "noFixedWaitInTests"),
  refused("const $ = async () => { await new Promise((done) => setTimeout(done, 5)) }", "noFixedWaitInTests", "noNewPromise"),
  refused("const $ = new Promise<number>((done) => done(1))", "noNewPromise"),
  refused("const $ = new globalThis.Promise<number>((done) => done(1))", "noNewPromise"),
  refused("const $ = Promise.all([1])", "noNewPromise"),
  refused("const $ = Promise.resolve(1)", "noNewPromise"),
  refused("const $ = globalThis.Promise.race([1])", "noNewPromise"),
  refused("const $ = Promise.withResolvers<number>()", "noNewPromise"),
  refused("{ const $Held = Promise; const $ = $Held.allSettled([1]) }", "noNewPromise"),
  refused("{ const { any: $any } = Promise; const $ = $any([1]) }", "noNewPromise"),
  refused("const $ = (p: PromiseLike<number>) => p.then((n) => n + 1)", "noPromiseChainsInTests"),
  refused("const $ = (p: Promise<number>) => p.catch(() => 0)", "noPromiseChainsInTests"),
  refused("const $ = (p: Promise<number>) => p.finally(() => 0)", "noPromiseChainsInTests"),
  refusedWith(['import { afterAll } from "bun:test"'], "afterAll(() => {})", "noTestLifecycleHooks"),
  refusedWith(['import { afterEach } from "bun:test"'], "afterEach(() => {})", "noTestLifecycleHooks"),
  refusedWith(['import { beforeAll } from "bun:test"'], "beforeAll(() => {})", "noTestLifecycleHooks"),
  refusedWith(['import { beforeEach } from "bun:test"'], "beforeEach(() => {})", "noTestLifecycleHooks"),
]

const ACCEPTED: ReadonlyArray<Case> = [
  accepted(['import { Effect as $Fx } from "effect"'], "const $ = $Fx.void.pipe($Fx.catch(() => $Fx.void))"),
  accepted(['import { Effect as $Fx, Schedule as $Sc } from "effect"'], "const $ = $Fx.void.pipe($Fx.repeat({ schedule: $Sc.spaced(5), times: 3 }))"),
  accepted(['import { Promise as $Local } from "./local-promise.ts"'], "const $ = $Local.all([1])"),
  accepted(['import { clock as $clock } from "./local-clock.ts"'], "const $ = async () => { await $clock.sleep(5) }"),
  accepted([], "const $ = { then: 1, catch: 2, finally: 3, sleep: 4 }"),
  accepted([], "{ const Promise = { all: (n: ReadonlyArray<number>) => n }; const $ = Promise.all([1]) }"),
]

const CASES = [...FORBIDDEN, ...ACCEPTED]

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

/** Each case at the line it was written on. */
interface Placed {
  readonly code: string
  readonly line: number
  readonly position: Position
  readonly want: ReadonlyArray<string>
}

/** A fixture file: every case's imports first, then each case at a generated position, every name fresh. */
const fixtureFile = (random: Random, cases: ReadonlyArray<Case>) => {
  const named = Arr.map(cases, (each, index) => ({ ...each, fresh: (text: string) => text.replaceAll("$", `n${index}_`) }))
  const lines = Arr.flatMap(named, (each) => Arr.map(each.imports, each.fresh))
  const placed = Arr.map(named, (each, index): Placed => {
    const position = random.pick(POSITIONS)
    const [open, close] = wrap(position, index)
    lines.push(open)
    lines.push(each.fresh(each.code))
    const line = lines.length
    lines.push(close)
    return { code: each.code, line, position, want: Arr.sort(Arr.map(each.want, (rule) => `${rule}:error`), Order.String) }
  })
  return { text: `${lines.join("\n")}\n`, placed }
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz"
const nameOf = (random: Random) => `${random.pick([...LETTERS])}${Arr.map(Arr.range(1, 1 + random.int(8)), () => random.pick([...LETTERS])).join("")}`

/** Paths next to the four files and elsewhere: siblings in the folder, other wake tests, other mods' tests, the domain, scripts. */
const otherPaths = (random: Random) =>
  Arr.dedupe([
    `mods/wake/process/${nameOf(random)}.test.ts`,
    `mods/wake/process/${nameOf(random)}.ts`,
    "mods/wake/process/supervise.test.ts",
    "mods/wake/process/readiness.spec.ts",
    `mods/wake/${nameOf(random)}.test.ts`,
    `mods/wake/${nameOf(random)}.ts`,
    `mods/${nameOf(random)}/process/runner.test.ts`,
    `mods/${nameOf(random)}/${nameOf(random)}.test.ts`,
    `cmd/wake/${nameOf(random)}.test.ts`,
    `scripts/${nameOf(random)}.test.ts`,
  ])

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

/** Lints `files` in `root` with `config`: every diagnostic, with its rule id, line and severity. */
const lint = Effect.fn("EffectProcessPolicyTest.lint")(function* (root: string, config: string, files: ReadonlyArray<string>) {
  const linted = yield* spawn([path.join(REAL, "node_modules/.bin/oxlint"), "--threads=3", "--format=json", "-c", config, ...files], root, CLI_TIMEOUT)
  expect({ stderr: linted.stderr }).toEqual({ stderr: "" })
  return Arr.map(Schema.decodeUnknownSync(OxlintReport)(linted.stdout).diagnostics, (each) => ({
    file: each.filename,
    line: Option.getOrElse(Option.map(Arr.head(each.labels), (label) => label.span.line), () => 0),
    rule: ruleOf(each.code ?? ""),
    severity: each.severity,
  }))
})
type Found = Effect.Success<ReturnType<typeof lint>>

/** The four rules' diagnostics on one line, as sorted `rule:severity`. */
const fourAt = (found: Found, file: string, line: number) =>
  Arr.sort(
    Arr.map(
      Arr.filter(found, (each) => each.file === file && each.line === line && RULE_IDS.includes(each.rule)),
      (each) => `${each.rule.slice("effect/".length)}:${each.severity}`,
    ),
    Order.String,
  )

const BASELINE = ".oxlintrc.baseline.json"

const lintSeed = Effect.fn("EffectProcessPolicyTest.lintSeed")(function* (seed: number) {
  const root = yield* scratch
  put(root, HARD_CONFIG, rooted(hardText()))
  put(root, BASELINE, rooted(baselineText()))
  const random = generator(seed)
  const others = Arr.filter(otherPaths(random), (file) => !OWNED.includes(file))
  const fixtures = Arr.map([...OWNED, ...others], (file) => ({ file, ...fixtureFile(random, CASES) }))
  for (const fixture of fixtures) put(root, fixture.file, fixture.text)
  const files = Arr.map(fixtures, ({ file }) => file)
  const real = yield* lint(root, HARD_CONFIG, files)
  const baseline = yield* lint(root, BASELINE, files)
  const outcomes = Arr.flatMap(fixtures, ({ file, placed }) =>
    Arr.map(placed, (each) => ({
      file,
      code: each.code,
      position: each.position,
      want: Option.getOrElse(Option.liftPredicate(each.want, () => OWNED.includes(file)), () => fourAt(baseline, file, each.line)),
      got: fourAt(real, file, each.line),
    })),
  )
  return {
    wrong: Arr.filter(outcomes, (outcome) => outcome.got.join() !== outcome.want.join()),
    refusals: Arr.filter(outcomes, (outcome) => OWNED.includes(outcome.file) && outcome.want.length > 0).length,
    others: others.length,
    positions: new Set(Arr.flatMap(fixtures, ({ placed }) => Arr.map(placed, (each) => each.position))),
  }
})

describe(`${HARD_CONFIG}: the wake process tests' wait and lifecycle rules over generated forms`, () => {
  test.concurrent(
    "refuses each forbidden form as errors of its exact rules in the four files at every position, accepts the allowed forms there, and leaves every other path as the config without the override leaves it",
    () =>
      runScoped(
        Effect.gen(function* () {
          const found = yield* lintSeed(20261112)
          expect(found.wrong).toEqual([])
          expect(found.others).toBeGreaterThan(6)
          expect(found.positions).toEqual(new Set(POSITIONS))
          expect(found.refusals).toBe(OWNED.length * FORBIDDEN.length)
        }),
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "a second seed: other positions and other generated neighbours",
    () =>
      runScoped(
        Effect.gen(function* () {
          const found = yield* lintSeed(7)
          expect(found.wrong).toEqual([])
        }),
      ),
    TEST_TIMEOUT,
  )

  test("the override names exactly the four files and raises exactly the four rules to errors; no override switches one of them down for these files", () => {
    const all = hard().overrides
    const owning = Arr.filter(all, (override) => ownsFiles(override) && touchesRules(override))
    expect(Arr.map(owning, (override) => ({ files: Arr.sort(override.files, Order.String), excludes: Object.hasOwn(override, "excludeFiles"), rules: override.rules }))).toEqual([
      { files: Arr.sort(OWNED, Order.String), excludes: false, rules: Object.fromEntries(Arr.map(RULE_IDS, (rule) => [rule, "error"])) },
    ])
    const switchedDown = Arr.flatMap(all, (override) =>
      Arr.map(
        Arr.filter(Object.entries(override.rules ?? {}), ([rule, setting]) => RULE_IDS.includes(rule) && setting !== "error"),
        ([rule, setting]) => ({ files: override.files, rule, setting }),
      ),
    )
    expect(switchedDown).toEqual([])
  })

  test("the helper is test code in the hard config, the debt config and the debt policy", () => {
    const debt = Schema.decodeUnknownSync(DebtConfig)(readFileSync(path.join(REAL, DEBT_CONFIG), "utf8"))
    const policy = Schema.decodeUnknownSync(Schema.fromJsonString(Policy))(readFileSync(path.join(REAL, POLICY), "utf8"))
    expect([hard().settings.effect.testFiles, debt.settings.effect.testFiles, policy.testFiles].map((globs) => globs.includes(HELPER))).toEqual([true, true, true])
  })

  test.concurrent(
    "the real four files carry no finding of the four rules",
    () =>
      runScoped(
        Effect.gen(function* () {
          const found = yield* lint(REAL, HARD_CONFIG, OWNED)
          expect(Arr.filter(found, (each) => RULE_IDS.includes(each.rule))).toEqual([])
        }),
      ),
    TEST_TIMEOUT,
  )
})

/** The real-process test files: each Bun test that runs an Effect there must end it before Bun's limit. */
const PROCESS_TESTS = ["mods/wake/process/runner.test.ts", "mods/wake/process/checks.test.ts"]

/** One `test(...)` call of a file: its source, whether its callback runs an Effect, and whether it is bounded. */
interface TestCall {
  readonly file: string
  readonly source: string
  readonly runsEffect: boolean
  readonly bounded: boolean
}

/** Whether a call's callee is `test` or a member of it, such as `test.concurrent`. */
const callsTest = (call: CallExpression) =>
  (call.callee.type === "Identifier" && call.callee.name === "test") ||
  (call.callee.type === "MemberExpression" && call.callee.object.type === "Identifier" && call.callee.object.name === "test")

/** A test call is bounded when its callback is `() => Effect.runPromise(bounded(...))` and its third argument is `testLimitMs(...)`. */
const testCallsOf = (file: string): ReadonlyArray<TestCall> => {
  const text = readFileSync(path.join(REAL, file), "utf8")
  const slice = (node: { readonly start: number; readonly end: number }) => text.slice(node.start, node.end)
  const calls: Array<CallExpression> = []
  new Visitor({ CallExpression: (call) => Arr.forEach(Arr.filter([call], callsTest), (found) => calls.push(found)) }).visit(parseSync(file, text).program)
  return Arr.map(calls, (call) => {
    const argument = (index: number) => Option.getOrElse(Option.map(Arr.get(call.arguments, index), slice), () => "")
    const callback = argument(1)
    const limit = argument(2)
    return {
      file,
      source: slice(call).slice(0, 120),
      runsEffect: /\bEffect\b|\brun[A-Z]\w*\(/u.test(callback),
      bounded: /^\(\) => Effect\.runPromise\(bounded\(/u.test(callback) && /^testLimitMs\(/u.test(limit),
    }
  })
}

describe("the wake process tests end every Effect before Bun's test limit", () => {
  test("each Bun test that runs an Effect goes through the one bounded helper of its file, whose Bun limit is testLimitMs of its bounds; no other test runs an Effect", () => {
    const calls = Arr.flatMap(PROCESS_TESTS, testCallsOf)
    expect(Arr.filter(calls, (call) => call.runsEffect && !call.bounded)).toEqual([])
    expect(Arr.map(PROCESS_TESTS, (file) => Arr.filter(calls, (call) => call.file === file && call.bounded).length)).toEqual(Arr.map(PROCESS_TESTS, () => 1))
    const runs = Arr.map(PROCESS_TESTS, (file) => (readFileSync(path.join(REAL, file), "utf8").match(/\bEffect\.run(?:Promise|Fork|Callback)\w*\(/gu) ?? []).length)
    expect(runs).toEqual(Arr.map(PROCESS_TESTS, () => 1))
  })
})
