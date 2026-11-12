/**
 * The production domain's syntax policy at the real lint CLI. The production domain is every
 * `decider/*.ts` and `mods/<mod>/<file>.ts`, except `*.test.*`, `*.spec.*`, `*.bench.*` and
 * `mods/<mod>/laws.ts`. In it `.oxlintrc.json` refuses, as errors of their exact rules, async
 * functions and await, Promise construction and Promise statics (direct, through globalThis and
 * through an alias), throw, Node builtin imports, module-level let and var, and try statements;
 * it accepts if and switch, local functions, Effect.try and Effect.tryPromise objects, scoped
 * let and Effect callbacks. A generated mod or file name nobody wrote yet is protected the same
 * way. Every path outside the domain (tests, specs, benchmarks, laws, nested adapters, TSX, cmd,
 * scripts) lints exactly as the config without the domain overrides lints it, so no domain rule
 * leaks into the test and boundary policy. Each import fence still refuses an import it bans.
 *
 * Try statements keep a legacy inventory: the exact files `effect-debt.json` budgets for
 * `effect/noTryCatch` in the domain are the exact files the hard config leaves to the ratchet.
 * One more try in any of them passes the hard lint and fails the per-file debt comparison.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Array as Arr, Effect, Option, Order, Schema, type Scope } from "effect"
import { compare, DEBT_CONFIG, HARD_CONFIG, knownRules, POLICY, Policy, ruleOf, scan, spawn } from "./effect-debt.ts"

const REAL = process.cwd()
const CLI_TIMEOUT = 120_000
const TEST_TIMEOUT = 240_000

/**
 * The files whose try statements the domain kept when the rule became an error, each with its
 * count. The inventory only shrinks: a file leaves it once its tries are gone, and no file joins
 * it, even one whose budget would keep the total under nine.
 */
const LEGACY_TRIES: ReadonlyArray<{ readonly file: string; readonly count: number }> = [
  { file: "decider/tool-input.ts", count: 1 },
  { file: "mods/anthropic-auth/json.ts", count: 1 },
  { file: "mods/anthropic-auth/tool-alias.ts", count: 1 },
  { file: "mods/guard/kill.ts", count: 1 },
  { file: "mods/kernel/tools.ts", count: 1 },
  { file: "mods/kernel/wire.ts", count: 1 },
  { file: "mods/wake/wake.ts", count: 1 },
  { file: "mods/web/fetch.ts", count: 2 },
]

/** The legacy files a budget names past the pinned inventory: one not in it, or over its pinned count. */
const unpinned = (budgets: ReadonlyArray<{ readonly file: string; readonly count: number }>) =>
  Arr.filter(budgets, (entry) => !Arr.some(LEGACY_TRIES, (pinned) => pinned.file === entry.file && entry.count <= pinned.count))

/** The globs the domain override leaves to the test and boundary policy. */
const NOT_DOMAIN = ["**/*.test.*", "**/*.spec.*", "**/*.bench.*", "mods/*/laws.ts"]
const DOMAIN_FILES = ["decider/*.ts", "mods/*/*.ts"]

const RULES = ["noAsyncFunction", "noModuleLevelMutableState", "noNewPromise", "noNodeBuiltinImport", "noThrowStatement", "noTryCatch"] as const
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
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "effect-domain-policy-"))),
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
const HardConfig = Schema.fromJsonString(Schema.Struct({ overrides: Schema.Array(Override) }))

const hardText = () => readFileSync(path.join(REAL, HARD_CONFIG), "utf8")
const overrides = () => Schema.decodeUnknownSync(HardConfig)(hardText()).overrides

/** A config's text with its plugins reached at their real paths from a scratch workspace. */
const rooted = (text: string) => text.replaceAll('"./lint/', `"${path.join(REAL, "lint")}/`)

const touchesDomainRules = (override: Override) => Arr.some(Object.keys(override.rules ?? {}), (rule) => RULE_IDS.includes(rule))

