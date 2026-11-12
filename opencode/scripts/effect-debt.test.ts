/**
 * The Effect lint policy at its public seams: the pure comparator over generated budgets and
 * counts, the `scripts/effect-debt.ts` command over real temporary workspaces (real oxlint and
 * plugin, or a stand-in linter that fails), and `.oxlintrc.json`'s hard rules over generated
 * forbidden and accepted fixtures in every path class.
 */
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Array as Arr, Effect, Schema, type Scope } from "effect"
import {
  compare,
  type Counts,
  DEBT_CONFIG,
  EXEMPTABLE,
  HARD_CONFIG,
  HOST_BRIDGES,
  type Inputs,
  LINT_MANIFEST,
  parseOptions,
  POLICY,
  Policy,
  policyProblems,
  readInstalled,
  serialize,
  spawn,
  SUPPRESSION,
  tighten,
} from "./effect-debt.ts"

const REAL = process.cwd()
const CLI_TIMEOUT = 60_000
const TEST_TIMEOUT = 120_000

const readReal = (file: string) => readFileSync(path.join(REAL, file), "utf8")
const realPolicy = Schema.decodeUnknownSync(Schema.fromJsonString(Policy))(readReal(POLICY))
const RULES = realPolicy.rules
const KNOWN = new Set([...RULES, SUPPRESSION])

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

const CLASSES = ["mods/pool/", "cmd/pool/", "decider/", "scripts/", "tests/", "scenarios/", "lint/", "testbeds/gamut/", ""]

const fileName = (random: ReturnType<typeof generator>, index: number) => `${random.pick(CLASSES)}f${index}${random.pick([".ts", ".test.ts", ".tsx"])}`

const generateBudgets = (random: ReturnType<typeof generator>): Counts =>
  new Map(
    Arr.makeBy(1 + random.int(8), (index) => {
      const rules = Arr.dedupe(Arr.makeBy(1 + random.int(4), () => random.pick([...RULES, SUPPRESSION])))
      return [fileName(random, index), new Map(Arr.map(rules, (rule) => [rule, 1 + random.int(5)] as const))] as const
    }),
  )

const copy = (counts: Counts) => new Map(Arr.map(Array.from(counts), ([file, rules]) => [file, new Map(rules)] as const))

/** One edit of a workspace between the budgeted scan and the next: what it does to the counts. */
const MUTATIONS = ["same", "increase", "decrease", "new file", "delete file", "rename file", "new rule in a file"] as const

const mutate = (random: ReturnType<typeof generator>, budgets: Counts, mutation: (typeof MUTATIONS)[number]) => {
  const current = copy(budgets)
  const [file, rules] = random.pick(Array.from(current))
  const [rule, count] = random.pick(Array.from(rules))
  if (mutation === "increase") rules.set(rule, count + 1 + random.int(3))
  if (mutation === "decrease") rules.set(rule, random.int(count))
  if (mutation === "new file") current.set(`${random.pick(CLASSES)}new-${random.int(1000)}.ts`, new Map([[random.pick(RULES), 1]]))
  if (mutation === "delete file") current.delete(file)
  if (mutation === "rename file") {
    current.delete(file)
    current.set(`${file}.moved.ts`, rules)
  }
  if (mutation === "new rule in a file") rules.set(random.pick(Arr.filter(RULES, (each) => !rules.has(each))), 1)
  return current
}

const pairCount = (counts: Counts, file: string, rule: string) => counts.get(file)?.get(rule) ?? 0

/** The oracle, written from the contract alone: a pair passes only at exactly its own budget, a missing budget being zero and a listed one positive. */
const expectedBreaches = (budgets: Counts, current: Counts) => {
  const pairs = new Set([...budgets, ...current].flatMap(([file, rules]) => Array.from(rules.keys(), (rule) => `${file} ${rule}`)))
  return Array.from(pairs)
    .flatMap((pair) => {
      const [file = "", rule = ""] = pair.split(" ")
      const budget = pairCount(budgets, file, rule)
      const count = pairCount(current, file, rule)
      if (count === budget && !(budgets.get(file)?.has(rule) && budget < 1)) return []
      return [`${file} ${rule} ${budget} ${count}`]
    })
    .sort()
}

describe("compare: per exact (file, rule), no credit, no headroom", () => {
  test("generated budgets and edits over every recommended rule and path class match the oracle", () => {
    for (const seed of Arr.range(1, 400)) {
      const random = generator(seed)
      const budgets = generateBudgets(random)
      const mutation = random.pick(MUTATIONS)
      const current = mutate(random, budgets, mutation)
      const verdict = compare(budgets, current, KNOWN)
      const found = Arr.map(verdict.breaches, (breach) => `${breach.file} ${breach.rule} ${breach.budget} ${breach.count}`).sort()
      expect({ seed, mutation, found }).toEqual({ seed, mutation, found: expectedBreaches(budgets, current) })
      expect(verdict.unknownRules).toEqual([])
      expect(Arr.every(verdict.breaches, (breach) => breach.count >= 0 && breach.budget >= 0)).toBe(true)
      if (mutation === "same") expect(verdict.breaches).toEqual([])
      if (mutation !== "same") expect(verdict.breaches.length).toBeGreaterThan(0)
    }
  })

  test("one file's reduction never pays for another's increase, nor one rule's for another's", () => {
    const budgets: Counts = new Map([["mods/a/a.ts", new Map([["effect/noTryCatch", 1]])]])
    const moved: Counts = new Map([
      ["mods/a/a.ts", new Map([["effect/noTryCatch", 0]])],
      ["mods/b/b.ts", new Map([["effect/noTryCatch", 1]])],
    ])
    expect(compare(budgets, moved, KNOWN).breaches).toEqual([
      { file: "mods/a/a.ts", rule: "effect/noTryCatch", budget: 1, count: 0 },
      { file: "mods/b/b.ts", rule: "effect/noTryCatch", budget: 0, count: 1 },
    ])
    const swapped: Counts = new Map([["mods/a/a.ts", new Map([["effect/noThrowStatement", 1]])]])
    expect(compare(budgets, swapped, KNOWN).breaches.length).toBe(2)
  })

  test("a zero budget, an unknown rule in a budget or a count are reported", () => {
    const budgets: Counts = new Map([["scripts/a.ts", new Map([["effect/noAs", 0], ["effect/noSuchRule", 1]])]])
    const current: Counts = new Map([["scripts/a.ts", new Map([["effect/noSuchRule", 1], ["eslint(no-eval)", 1]])]])
    const verdict = compare(budgets, current, KNOWN)
    expect(verdict.unknownRules).toEqual(["effect/noSuchRule", "eslint(no-eval)"])
    expect(Arr.map(verdict.breaches, (breach) => breach.rule)).toEqual(["effect/noAs", "eslint(no-eval)"])
  })

  test("tighten only lowers: never a new pair, never above a budget or a count, and only overs remain", () => {
    for (const seed of Arr.range(1, 200)) {
      const random = generator(seed)
      const budgets = generateBudgets(random)
      const current = mutate(random, budgets, random.pick(MUTATIONS))
      const lowered = tighten(budgets, current)
      for (const [file, rules] of lowered)
        for (const [rule, budget] of rules) {
          expect(budget).toBeGreaterThan(0)
          expect(budget).toBeLessThanOrEqual(pairCount(budgets, file, rule))
          expect(budget).toBeLessThanOrEqual(pairCount(current, file, rule))
        }
      expect(Arr.every(compare(lowered, current, KNOWN).breaches, (breach) => breach.count > breach.budget)).toBe(true)
    }
  })

  test("the command line refuses an unknown flag, two modes and a flag without its value", () => {
    const parse = (argv: ReadonlyArray<string>) => Effect.runSync(Effect.result(parseOptions(argv, REAL)))._tag
    expect(parse(["--check"])).toBe("Success")
    expect(parse(["--check", "--root", "/nonexistent/loop-probe-x", "--timeout-ms", "5"])).toBe("Success")
    expect(parse(["--check", "--counts"])).toBe("Failure")
    expect(parse(["--chek"])).toBe("Failure")
    expect(parse(["--root"])).toBe("Failure")
    expect(parse(["--timeout-ms", "soon"])).toBe("Failure")
  })
})

const Pinned = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
)

/** The package a module directory resolves `name` to, beside it in the install's isolated layout. */
const installedBeside = (moduleDir: string, name: string) => {
  const real = realpathSync(path.join(REAL, moduleDir))
  const scope = real.slice(0, real.lastIndexOf("/node_modules/") + "/node_modules".length)
  return Schema.decodeUnknownSync(Pinned)(readFileSync(path.join(scope, name, "package.json"), "utf8"))
}

describe("the plugin never moves the runtime's effect", () => {
  test("opencode-drive runs on the effect and platform packages it pins; the plugin on the lint workspace's effect", () => {
    const root = Schema.decodeUnknownSync(Pinned)(`{"version":"0",${readReal("package.json").slice(1)}`)
    const drive = installedBeside("node_modules/opencode-drive", "opencode-drive")
    expect(installedBeside("node_modules/opencode-drive", "effect").version).toBe(drive.peerDependencies?.effect ?? "")
    expect(root.devDependencies?.effect).toBe(drive.peerDependencies?.effect ?? "")
    for (const name of ["@effect/platform-node", "@effect/platform-node-shared"])
      expect({ name, version: installedBeside("node_modules/opencode-drive", name).version }).toEqual({ name, version: drive.dependencies?.[name] ?? "" })
    expect(Object.keys({ ...root.devDependencies, ...root.dependencies })).not.toContain("oxlint-plugin-effect")
    const lint = Schema.decodeUnknownSync(Pinned)(`{"version":"0",${readReal(LINT_MANIFEST).slice(1)}`)
    expect(installedBeside("lint/node_modules/oxlint-plugin-effect", "effect").version).toBe(lint.devDependencies?.effect ?? "")
  })
})

/** The real workspace's policy, configs and installed versions: inputs with no problem. */
const realInputs = readInstalled(REAL).pipe(Effect.map((installed): Inputs => ({ policy: realPolicy, ...installed })))

const FILE_KINDS = {
  exact: ["mods/demo/model.ts", "scripts/demo.ts", "tests/demo.test.ts", "lint/demo.ts"],
  glob: ["mods/demo/*.ts", "scripts/**", "tests/demo.{ts,tsx}", "lint/demo?.ts", "!scripts/demo.ts", "lint/[ab].ts"],
} as const
const BRIDGED = Arr.map(HOST_BRIDGES, ({ rule }) => rule)
const RULE_KINDS = { exemptable: EXEMPTABLE, style: Arr.filter(RULES, (rule) => !EXEMPTABLE.includes(rule) && !BRIDGED.includes(rule)) } as const
const REASONS = ["", "   ", "a bridge with no Effect platform layer"]
/** Which side of the fence lists the exemption: the enforcing config's override, the policy's entry, or both. */
const SIDES = [
  { override: true, exemption: true },
  { override: true, exemption: false },
  { override: false, exemption: true },
] as const