/** The domain's own overrides: a domain rule set over a domain glob. Another unit may raise a domain rule for its exact files elsewhere. */
const isDomainOverride = (override: Override) => touchesDomainRules(override) && Arr.some(override.files, (file) => DOMAIN_FILES.includes(file))

/** The hard config without the overrides that set a domain rule: what every path outside the domain must lint as. */
const baselineText = () => {
  const codec = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
  const config = Schema.decodeUnknownSync(codec)(hardText())
  const kept = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(Arr.filter(overrides(), (override) => !touchesDomainRules(override)))
  return Schema.encodeSync(codec)({ ...config, overrides: kept })
}

/** The independent model of the domain: one root file of decider/ or of one mod, not a test, spec, benchmark or mod law file. */
const inDomain = (file: string) => {
  const parts = file.split("/")
  const base = parts[parts.length - 1] ?? ""
  const rootFile = (parts.length === 2 && parts[0] === "decider") || (parts.length === 3 && parts[0] === "mods")
  const testLike = /\.(?:test|spec|bench)\./u.test(base) || (parts[0] === "mods" && base === "laws.ts")
  return rootFile && base.endsWith(".ts") && !testLike
}

const PolicyJson = Schema.fromJsonString(Policy)
const policy = () => Schema.decodeUnknownSync(PolicyJson)(readFileSync(path.join(REAL, POLICY), "utf8"))

/** The domain files the ratchet budgets for try statements, with their counts. */
const legacyBudgets = () =>
  Arr.sort(
    Arr.flatMap(Object.entries(policy().budgets), ([file, rules]) =>
      Arr.flatMap(Option.toArray(Option.fromUndefinedOr(rules["effect/noTryCatch"])), (count) => Arr.filter([{ file, count }], () => inDomain(file))),
    ),
    Order.mapInput(Order.String, (entry: { readonly file: string }) => entry.file),
  )

const POSITIONS = ["module", "block", "function", "callback"] as const
type Position = (typeof POSITIONS)[number]

/** One line of code: `$` is a fresh name; `want` is what the domain refuses it as at each position. */
interface Case {
  readonly code: string
  readonly want: (position: Position) => ReadonlyArray<Rule>
  readonly positions: ReadonlyArray<Position>
}

const always =
  (...rules: ReadonlyArray<Rule>) =>
  () =>
    rules
const refused = (code: string, ...rules: ReadonlyArray<Rule>): Case => ({ code, want: always(...rules), positions: POSITIONS })
const accepted = (code: string): Case => ({ code, want: always(), positions: POSITIONS })
const imported = (code: string): Case => ({ code, want: always("noNodeBuiltinImport"), positions: ["module"] })
const binding = (code: string, refusedAt: ReadonlyArray<Position>): Case => ({
  code,
  want: (position) => Arr.filter(["noModuleLevelMutableState" as const], () => refusedAt.includes(position)),
  positions: POSITIONS,
})