/** One generated exemption: the kinds its file and rule are drawn from, its reason and the sides that list it. */
interface FenceCase {
  readonly seed: number
  readonly fileKind: keyof typeof FILE_KINDS
  readonly ruleKind: keyof typeof RULE_KINDS
  readonly reason: string
  readonly override: boolean
  readonly exemption: boolean
}

const FENCE_CASES: ReadonlyArray<FenceCase> = Arr.flatMap(Arr.range(1, 40), (seed) =>
  Arr.flatMap(["exact", "glob"] as const, (fileKind) =>
    Arr.flatMap(["exemptable", "style"] as const, (ruleKind) => Arr.flatMap(REASONS, (reason) => Arr.map(SIDES, (side) => ({ seed, fileKind, ruleKind, reason, ...side })))),
  ),
)

const when = (holds: boolean, line: string) => Arr.filter([line], () => holds)

/** The oracle, from the contract alone: the problems a case must raise; only an exact file, an exemptable rule, a reason and both sides raise none. */
const fenceOracle = (fence: FenceCase, file: string, rule: string) => [
  ...when(fence.override && fence.fileKind === "glob", `${DEBT_CONFIG} exempts a glob, ${file}; exemptions name exact files`),
  ...when(fence.override && fence.fileKind === "exact" && fence.ruleKind === "style", `${DEBT_CONFIG} exempts ${rule} in ${file}; only ${EXEMPTABLE.join(", ")} can be exempted`),
  ...when(fence.exemption && fence.reason.trim().length === 0, `the exemption of ${rule} in ${file} has no reason`),
  ...when(!(fence.override && fence.exemption), `${DEBT_CONFIG}'s overrides (`),
]

const checkFence = (real: Inputs, fence: FenceCase) => {
  const random = generator(fence.seed)
  const file = random.pick(FILE_KINDS[fence.fileKind])
  const rule = random.pick(RULE_KINDS[fence.ruleKind])
  const overrides = Arr.filter([{ files: [file], rules: { [rule]: "off" as const } }], () => fence.override)
  const exemptions = Arr.filter([{ file, rule, reason: fence.reason }], () => fence.exemption)
  const problems = policyProblems({ ...real, debt: { ...real.debt, overrides }, policy: { ...realPolicy, exemptions } }).join("\n")
  const expected = fenceOracle(fence, file, rule)
  expect({ fence, file, rule, refused: problems.length > 0, missing: Arr.filter(expected, (line) => !problems.includes(line)) }).toEqual({
    fence,
    file,
    rule,
    refused: expected.length > 0,
    missing: [],
  })
}

describe("the exemption fence: only an exact file, an exemptable rule, a reason and a matching policy entry switch a rule off", () => {
  test("every generated (file kind, rule kind, reason, sides) but the allowed one is refused with its reason", () =>
    runScoped(
      Effect.gen(function* () {
        const real = yield* realInputs
        expect(policyProblems(real)).toEqual([])
        Arr.forEach(FENCE_CASES, (fence) => checkFence(real, fence))
      }),
    ))

  test("a host-bridge rule is switched off only for its named exact file, with a reason, and refused for any second file", () =>
    runScoped(
      Effect.gen(function* () {
        const real = yield* realInputs
        const rule = "effect/noTestLifecycleHooks"
        const bridge = "tests/scratch.ts"
        expect(HOST_BRIDGES).toEqual([{ rule, files: [bridge] }])
        const problems = (entries: ReadonlyArray<{ readonly file: string; readonly reason: string }>) =>
          policyProblems({
            ...real,
            debt: { ...real.debt, overrides: Arr.map(entries, ({ file }) => ({ files: [file], rules: { [rule]: "off" as const } })) },
            policy: { ...realPolicy, exemptions: Arr.map(entries, ({ file, reason }) => ({ file, rule, reason })) },
          })
        const reason = "the one bridge to bun's suite lifecycle"
        const refusedFor = (file: string) => `${DEBT_CONFIG} exempts ${rule} in ${file}; only its host bridge ${bridge} can be exempted from it`
        expect({
          bridge: problems([{ file: bridge, reason }]),
          noReason: problems([{ file: bridge, reason: " " }]),
          second: problems([{ file: bridge, reason }, { file: "tests/demo.test.ts", reason }]),
          other: problems([{ file: "tests/scratch.test.ts", reason }]),
          glob: problems([{ file: "tests/scratch.*", reason }]),
        }).toEqual({
          bridge: [],
          noReason: [`the exemption of ${rule} in ${bridge} has no reason`],
          second: [refusedFor("tests/demo.test.ts")],
          other: [refusedFor("tests/scratch.test.ts")],
          glob: [`${DEBT_CONFIG} exempts a glob, tests/scratch.*; exemptions name exact files`],
        })
      }),
    ))

  test("the enforcing config's rules and the policy's follow the installed preset exactly", () =>
    runScoped(
      Effect.gen(function* () {
        const real = yield* realInputs
        const rule = "effect/noTryCatch"
        expect(real.debt.rules[rule]).toBe("error")
        const loosened = { ...real.debt.rules, [rule]: ["error", { max: 1 }] as const }
        expect(policyProblems({ ...real, debt: { ...real.debt, rules: loosened } })).toEqual([`${DEBT_CONFIG} sets ${rule} differently from the preset`])
        const fewer = Object.fromEntries(Arr.filter(Object.entries(real.debt.rules), ([each]) => each !== rule))
        expect(policyProblems({ ...real, debt: { ...real.debt, rules: fewer } })).toContain(`${DEBT_CONFIG}'s rules differ from the installed preset's`)
        expect(policyProblems({ ...real, policy: { ...realPolicy, rules: Arr.filter(RULES, (each) => each !== rule) } })).toContain(`the policy's rules differ from the installed preset's`)
      }),
    ))
})

/** A temporary directory of its own, outside the repo, removed when the scope closes. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "effect-debt-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const put = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

const DEBT_SOURCE = [
  "export const parse = async (text: string) => {",
  "  try {",
  "    return text.length > 0 ? JSON.parse(text) : 0",
  "  } catch {",
  "    return 0",
  "  }",
  "}",
  "",
].join("\n")

/** A source whose one finding is effect/noTryCatch, so switching that rule off hides all its debt. */
const TRY_ONLY_SOURCE = ["export const size = (text: string) => {", "  try {", "    return text.length", "  } catch {", "    return 0", "  }", "}", ""].join("\n")

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const DebtOverrides = Schema.fromJsonString(Schema.StructWithRest(Schema.Struct({ overrides: Schema.Array(Schema.Unknown) }), [Schema.Record(Schema.String, Schema.Unknown)]))

/** One source with debt in each path class the policy covers. */
const SOURCES = Arr.map(["mods/demo/model.ts", "cmd/demo/server.ts", "decider/demo.ts", "scripts/demo.ts", "tests/demo.test.ts", "scenarios/demo.ts", "lint/demo.ts", "testbeds/demo/run.ts", "root.ts"], (file) => [file, DEBT_SOURCE] as const)

const hardConfigText = () => readReal(HARD_CONFIG).replace('"./lint/test-env.ts"', `"${path.join(REAL, "lint/test-env.ts")}"`)

const git = (root: string, ...argv: ReadonlyArray<string>) =>
  spawn(["git", "-c", "user.email=effect-debt@example.com", "-c", "user.name=effect-debt", ...argv], root, CLI_TIMEOUT).pipe(
    Effect.tap((answer) => Effect.sync(() => expect({ argv, code: answer.code, stderr: answer.stderr }).toEqual({ argv, code: 0, stderr: answer.stderr }))),
  )

/** A workspace with the real configs, pins and installed linter, the real exemptions' files, and `SOURCES`, under git. */
const workspace = Effect.fn("EffectDebtTest.workspace")(function* () {
  const root = yield* scratch
  symlinkSync(path.join(REAL, "node_modules"), path.join(root, "node_modules"))
  put(root, "package.json", readReal("package.json"))
  put(root, LINT_MANIFEST, readReal(LINT_MANIFEST))
  symlinkSync(path.join(REAL, "lint/node_modules"), path.join(root, "lint/node_modules"))
  put(root, HARD_CONFIG, hardConfigText())
  put(root, DEBT_CONFIG, readReal(DEBT_CONFIG))
  for (const exemption of realPolicy.exemptions) put(root, exemption.file, "export const placeholder = 1\n")
  for (const [file, text] of SOURCES) put(root, file, text)
  yield* git(root, "init", "-q")
  return root
})

const cli = (root: string, ...argv: ReadonlyArray<string>) =>
  spawn([process.execPath, path.join(REAL, "scripts/effect-debt.ts"), "--root", root, ...argv], REAL, CLI_TIMEOUT)

const CountsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Int)))

const writePolicy = (root: string, budgets: typeof CountsJson.Type, edit: Partial<Policy> = {}) =>
  put(root, POLICY, serialize({ ...realPolicy, provenance: "test workspace", budgets, ...edit }))

/** The workspace's own counts, written as its policy's budgets: a workspace whose `--check` passes. */
const budgeted = Effect.fn("EffectDebtTest.budgeted")(function* () {
  const root = yield* workspace()
  writePolicy(root, {})
  const counted = yield* cli(root, "--counts")
  expect({ code: counted.code, stderr: counted.stderr }).toEqual({ code: 0, stderr: "" })
  const budgets = Schema.decodeUnknownSync(CountsJson)(counted.stdout)
  writePolicy(root, budgets)
  return { root, budgets }
})

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

/** Runs `--check` after `edit`, expecting it to fail with each of `expected` in its output. */
const failsAfter = (edit: (root: string, budgets: typeof CountsJson.Type) => ReadonlyArray<string>, ...expected: ReadonlyArray<string>) =>
  runScoped(
    Effect.gen(function* () {
      const { root, budgets } = yield* budgeted()
      const extra = edit(root, budgets)
      const checked = yield* cli(root, "--check", ...extra)
      expect(checked.code).toBe(1)
      for (const line of expected) expect(checked.stderr).toContain(line)
    }),
  )