const FORBIDDEN: ReadonlyArray<Case> = [
  refused("async function $() { return 1 }", "noAsyncFunction"),
  refused("const $ = async () => 1", "noAsyncFunction"),
  refused("const $ = async function () { return 1 }", "noAsyncFunction"),
  refused("const $ = { async run() { return 1 } }", "noAsyncFunction"),
  refused("class $ { async run() { return 1 } }", "noAsyncFunction"),
  refused("class $ { static async run() { return 1 } }", "noAsyncFunction"),
  refused("const $ = async () => { await 0 }", "noAsyncFunction", "noAsyncFunction"),
  refused("const $ = new Promise<void>((resolve) => resolve())", "noNewPromise"),
  refused("const $ = new globalThis.Promise<void>((resolve) => resolve())", "noNewPromise"),
  refused("{ const Held = Promise; const $ = new Held<void>((resolve) => resolve()) }", "noNewPromise"),
  refused("const $ = Promise.resolve(1)", "noNewPromise"),
  refused("const $ = Promise.all([1, 2])", "noNewPromise"),
  refused("function $() { throw new Error(\"demo\") }", "noThrowStatement"),
  refused("const $ = () => { throw \"demo\" }", "noThrowStatement"),
  refused("try { JSON.parse(\"1\") } catch (error) { JSON.stringify(error) }", "noTryCatch"),
  refused("try { JSON.parse(\"1\") } catch { JSON.parse(\"2\") }", "noTryCatch"),
  refused("try { JSON.parse(\"1\") } finally { JSON.parse(\"2\") }", "noTryCatch"),
  refused("try { JSON.parse(\"1\") } catch { JSON.parse(\"2\") } finally { JSON.parse(\"3\") }", "noTryCatch"),
  imported('import { readFileSync as $ } from "node:fs"'),
  imported('import * as $ from "node:path"'),
  imported('import $ from "fs"'),
  imported('import { env as $ } from "node:process"'),
  imported('import "node:child_process"'),
  binding("let $ = 0", ["module"]),
  binding("let $: number | string = 0", ["module"]),
  binding("var $ = 0", ["module", "block"]),
]

const ACCEPTED: ReadonlyArray<Case> = [
  accepted("if (JSON.parse(\"1\") === 1) { JSON.parse(\"2\") } else { JSON.parse(\"3\") }"),
  accepted("switch (JSON.parse(\"1\")) { case 1: break; default: break }"),
  accepted("function $() { return 1 }"),
  accepted("const $ = (n: number) => n + 1"),
  accepted("const $ = { run() { return 1 } }"),
  accepted("class $ { run() { return 1 } }"),
  accepted('const $ = Effect.try({ try: () => JSON.parse("1"), catch: () => "bad" })'),
  accepted('const $ = Effect.tryPromise({ try: () => fetch("http://localhost"), catch: () => "bad" })'),
  accepted("function $() { let n = 0; n += 1; return n }"),
  accepted("const $ = Effect.sync(() => { let n = 0; n += 1; return n })"),
  accepted("const $ = Effect.gen(function* () { yield* Effect.void })"),
  accepted("{ const Promise = { resolve: (n: number) => n }; const $ = Promise.resolve(1) }"),
  accepted("const $ = { try: 1, catch: 2, finally: 3, async: 4, await: 5, throw: 6 }"),
  accepted('import { Effect as $ } from "effect"'),
  binding("{ let $ = 0 }", []),
]

const CASES = [...FORBIDDEN, ...ACCEPTED]

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
  readonly want: ReadonlyArray<Rule>
}