describe("effect-debt --check over a real workspace", () => {
  test.concurrent(
    "passes at the budgets, counting every path class and the plugin's rules",
    () =>
      runScoped(
        Effect.gen(function* () {
          const { root, budgets } = yield* budgeted()
          expect(Object.keys(budgets).sort()).toEqual(Arr.map(SOURCES, ([file]) => file).sort())
          for (const [file] of SOURCES) expect(Object.keys(budgets[file] ?? {})).toContain("effect/noTryCatch")
          const checked = yield* cli(root, "--check")
          expect({ code: checked.code, stderr: checked.stderr }).toEqual({ code: 0, stderr: "" })
          expect(checked.stdout).toContain("each (file, rule) at its budget")
        }),
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails on a new untracked file's debt, which has no budget",
    () =>
      failsAfter((root) => {
        put(root, "mods/demo/added.ts", DEBT_SOURCE)
        return []
      }, "over: mods/demo/added.ts effect/noTryCatch has 1, budget 0; fix the new findings in mods/demo/added.ts"),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails on more debt in a budgeted file and on removed debt left in the policy",
    () =>
      failsAfter(
        (root) => {
          put(root, "cmd/demo/server.ts", `${DEBT_SOURCE}export const again = async () => 1\n`)
          put(root, "decider/demo.ts", "export const parse = (text: string) => text.length\n")
          return []
        },
        "over: cmd/demo/server.ts effect/noAsyncFunction",
        "lower: decider/demo.ts effect/noTryCatch has 0, budget 1",
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails on a renamed or deleted file",
    () =>
      failsAfter(
        (root) => {
          rmSync(path.join(root, "scripts/demo.ts"))
          rmSync(path.join(root, "lint/demo.ts"))
          put(root, "lint/renamed.ts", DEBT_SOURCE)
          return []
        },
        "lower: scripts/demo.ts effect/noTryCatch has 0, budget 1",
        "lower: lint/demo.ts effect/noTryCatch has 0, budget 1",
        "over: lint/renamed.ts effect/noTryCatch has 1, budget 0",
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails when a suppression hides debt, and ignores a nested config",
    () =>
      failsAfter(
        (root) => {
          put(root, "testbeds/demo/run.ts", DEBT_SOURCE.replace("  try {", "  // oxlint-disable-next-line effect/noTryCatch -- hidden\n  try {"))
          put(root, "scenarios/.oxlintrc.json", '{ "rules": { "effect/noTryCatch": "off" } }')
          return []
        },
        `over: testbeds/demo/run.ts ${SUPPRESSION} has 1, budget 0`,
        "lower: testbeds/demo/run.ts effect/noTryCatch has 0, budget 1",
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails when an ignore pattern or the test classification changes in one place only",
    () =>
      failsAfter(
        (root) => {
          put(root, DEBT_CONFIG, readReal(DEBT_CONFIG).replace('"media/**"', '"media/**",\n    "mods/demo/**"'))
          put(root, HARD_CONFIG, hardConfigText().replace('"tests/**",', '"tests/**",\n        "scripts/**",'))
          return []
        },
        `${DEBT_CONFIG}'s ignorePatterns differ from the policy's`,
        `${HARD_CONFIG}'s effect.testFiles differ from the policy's`,
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails when the policy ignores a budgeted file: its debt is not re-spent",
    () =>
      failsAfter((root, budgets) => {
        const ignorePatterns = [...realPolicy.ignorePatterns, "mods/demo/**"]
        writePolicy(root, budgets, { ignorePatterns })
        put(root, DEBT_CONFIG, readReal(DEBT_CONFIG).replace('"media/**"', '"media/**",\n    "mods/demo/**"'))
        put(root, HARD_CONFIG, hardConfigText().replace('"media/**"', '"media/**",\n    "mods/demo/**"'))
        return []
      }, "lower: mods/demo/model.ts effect/noTryCatch has 0, budget 1"),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails on plugin or linter version drift, an unknown budget rule, a zero budget and a malformed policy",
    () =>
      runScoped(
        Effect.gen(function* () {
          const { root, budgets } = yield* budgeted()
          writePolicy(root, budgets, { plugin: "0.32.0" })
          expect((yield* cli(root, "--check")).stderr).toContain("oxlint-plugin-effect drifted")
          writePolicy(root, budgets, { oxlint: "1.88.0" })
          expect((yield* cli(root, "--check")).stderr).toContain("oxlint drifted")
          writePolicy(root, budgets)
          put(root, "package.json", readReal("package.json").replace('"oxlint": ', '"oxlint-plugin-effect": "0.32.1",\n    "oxlint": '))
          expect((yield* cli(root, "--check")).stderr).toContain(`package.json depends on oxlint-plugin-effect 0.32.1; it belongs to ${LINT_MANIFEST} alone`)
          put(root, "package.json", readReal("package.json"))
          put(root, LINT_MANIFEST, readReal(LINT_MANIFEST).replace('"effect": "4.1.0"', '"effect": "4.1.1"'))
          expect((yield* cli(root, "--check")).stderr).toContain("the plugin's effect drifted")
          put(root, LINT_MANIFEST, readReal(LINT_MANIFEST))
          writePolicy(root, { ...budgets, "root.ts": { ...budgets["root.ts"], "effect/noSuchRule": 1, "effect/noAs": 0 } })
          const unknown = yield* cli(root, "--check")
          expect(unknown.stderr).toContain("unknown rule effect/noSuchRule")
          expect(unknown.stderr).toContain("the budget of effect/noAs in root.ts is 0")
          put(root, POLICY, "{ not json")
          const malformed = yield* cli(root, "--check")
          expect({ code: malformed.code, problem: malformed.stderr.includes(`${POLICY} is not valid`) }).toEqual({ code: 1, problem: true })
        }),
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails on a source oxlint cannot parse",
    () => failsAfter((root) => {
      put(root, "mods/demo/broken.ts", "export const broken = (\n")
      return []
    }, "mods/demo/broken.ts: ", "(a parse or config error)"),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails when an override and a policy exemption switch a style rule off for a new file's debt",
    () =>
      failsAfter(
        (root, budgets) => {
          put(root, "mods/demo/added.ts", TRY_ONLY_SOURCE)
          const debt = Schema.decodeUnknownSync(DebtOverrides)(readReal(DEBT_CONFIG))
          const overrides = [...debt.overrides, { files: ["mods/demo/added.ts"], rules: { "effect/noTryCatch": "off" } }]
          put(root, DEBT_CONFIG, Schema.encodeSync(JsonObject)({ ...debt, overrides }))
          const exemption = { file: "mods/demo/added.ts", rule: "effect/noTryCatch", reason: "a style rule is never a bridge" }
          writePolicy(root, budgets, { exemptions: [...realPolicy.exemptions, exemption] })
          return []
        },
        `${DEBT_CONFIG} exempts effect/noTryCatch in mods/demo/added.ts; only ${EXEMPTABLE.join(", ")} can be exempted`,
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails on a workspace with no source files, never an empty pass",
    () =>
      runScoped(
        Effect.gen(function* () {
          const root = yield* scratch
          symlinkSync(path.join(REAL, "node_modules"), path.join(root, "node_modules"))
          put(root, "package.json", readReal("package.json"))
          put(root, LINT_MANIFEST, readReal(LINT_MANIFEST))
          symlinkSync(path.join(REAL, "lint/node_modules"), path.join(root, "lint/node_modules"))
          put(root, HARD_CONFIG, hardConfigText())
          const { overrides: _overrides, ...debt } = Schema.decodeUnknownSync(JsonObject)(readReal(DEBT_CONFIG))
          put(root, DEBT_CONFIG, Schema.encodeSync(JsonObject)(debt))
          writePolicy(root, {}, { exemptions: [] })
          yield* git(root, "init", "-q")
          const checked = yield* cli(root, "--check")
          expect({ code: checked.code, empty: checked.stderr.includes(`no source files under ${root}`) }).toEqual({ code: 1, empty: true })
        }),
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "fails on a diagnostic for a file outside the source list, even one the policy budgets",
    () =>
      failsAfter((root, budgets) => {
        writePolicy(root, { ...budgets, "elsewhere/outside.ts": { "effect/noTryCatch": 1 } })
        const body = [
          `const real = Bun.spawnSync(["${path.join(REAL, "node_modules/.bin/oxlint")}", ...process.argv.slice(2)], { stdout: "pipe", stderr: "inherit" })`,
          "const report = JSON.parse(real.stdout.toString())",
          'report.diagnostics.push({ code: "effect(noTryCatch)", message: "planted", filename: "elsewhere/outside.ts", severity: "error" })',
          "process.stdout.write(JSON.stringify(report))",
          "process.exit(real.exitCode)",
        ].join("\n")
        return ["--oxlint", fakeLinter(root, body)]
      }, "elsewhere/outside.ts: a diagnostic for a file outside the source list"),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "bootstrap refuses an existing policy and budgets only files tracked at HEAD",
    () =>
      runScoped(
        Effect.gen(function* () {
          const root = yield* workspace()
          writePolicy(root, {})
          expect((yield* cli(root, "--bootstrap")).stderr).toContain(`${POLICY} exists`)
          rmSync(path.join(root, POLICY))
          yield* git(root, "add", "-A")
          yield* git(root, "commit", "-q", "-m", "base")
          put(root, "mods/demo/untracked.ts", DEBT_SOURCE)
          const booted = yield* cli(root, "--bootstrap")
          expect({ code: booted.code, stderr: booted.stderr }).toEqual({ code: 0, stderr: "" })
          const written = Schema.decodeUnknownSync(Schema.fromJsonString(Policy))(readFileSync(path.join(root, POLICY), "utf8"))
          expect(Object.keys(written.budgets)).toContain("mods/demo/model.ts")
          expect(Object.keys(written.budgets)).not.toContain("mods/demo/untracked.ts")
        }),
      ),
    TEST_TIMEOUT,
  )
})

/** A stand-in linter: `body` runs with `files`, the paths it was asked to lint. */
const fakeLinter = (root: string, body: string) => {
  const file = path.join(root, "fake-oxlint")
  writeFileSync(file, `#!${process.execPath}\nconst files = process.argv.slice(2).filter((arg) => !arg.startsWith("-") && !arg.endsWith(".json"))\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const report = (fields: string) => `process.stdout.write(JSON.stringify({ ${fields} }))`

const FAKES = [
  ["exits with a failure code", 'process.stderr.write("config failed to load"); process.exit(2)', "oxlint exited 2: config failed to load"],
  ["prints malformed JSON", 'process.stdout.write("{ diagnostics: ["); process.exit(1)', "oxlint's JSON report is not valid"],
  ["reports success with no diagnostics", report(`diagnostics: [], number_of_files: files.length, number_of_rules: ${RULES.length}`), "lower: mods/demo/model.ts effect/noTryCatch has 0, budget 1"],
  ["loads fewer rules than the preset", report(`diagnostics: [], number_of_files: files.length, number_of_rules: ${RULES.length - 1}`), `expected ${RULES.length}: the plugin or a rule did not load`],
  ["skips a file", report(`diagnostics: [], number_of_files: files.length - 1, number_of_rules: ${RULES.length}`), "an ignore pattern or config hides source"],
  ["reports a diagnostic without a rule", report(`diagnostics: [{ message: "Unexpected token", filename: files[0] }], number_of_files: files.length, number_of_rules: ${RULES.length}`), "Unexpected token (a parse or config error)"],
  ["reports an unknown rule", report(`diagnostics: [{ code: "effect(noSuchRule)", message: "x", filename: files[0] }], number_of_files: files.length, number_of_rules: ${RULES.length}`), "unknown rule effect/noSuchRule"],
  ["never answers", "setInterval(() => {}, 1000)", "timed out after 2000 ms"],
] as const

describe("effect-debt --check fails closed when the linter fails", () => {
  for (const [name, body, expected] of FAKES)
    test.concurrent(`when oxlint ${name}`, () => failsAfter((root) => ["--oxlint", fakeLinter(root, body), "--timeout-ms", "2000"], expected), TEST_TIMEOUT)
})

/** Each hard rule: a source it must refuse and one it must accept; test-only rules are written as `*.test.ts`. */
const HARD_RULES: ReadonlyArray<readonly [rule: string, inTests: boolean, forbidden: string, accepted: string]> = [
  [
    "maxHalsteadDifficulty",
    false,
    `export const busy = (a: number, b: number) => ${Arr.makeBy(40, () => "a + b - a * b / a % b").join(" + ")}`,
    "export const sum = (a: number, b: number) => a + b",
  ],
  [
    "noAliasTestLayer",
    true,
    "declare const build: () => number\nexport class Jobs { static Live = build(); static Test = Jobs.Live }",
    "declare const live: number\ndeclare const fake: number\nexport class Jobs { static Live = live; static Test = fake }",
  ],
  [
    "noEagerAcquire",
    false,
    'import { Effect } from "effect"\ndeclare const pool: number\nexport const p = Effect.acquireRelease(Effect.sync(function () { return pool }), () => Effect.void)',
    'import { Effect } from "effect"\nexport const p = Effect.acquireRelease(Effect.sync(() => new Map<string, number>()), () => Effect.void)',
  ],
  ["noEffectBind", false, 'import { Effect } from "effect"\nexport const b = Effect.bind("x", () => Effect.succeed(1))', 'import { Effect } from "effect"\nexport const b = Effect.map(Effect.succeed(1), (x) => ({ x }))'],
  ["noEffectBunTestItCall", true, 'import { it } from "effect-bun-test"\nit("runs", () => {})', 'import { Effect } from "effect"\nimport { it } from "effect-bun-test"\nit.effect("runs", () => Effect.void)'],
  ["noEffectDo", false, 'import { Effect } from "effect"\nexport const d = Effect.Do', 'import { Effect } from "effect"\nexport const d = Effect.gen(function* () {\n  return yield* Effect.succeed(1)\n})'],
  ["noLintEvasion", false, 'import { Option } from "effect"\nexport const s = Option.getOrUndefined(Option.none())', 'import { Option } from "effect"\nexport const s = Option.getOrElse(Option.none<number>(), () => 0)'],
  [
    "noManagedRuntimeInEffect",
    false,
    'import { Effect, Layer, ManagedRuntime } from "effect"\nexport const r = Effect.gen(function* () {\n  yield* Effect.void\n  return ManagedRuntime.make(Layer.empty)\n})',
    'import { Layer, ManagedRuntime } from "effect"\nexport const runtime = ManagedRuntime.make(Layer.empty)',
  ],
  [
    "noPerCallCacheConstruction",
    false,
    'import { Cache, Effect } from "effect"\nexport const c = Effect.fn("Fixture.cache")(function* () {\n  return yield* Cache.make({ capacity: 10, lookup: (key: string) => Effect.succeed(key) })\n})',
    'import { Cache, Effect } from "effect"\nexport const cache = Cache.make({ capacity: 10, lookup: (key: string) => Effect.succeed(key) })',
  ],
  ["noPointFreeLog", false, "export const log = (xs: ReadonlyArray<string>) => xs.forEach(console.log)", "export const log = (xs: ReadonlyArray<string>) => xs.forEach((x) => console.log(x))"],
  ["noReflectApply", false, "declare const f: () => number\nexport const v = Reflect.apply(f, globalThis, [])", "const Reflect = { apply: () => 1 }\nexport const v = Reflect.apply()"],
  [
    "noRepoTempDirectory",
    true,
    'import { Effect, FileSystem, Path } from "effect"\nexport const t = Effect.gen(function* () {\n  const fs = yield* FileSystem.FileSystem\n  const path = yield* Path.Path\n  return yield* fs.makeTempDirectoryScoped({ directory: path.resolve(import.meta.dir, "../.."), prefix: "x-" })\n})',
    'import { Effect, FileSystem } from "effect"\nexport const t = Effect.gen(function* () {\n  const fs = yield* FileSystem.FileSystem\n  return yield* fs.makeTempDirectoryScoped({ prefix: "x-" })\n})',
  ],
  ["noRunCollectOnUnboundedStream", false, 'import { Stream } from "effect"\nexport const s = Stream.repeat(Stream.make(1)).pipe(Stream.runCollect)', 'import { Stream } from "effect"\nexport const s = Stream.make(1, 2).pipe(Stream.runCollect)'],
  ["noSequentialEffectAll", false, 'import { Effect } from "effect"\nexport const s = Effect.all([Effect.void, Effect.void], { concurrency: 1, discard: true })', 'import { Effect } from "effect"\nexport const s = Effect.all([Effect.void, Effect.void], { concurrency: 2 })'],
  ["noSharedTestHome", true, 'export const env = { HOME: "/tmp" }', 'export const env = { HOME: "/nonexistent/home" }'],
  ["noSilentCatchAll", false, 'import { Effect } from "effect"\nexport const s = Effect.fail("x").pipe(Effect.catchAll(() => Effect.void))', 'import { Effect } from "effect"\nexport const s = Effect.fail("x").pipe(Effect.catchAll((error) => Effect.fail(error)))'],
  ["noUnknownTypeAliases", false, "export type Anything = unknown", "export type Name = string"],
  ["noWidenThenAssert", false, "const top: unknown = { value: 1 }\nexport const restored = top as { value: number }", "export const value = { value: 1 } satisfies { value: number }"],
  [
    "preferCatchTag",
    false,
    'import { Effect } from "effect"\ndeclare const f: Effect.Effect<never, { readonly _tag: "A" } | { readonly _tag: "B" }>\nexport const r = f.pipe(Effect.catchIf((e) => e._tag === "A", () => Effect.void))',
    'import { Effect } from "effect"\ndeclare const f: Effect.Effect<never, { readonly _tag: "A" } | { readonly _tag: "B" }>\nexport const r = f.pipe(Effect.catchTag("A", () => Effect.void))',
  ],
  ["requireForceKillAfter", false, 'import { ChildProcess } from "effect/process"\nexport const c = ChildProcess.make("git", ["status"])', 'import { ChildProcess } from "effect/process"\nexport const c = ChildProcess.make("git", ["status"], { forceKillAfter: "5 seconds" })'],
  ["requireSuppressionReason", false, "// oxlint-disable-next-line no-console\nconsole.log(1)", "// oxlint-disable-next-line no-console -- the fixture prints\nconsole.log(1)"],
]

const extensionOf = (inTests: boolean) => {
  if (inTests) return "test.ts"
  return "ts"
}

const HARD_CLASSES = ["mods/demo/", "cmd/demo/", "decider/", "scripts/", "tests/", "scenarios/", "lint/", "testbeds/demo/"]

const FENCES = [
  ["mods/kernel/fence.ts", 'import { readFileSync } from "node:fs"\nexport const read = readFileSync'],
  ["decider/fence.ts", 'import { createSignal } from "solid-js"\nexport const signal = createSignal'],
] as const

const OxlintReport = Schema.fromJsonString(
  Schema.Struct({ diagnostics: Schema.Array(Schema.Struct({ code: Schema.optionalKey(Schema.String), filename: Schema.String, severity: Schema.String })) }),
)

describe(`${HARD_CONFIG}: the hard rules`, () => {
  test.concurrent(
    "refuse each generated forbidden fixture in every path class, accept the allowed forms, and keep the import fences",
    () =>
      runScoped(
        Effect.gen(function* () {
          const root = yield* workspace()
          const fixtures = Arr.flatMap(HARD_RULES, ([rule, inTests, forbidden, accepted]) => {
            const extension = extensionOf(inTests)
            return Arr.flatMap(HARD_CLASSES, (folder) => [
              { file: `${folder}${rule}.forbidden.${extension}`, rule, text: forbidden, refused: true },
              { file: `${folder}${rule}.accepted.${extension}`, rule, text: accepted, refused: false },
            ])
          })
          for (const fixture of fixtures) put(root, fixture.file, `${fixture.text}\n`)
          for (const [file, text] of FENCES) put(root, file, `${text}\n`)
          const files = [...Arr.map(fixtures, (fixture) => fixture.file), ...Arr.map(FENCES, ([file]) => file)]
          const linted = yield* spawn([path.join(REAL, "node_modules/.bin/oxlint"), "--threads=3", "--format=json", "-c", HARD_CONFIG, ...files], root, CLI_TIMEOUT)
          expect({ code: linted.code, stderr: linted.stderr }).toEqual({ code: 1, stderr: "" })
          const diagnostics = Schema.decodeUnknownSync(OxlintReport)(linted.stdout).diagnostics
          const hard = new Set(Arr.map(HARD_RULES, ([rule]) => `effect(${rule})`))
          const errorsIn = (file: string) => Arr.filter(diagnostics, (diagnostic) => diagnostic.filename === file && diagnostic.severity === "error")
          const refused = Arr.map(fixtures, (fixture) => ({ file: fixture.file, rule: fixture.rule, hit: errorsIn(fixture.file).some((each) => each.code === `effect(${fixture.rule})`) }))
          expect(Arr.filter(refused, (each) => each.hit !== fixtures.some((fixture) => fixture.file === each.file && fixture.refused))).toEqual([])
          const acceptedHits = Arr.flatMap(fixtures, (fixture) => {
            if (fixture.refused) return []
            return Arr.filter(errorsIn(fixture.file), (each) => hard.has(each.code ?? ""))
          })
          expect(acceptedHits).toEqual([])
          for (const [file] of FENCES) expect(Arr.map(errorsIn(file), (each) => each.code)).toContain("eslint(no-restricted-imports)")
        }),
      ),
    TEST_TIMEOUT,
  )
})