/** A fixture file: the Effect import, then each case at a generated position, every name fresh. */
const fixtureFile = (random: Random, cases: ReadonlyArray<Case>) => {
  const lines = ['import { Effect } from "effect"']
  const counter = { value: 0 }
  const fresh = () => {
    counter.value += 1
    return `name${counter.value}`
  }
  const placed = Arr.map(cases, (each, index): Placed => {
    const position = random.pick(each.positions)
    const [open, close] = wrap(position, index)
    lines.push(open)
    lines.push(each.code.replaceAll("$", () => fresh()))
    const line = lines.length
    lines.push(close)
    return { code: each.code, line, position, want: Arr.sort(each.want(position), Order.String) }
  })
  return { text: `${lines.join("\n")}\n`, placed }
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz"
const TAIL = `${LETTERS}0123456789-`

/** A valid generated name: a letter, then letters, digits and hyphens. */
const nameOf = (random: Random) => `${random.pick([...LETTERS])}${Arr.map(Arr.range(1, random.int(9)), () => random.pick([...TAIL])).join("")}`

/** A file basename in the domain: a name, sometimes with dotted parts, never a test, spec or benchmark. */
const baseOf = (random: Random) =>
  random.pick([nameOf(random), `${nameOf(random)}.${nameOf(random)}`, random.pick(["model", "decision", "store", "laws-like", "testing", "spec-sheet"])])

/** The real mod names, so every existing mod is covered as well as the generated ones. */
const realMods = () => Arr.filter(readdirSync(path.join(REAL, "mods")), (name) => statSync(path.join(REAL, "mods", name)).isDirectory())

/** Domain paths: a root file of decider/, of every real mod and of generated mods nobody wrote. */
const domainPaths = (random: Random) =>
  Arr.dedupe([
    `decider/${baseOf(random)}.ts`,
    `decider/${baseOf(random)}.ts`,
    "decider/laws.ts",
    ...Arr.map(realMods(), (mod) => `mods/${mod}/${baseOf(random)}.ts`),
    ...Arr.map(Arr.range(1, 8), () => `mods/${nameOf(random)}-${nameOf(random)}/${baseOf(random)}.ts`),
  ])

/** Paths outside the domain: tests, specs, benchmarks, mod laws, nested adapters, TSX, cmd, scripts and the root. */
const outsidePaths = (random: Random) => {
  const mod = () => random.pick([...realMods(), nameOf(random)])
  return Arr.dedupe([
    `mods/${mod()}/${baseOf(random)}.test.ts`,
    `mods/${mod()}/${baseOf(random)}.spec.ts`,
    `mods/${mod()}/${baseOf(random)}.bench.ts`,
    `mods/${mod()}/${baseOf(random)}.test.tsx`,
    `mods/${mod()}/laws.ts`,
    `mods/${mod()}/${nameOf(random)}/${baseOf(random)}.ts`,
    `mods/${mod()}/${nameOf(random)}/${nameOf(random)}/${baseOf(random)}.ts`,
    `mods/${mod()}/${baseOf(random)}.tsx`,
    `decider/${baseOf(random)}.test.ts`,
    `decider/${baseOf(random)}.spec.ts`,
    `decider/${nameOf(random)}/${baseOf(random)}.ts`,
    `cmd/${mod()}/server.ts`,
    `cmd/${mod()}/${baseOf(random)}.ts`,
    `scripts/${baseOf(random)}.ts`,
    `${baseOf(random)}.ts`,
  ])
}

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
const lint = Effect.fn("EffectDomainPolicyTest.lint")(function* (root: string, config: string, files: ReadonlyArray<string>) {
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

/** The domain rules' diagnostics on one line, as sorted `rule:severity`. */
const domainAt = (found: Found, file: string, line: number) =>
  Arr.sort(
    Arr.map(
      Arr.filter(found, (each) => each.file === file && each.line === line && RULE_IDS.includes(each.rule)),
      (each) => `${each.rule.slice("effect/".length)}:${each.severity}`,
    ),
    Order.String,
  )

const differs = (outcome: { readonly want: ReadonlyArray<string>; readonly got: ReadonlyArray<string> }) => outcome.got.join() !== outcome.want.join()

const BASELINE = ".oxlintrc.baseline.json"

/** What a line must get: in the domain, its rules as errors; elsewhere, what the config without the domain overrides gives it. */
const wantAt = (file: string, rules: ReadonlyArray<Rule>, baseline: ReadonlyArray<string>) => {
  if (inDomain(file)) return Arr.map(rules, (rule) => `${rule}:error`)
  return baseline
}

const lintSeed = Effect.fn("EffectDomainPolicyTest.lintSeed")(function* (seed: number) {
  const root = yield* scratch
  put(root, HARD_CONFIG, rooted(hardText()))
  put(root, BASELINE, rooted(baselineText()))
  const random = generator(seed)
  const legacy = new Set(Arr.map(legacyBudgets(), (entry) => entry.file))
  const domain = [...domainPaths(random), ...legacy]
  const outside = outsidePaths(random)
  const fixtures = Arr.map(Arr.dedupe([...domain, ...outside]), (file) => ({ file, ...fixtureFile(random, CASES) }))
  for (const fixture of fixtures) put(root, fixture.file, fixture.text)
  const files = Arr.map(fixtures, ({ file }) => file)
  const real = yield* lint(root, HARD_CONFIG, files)
  const baseline = yield* lint(root, BASELINE, files)
  const outcomes = Arr.flatMap(fixtures, ({ file, placed }) =>
    Arr.map(placed, (each) => {
      const got = domainAt(real, file, each.line)
      const base = domainAt(baseline, file, each.line)
      const kept = Arr.filter(each.want, (rule) => !(legacy.has(file) && rule === "noTryCatch"))
      return { file, code: each.code, position: each.position, want: wantAt(file, kept, base), got }
    }),
  )
  return {
    wrong: Arr.filter(outcomes, differs),
    domain: Arr.filter(files, inDomain),
    outside: Arr.filter(files, (file) => !inDomain(file)),
    refusals: Arr.filter(outcomes, (outcome) => outcome.want.length > 0 && inDomain(outcome.file)).length,
    positions: new Set(Arr.flatMap(fixtures, ({ placed }) => Arr.map(placed, (each) => each.position))),
  }
})

/** A concrete file or specifier a glob matches. */
const concrete = (glob: string, name: string) => glob.replaceAll("**", `deep/${name}.ts`).replaceAll("*", name)

const fenceGroup = (override: Override) =>
  Arr.flatMap(Option.toArray(Option.fromUndefinedOr(override.rules?.["no-restricted-imports"])), (setting) =>
    Schema.decodeUnknownSync(
      Schema.Tuple([Schema.Literal("error"), Schema.Struct({ patterns: Schema.Array(Schema.Struct({ group: Schema.Array(Schema.String) })) })]),
    )(setting)[1].patterns,
  )

/** The import fences this unit found, by their files glob: each must still stand, with its own override. */
const FENCES = [
  "decider/*.ts",
  "mods/kernel/*.ts",
  "mods/pool/*.ts",
  "mods/orchestrate/*.ts",
  "mods/status/*.ts",
  "mods/status/tui/**",
  "mods/herdr/*.ts",
  "mods/escape/*.ts",
  "mods/recover/*.ts",
  "mods/guard/*.ts",
  "mods/rift/*.ts",
  "mods/tool-names/*.ts",
  "mods/memory/*.ts",
  "mods/idle-compact/*.ts",
  "mods/mail/*.ts",
  "mods/subagents/*.ts",
  "mods/subagents/opencode/*.ts",
  "mods/cache/*.ts",
  "mods/cache/opencode/*.ts",
  "mods/git/*.ts",
  "mods/git/tui/**",
  "mods/queue/*.ts",
  "mods/queue/tui/**",
  "mods/btw/*.ts",
  "mods/btw/opencode/*.ts",
  "mods/btw/tui/**",
  "mods/questions/*.ts",
  "mods/questions/tui/**",
  "mods/wake/*.ts",
  "mods/wake/tui/**",
  "mods/anthropic-auth/*.ts",
  "mods/prime/*.ts",
  "mods/prime/tui/**",
  "mods/skills/*.ts",
  "mods/skills/tui/**",
  "mods/web/*.ts",
]

/** Each pinned fence: a file its glob matches, and a specifier the first banned pattern of its override names (none when the override is gone). */
const fenceProbes = () =>
  Arr.map(FENCES, (glob, index) => ({
    glob,
    file: concrete(glob, `fence-probe-${index}`),
    specifier: Option.getOrElse(
      Option.map(
        Arr.findFirst(
          Arr.flatMap(
            Arr.filter(overrides(), (override) => override.files.join() === glob),
            (override: Override) => Arr.flatMap(fenceGroup(override), (pattern) => pattern.group),
          ),
          (banned) => !banned.startsWith("!"),
        ),
        (banned) => concrete(banned, "fence-probe"),
      ),
      () => "",
    ),
  }))

describe(`${HARD_CONFIG}: the production domain's syntax rules over generated paths`, () => {
  test.concurrent(
    "refuses each forbidden form as errors of its exact rules in every domain path and position, accepts the allowed forms, and leaves every other path as the config without the domain overrides leaves it",
    () =>
      runScoped(
        Effect.gen(function* () {
          const found = yield* lintSeed(20261112)
          expect(found.wrong).toEqual([])
          expect(found.domain.length).toBeGreaterThan(30)
          expect(found.outside.length).toBeGreaterThan(10)
          expect(found.positions).toEqual(new Set(POSITIONS))
          expect(found.refusals).toBeGreaterThan(found.domain.length * 15)
        }),
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "a second seed: generated mod and file names nobody wrote are protected as the existing ones are",
    () =>
      runScoped(
        Effect.gen(function* () {
          const found = yield* lintSeed(7)
          expect(found.wrong).toEqual([])
        }),
      ),
    TEST_TIMEOUT,
  )

  test("the domain overrides name the domain by glob, leave out only tests, specs, benchmarks, mod laws and the exact legacy try files, and only ever raise their rules to errors", () => {
    const all = overrides()
    const domain = Arr.filter(all, isDomainOverride)
    const legacy = Arr.map(legacyBudgets(), (entry) => entry.file)
    const elsewhere = Arr.filter(all, (override) => touchesDomainRules(override) && !isDomainOverride(override))
    expect(
      Arr.flatMap(elsewhere, (override) =>
        Arr.filter([...override.files, ...(override.excludeFiles ?? [])], (file) => /[*?[\]{}!]/u.test(file) || inDomain(file)),
      ),
    ).toEqual([])
    const switchedDown = Arr.flatMap(all, (override) =>
      Arr.map(
        Arr.filter(Object.entries(override.rules ?? {}), ([rule, setting]) => RULE_IDS.includes(rule) && setting !== "error"),
        ([rule, setting]) => ({ files: override.files, rule, setting }),
      ),
    )
    expect(switchedDown).toEqual([])
    expect(Arr.map(domain, (override) => override.files)).toEqual(Arr.map(domain, () => DOMAIN_FILES))
    expect(Arr.sort(Arr.flatMap(domain, (override) => Object.keys(override.rules ?? {})), Order.String)).toEqual(RULE_IDS)
    const exclusions = Arr.map(domain, (override) => ({
      rules: Object.keys(override.rules ?? {}),
      globs: Arr.filter(override.excludeFiles ?? [], (glob) => NOT_DOMAIN.includes(glob)),
      exact: Arr.sort(
        Arr.filter(override.excludeFiles ?? [], (glob) => !NOT_DOMAIN.includes(glob)),
        Order.String,
      ),
    }))
    expect(exclusions).toEqual(
      Arr.map(domain, (override) => ({
        rules: Object.keys(override.rules ?? {}),
        globs: NOT_DOMAIN,
        exact: Arr.filter(legacy, () => Object.keys(override.rules ?? {}).includes("effect/noTryCatch")),
      })),
    )
    expect(Arr.filter(legacy, (file) => !existsSync(path.join(REAL, file)))).toEqual([])
    expect(unpinned(legacyBudgets())).toEqual([])
    expect(Arr.filter(legacy, (file) => !inDomain(file))).toEqual([])
  })

  test("a new file cannot take a fixed legacy file's place in the try inventory, though the total stays at nine", () => {
    const added = { file: "mods/web/search.ts", count: 1 }
    const swapped = [...Arr.drop(LEGACY_TRIES, 1), added]
    const raised = Arr.map(LEGACY_TRIES, (entry) => ({ ...entry, count: entry.count + Number(entry.file === "mods/guard/kill.ts") }))
    expect({
      swappedTotal: Arr.reduce(swapped, 0, (sum, entry) => sum + entry.count),
      swapped: unpinned(swapped),
      raised: unpinned(raised),
      pinned: unpinned(LEGACY_TRIES),
      shrunk: unpinned(Arr.drop(LEGACY_TRIES, 3)),
    }).toEqual({ swappedTotal: 9, swapped: [added], raised: [{ file: "mods/guard/kill.ts", count: 2 }], pinned: [], shrunk: [] })
  })

  test.concurrent(
    "every import fence still stands on its own glob and refuses an import it bans there",
    () =>
      runScoped(
        Effect.gen(function* () {
          const root = yield* scratch
          put(root, HARD_CONFIG, rooted(hardText()))
          const probes = fenceProbes()
          for (const probe of probes) put(root, probe.file, `import "${probe.specifier || "effect"}"\n`)
          const found = yield* lint(root, HARD_CONFIG, Arr.map(probes, (probe) => probe.file))
          const missed = Arr.filter(
            probes,
            (probe) =>
              probe.specifier === "" ||
              !Arr.some(found, (each) => each.file === probe.file && each.line === 1 && each.rule === "no-restricted-imports" && each.severity === "error"),
          )
          expect(Arr.map(missed, (probe) => probe.glob)).toEqual([])
        }),
      ),
    TEST_TIMEOUT,
  )
})

const TRY_FORMS = [
  'export function legacyProbe$() { try { return JSON.parse("1") } catch { return 0 } }',
  'export const legacyProbe$ = () => { try { return JSON.parse("1") } finally { JSON.parse("2") } }',
  'try { JSON.parse("1") } catch (error) { JSON.stringify(error) } finally { JSON.parse("2") }',
]

describe(`${POLICY}: the legacy try statements of the domain`, () => {
  test.concurrent(
    "one generated try added to each legacy file passes the hard lint there and fails the per-file debt comparison; the unchanged files hold their budgets",
    () =>
      runScoped(
        Effect.gen(function* () {
          const random = generator(20261112)
          const legacy = legacyBudgets()
          const known = knownRules(policy())
          const tryBudgets = new Map(Arr.map(legacy, ({ file, count }) => [file, new Map([["effect/noTryCatch", count]])] as const))
          const debtConfig = rooted(readFileSync(path.join(REAL, DEBT_CONFIG), "utf8"))
          const files = Arr.map(legacy, ({ file }) => file)
          const countIn = Effect.fn("EffectDomainPolicyTest.countIn")(function* (added: boolean) {
            const root = yield* scratch
            put(root, DEBT_CONFIG, debtConfig)
            put(root, HARD_CONFIG, rooted(hardText()))
            for (const file of files) {
              const tail = Arr.filter([`${random.pick(TRY_FORMS).replaceAll("$", String(random.int(1000)))}\n`], () => added)
              put(root, file, `${readFileSync(path.join(REAL, file), "utf8")}\n${tail.join("")}`)
            }
            const report = yield* scan({ root, oxlint: path.join(REAL, "node_modules/.bin/oxlint"), config: path.join(root, DEBT_CONFIG), files, rules: policy().rules.length, timeoutMs: CLI_TIMEOUT })
            const counts = new Map(
              Arr.map(files, (file) => [file, new Map([["effect/noTryCatch", Arr.filter(report.diagnostics, (each) => each.filename === file && ruleOf(each.code ?? "") === "effect/noTryCatch").length]])] as const),
            )
            const hard = yield* lint(root, HARD_CONFIG, files)
            return { verdict: compare(tryBudgets, counts, known), hardTry: Arr.filter(hard, (each) => each.rule === "effect/noTryCatch") }
          })
          const unchanged = yield* countIn(false)
          const changed = yield* countIn(true)
          expect(unchanged).toEqual({ verdict: { breaches: [], unknownRules: [] }, hardTry: [] })
          expect(changed.hardTry).toEqual([])
          expect(changed.verdict).toEqual({ breaches: Arr.map(legacy, ({ file, count }) => ({ file, rule: "effect/noTryCatch", budget: count, count: count + 1 })), unknownRules: [] })
        }),
      ),
    TEST_TIMEOUT,
  )
})
