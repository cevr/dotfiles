/**
 * Test isolation at its two seams. At the lint CLI: `.oxlintrc.json` refuses every generated
 * test-global write (process.env and the global objects, by assignment, update, delete or the
 * Object and Reflect writers) in every test path class and position, and implicit runner globals,
 * while it accepts a child's own env object and shadowed names. At run time: the test files that
 * used to write the process's env or global registry run in a child `bun test` under generated
 * parent envs, a preload records the env and the registry around every test, and none moves.
 *
 * Known misses of `effect/noTestGlobals` (oxlint-plugin-effect 0.32.1), never promised here: a
 * computed env root (`process["env"]`) and an alias (`const env = process.env; env.X = ...`). The
 * repo's own `dotfiles/no-module-env-in-tests` still refuses the computed root while a test file
 * loads; that retained coverage is asserted, the alias is not.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Array as Arr, Effect, Schema, type Scope } from "effect"
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
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "effect-isolation-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const put = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

const HardConfig = Schema.fromJsonString(Schema.Struct({ settings: Schema.Struct({ effect: Schema.Struct({ testFiles: Schema.Array(Schema.String) }) }) }))

/** The real hard config, its plugins reached at their real paths from a scratch workspace. */
const hardConfigText = () => readFileSync(path.join(REAL, HARD_CONFIG), "utf8").replaceAll('"./lint/', `"${path.join(REAL, "lint")}/`)

/** A concrete path each `effect.testFiles` glob matches. */
const concrete = (glob: string) => glob.replaceAll("**/", "deep/er/").replaceAll("**", "deep/er/demo.ts").replaceAll("*", "demo")

/** Every class of test path the policy promises to protect: test and spec modules anywhere, and each configured test glob. */
const testClasses = () => [
  "mods/demo/model.test.ts",
  "cmd/demo/tui.test.tsx",
  "scripts/demo.spec.ts",
  "decider/demo.test.ts",
  "root.spec.tsx",
  ...Arr.map(Schema.decodeUnknownSync(HardConfig)(readFileSync(path.join(REAL, HARD_CONFIG), "utf8")).settings.effect.testFiles, concrete),
]

const ENV_TARGETS = ["process.env.ISOLATION_KEY", 'process.env["ISOLATION_KEY"]', "process.env[key]"]
const GLOBAL_TARGETS = ["globalThis.isolationKey", "global.isolationKey", "window.isolationKey", "self.isolationKey", 'globalThis["isolationKey"]', "globalThis[key]"]
const ROOTS = ["process.env", "globalThis", "global", "window", "self"]

/** Each forbidden write, one line: a direct write to an env key or a global, or an Object or Reflect writer on a global root. */
const FORBIDDEN = [
  ...Arr.flatMap([...ENV_TARGETS, ...GLOBAL_TARGETS], (target) => [`${target} = "synthetic"`, `${target} += "synthetic"`, `${target} ??= "synthetic"`, `${target}++`, `delete ${target}`]),
  ...Arr.flatMap(ROOTS, (root) => [
    `Object.assign(${root}, { ISOLATION_KEY: "synthetic" })`,
    `Object.defineProperty(${root}, "ISOLATION_KEY", { value: "synthetic" })`,
    `Object.defineProperties(${root}, { ISOLATION_KEY: { value: "synthetic" } })`,
    `Reflect.set(${root}, "ISOLATION_KEY", "synthetic")`,
    `Reflect.defineProperty(${root}, "ISOLATION_KEY", { value: "synthetic" })`,
    `Reflect.deleteProperty(${root}, "ISOLATION_KEY")`,
  ]),
]

/** Writes to a child's own env object or to shadowed names, each in a block of its own: not the process's state, so never refused. */
const ACCEPTED = [
  ['const env = { ...process.env, ISOLATION_KEY: "synthetic" }', 'env.ISOLATION_KEY = "other"', "delete env.ISOLATION_KEY", 'Object.assign(env, { ISOLATION_KEY: "synthetic" })', 'Bun.spawnSync(["true"], { env })'],
  ['const process = { env: { ISOLATION_KEY: "" } }', 'process.env.ISOLATION_KEY = "synthetic"', 'Object.assign(process.env, { ISOLATION_KEY: "synthetic" })'],
  ['const globalThis = { isolationKey: "" }', 'globalThis.isolationKey = "synthetic"', 'Reflect.set(globalThis, "isolationKey", "synthetic")'],
  ["const window = { isolationKey: 0 }", "window.isolationKey++", "delete window.isolationKey"],
  ["const read = process.env.ISOLATION_KEY", "const own = { ...globalThis }", "own.isolationKey = read"],
]

const POSITIONS = ["module", "describe", "test", "helper"] as const
type Position = (typeof POSITIONS)[number]

/** How a fixture reaches the runner: imported from `bun:test`, or through the runner's implicit globals. */
const RUNNERS = { imported: 'import { describe, expect, test } from "bun:test"', implicit: "" } as const
type Runner = keyof typeof RUNNERS

/** The lines that open and close a block at `position`, the `index`th of its file. */
const wrap = (position: Position, index: number): readonly [open: string, close: string] =>
  (({
    module: ["{", "}"],
    describe: [`describe("suite ${index}", () => {`, "})"],
    test: [`test("writes ${index}", () => {`, "})"],
    helper: [`export const helper${index} = () => {`, "}"],
  }) as const)[position]

/** A file of blocks, each at a generated position, and the line span of each block's body. */
const fixtureFile = (random: ReturnType<typeof generator>, runner: Runner, blocks: ReadonlyArray<ReadonlyArray<string>>) => {
  const lines = [RUNNERS[runner], 'const key = "ISOLATION_KEY"', 'test("runs", () => expect(key).toBe("ISOLATION_KEY"))']
  const spans = Arr.map(blocks, (body, index) => {
    const position = random.pick(POSITIONS)
    const [open, close] = wrap(position, index)
    lines.push(open, ...Arr.map(body, (line) => `  ${line}`), close)
    return { body, position, first: lines.length - body.length, last: lines.length - 1 }
  })
  return { text: `${lines.join("\n")}\n`, spans }
}

const OxlintReport = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.optionalKey(Schema.String),
        filename: Schema.String,
        message: Schema.String,
        severity: Schema.String,
        labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Number }) })),
      }),
    ),
  }),
)

const RUNNER_GLOBAL = /^Import \w+ from your test library/u

/** Lints `files` in `root` with the real hard config: the errors of one rule in one file. */
const lint = Effect.fn("EffectIsolationTest.lint")(function* (root: string, files: ReadonlyArray<string>) {
  const linted = yield* spawn([path.join(REAL, "node_modules/.bin/oxlint"), "--threads=3", "--format=json", "-c", HARD_CONFIG, ...files], root, CLI_TIMEOUT)
  expect({ stderr: linted.stderr }).toEqual({ stderr: "" })
  const diagnostics = Schema.decodeUnknownSync(OxlintReport)(linted.stdout).diagnostics
  return (file: string, code: string) => Arr.filter(diagnostics, (each) => each.filename === file && each.code === code && each.severity === "error")
})

const lineOf = (diagnostic: { readonly labels: ReadonlyArray<{ readonly span: { readonly line: number } }> }) => diagnostic.labels[0]?.span.line ?? 0

/** One workspace per runner form, so each test path class (a configured helper path is one exact file) is linted under both. */
const lintRunner = Effect.fn("EffectIsolationTest.lintRunner")(function* (runner: Runner, seed: number) {
  const root = yield* scratch
  put(root, HARD_CONFIG, hardConfigText())
  const random = generator(seed)
  const forbidden = Arr.map(FORBIDDEN, (line) => [line])
  const fixtures = Arr.map(testClasses(), (file) => ({ file, forbidden: fixtureFile(random, runner, forbidden), accepted: fixtureFile(random, runner, ACCEPTED) }))
  const outside = { file: "mods/demo/outside.ts", ...fixtureFile(random, runner, forbidden) }
  for (const fixture of fixtures) {
    put(root, fixture.file, fixture.forbidden.text)
    put(root, fixture.file.replace(/(\.[^./]+)$/u, ".accepted$1"), fixture.accepted.text)
  }
  put(root, outside.file, outside.text)
  const errors = yield* lint(root, [...Arr.flatMap(fixtures, ({ file }) => [file, file.replace(/(\.[^./]+)$/u, ".accepted$1")]), outside.file])
  const writes = (file: string) => Arr.filter(errors(file, "effect(noTestGlobals)"), (each) => !RUNNER_GLOBAL.test(each.message))
  const runnerGlobals = (file: string) => Arr.filter(errors(file, "effect(noTestGlobals)"), (each) => RUNNER_GLOBAL.test(each.message))
  const missed = Arr.flatMap(fixtures, ({ file, forbidden: { spans } }) => {
    const hit = new Set(Arr.map(writes(file), lineOf))
    return Arr.map(
      Arr.filter(spans, (span) => !hit.has(span.first)),
      ({ body, position }) => ({ file, write: body.join(" "), position }),
    )
  })
  const refused = Arr.flatMap(fixtures, ({ file, accepted: { spans } }) => {
    const accepted = file.replace(/(\.[^./]+)$/u, ".accepted$1")
    return Arr.map(writes(accepted), (each) => ({ file: accepted, line: lineOf(each), span: Arr.findFirst(spans, (span) => span.first <= lineOf(each) && lineOf(each) <= span.last) }))
  })
  const runnerForms = Arr.map(fixtures, ({ file }) => ({ file, implicit: runnerGlobals(file).length > 0 }))
  return {
    missed,
    refused,
    outside: errors(outside.file, "effect(noTestGlobals)").length,
    wrongRunner: Arr.filter(runnerForms, ({ implicit }) => implicit !== (runner === "implicit")),
    positions: new Set(Arr.flatMap(fixtures, ({ forbidden: { spans } }) => Arr.map(spans, (span) => span.position))),
  }
})

describe(`${HARD_CONFIG}: effect/noTestGlobals over generated fixtures`, () => {
  test.concurrent(
    "refuses every forbidden write in every test path class, position and runner form; accepts a child's env and shadowed names; leaves non-test code to other rules",
    () =>
      runScoped(
        Effect.gen(function* () {
          for (const runner of ["imported", "implicit"] as const) {
            const found = yield* lintRunner(runner, 20261112)
            expect({ runner, missed: found.missed, refused: found.refused, outside: found.outside, wrongRunner: found.wrongRunner }).toEqual({
              runner,
              missed: [],
              refused: [],
              outside: 0,
              wrongRunner: [],
            })
            expect(found.positions).toEqual(new Set(POSITIONS))
          }
        }),
      ),
    TEST_TIMEOUT,
  )

  test.concurrent(
    "the repo's own rule still refuses the computed env root noTestGlobals misses, while a test file loads",
    () =>
      runScoped(
        Effect.gen(function* () {
          const root = yield* scratch
          put(root, HARD_CONFIG, hardConfigText())
          const files = ["mods/demo/computed.test.ts", "cmd/demo/computed.test.tsx"]
          for (const file of files)
            put(root, file, `${RUNNERS.imported}\nprocess["env"].ISOLATION_KEY = "synthetic"\nObject.assign(process["env"], { ISOLATION_KEY: "synthetic" })\ntest("runs", () => expect(1).toBe(1))\n`)
          const errors = yield* lint(root, files)
          for (const file of files) expect({ file, found: errors(file, "dotfiles(no-module-env-in-tests)").length }).toEqual({ file, found: 2 })
        }),
      ),
    TEST_TIMEOUT,
  )
})

/** The keys a fixture used to write, and a synthetic one: each test of a suite must find them as its parent env gave them. */
const WATCHED = [
  "HOME",
  "XDG_STATE_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EFFECT_ISOLATION_PROBE",
]

const MISSING = "<missing>"

/** The preload each child run loads: around every test it records the watched env and whether the process registry exists, and it can fail every test after recording. */
const PRELOAD = `import { afterEach, beforeEach } from "bun:test"
import { appendFileSync } from "node:fs"
const out = process.env.EFFECT_ISOLATION_OUT
const record = (when) => appendFileSync(out, JSON.stringify({ when, registry: Reflect.has(globalThis, Symbol.for("opencode.credential-sources")), env: Object.fromEntries([${Arr.map(WATCHED, (key) => `"${key}"`).join(", ")}].map((key) => [key, process.env[key] ?? "${MISSING}"])) }) + "\\n")
beforeEach(() => record("before"))
afterEach(() => {
  record("after")
  if (process.env.EFFECT_ISOLATION_FAIL === "fail") throw new Error("injected failure")
})
`

/** The suites whose fixtures used to write the process's env or registry, and the tests of each that build them. */
const SUITES = [
  { file: "./scripts/daily.test.ts", only: ["-t", "the upstream merge"], registry: false },
  { file: "./cmd/pool/server.test.ts", only: [], registry: false },
  { file: "./mods/anthropic-auth/registry/credential-sources.test.ts", only: [], registry: true },
] as const

const Snapshot = Schema.fromJsonString(Schema.Struct({ when: Schema.String, registry: Schema.Boolean, env: Schema.Record(Schema.String, Schema.String) }))

/** A git config that breaks every commit, push and receive that reads it: a fixture leaking the parent's git config goes red. */
const hostileGit = (hooks: string) => `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/loop-probe-x\n[core]\n\thooksPath = ${hooks}\n`

const OUTCOMES = { pass: 0, fail: 1 } as const

/** One generated parent env: each optional key present with a synthetic value or missing, under a scratch HOME whose git config is hostile, and a run that passes or fails. */
const variant = (seed: number, dir: string) => {
  const random = generator(seed)
  const home = path.join(dir, "home")
  const hooks = path.join(dir, "hooks")
  for (const folder of [home, hooks]) mkdirSync(folder, { recursive: true })
  const hostile = path.join(dir, "hostile.gitconfig")
  for (const file of [hostile, path.join(home, ".gitconfig")]) writeFileSync(file, hostileGit(hooks))
  for (const hook of ["pre-commit", "commit-msg", "pre-push", "pre-receive", "update"]) writeFileSync(path.join(hooks, hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const optional = [
    ["XDG_STATE_HOME", path.join(dir, "state")],
    ["GIT_CONFIG_GLOBAL", hostile],
    ["GIT_AUTHOR_NAME", `synthetic-${random.int(1000)}`],
    ["EFFECT_ISOLATION_PROBE", `probe-${random.int(1000)}`],
  ] as const
  const present = Arr.filter(optional, () => random.int(2) === 0)
  const env = new Map<string, string>([["HOME", home], ...present])
  return { home, env, outcome: random.pick(["pass", "fail"] as const), state: path.join(dir, "state") }
}

/** Bun and the usual homes of git: the child's whole PATH, so nothing of the parent's env reaches it. */
const CHILD_PATH = [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":")

/** The watched keys a record holds that differ from what the parent gave. */
const movedKeys = (given: ReadonlyMap<string, string>, record: typeof Snapshot.Type) =>
  Arr.filter(WATCHED, (key) => record.env[key] !== (given.get(key) ?? MISSING))

/** Runs one suite in a child `bun test` with a clean env of the variant's keys, and checks what its preload recorded. */
const runSuite = Effect.fn("EffectIsolationTest.runSuite")(function* (seed: number, suite: (typeof SUITES)[number]) {
  const dir = yield* scratch
  const preload = path.join(dir, "preload.ts")
  const out = path.join(dir, "records.jsonl")
  put(dir, "preload.ts", PRELOAD)
  writeFileSync(out, "")
  const run = variant(seed, dir)
  const assignments = Arr.map([["PATH", CHILD_PATH], ["TMPDIR", tmpdir()], ...run.env, ["EFFECT_ISOLATION_OUT", out], ["EFFECT_ISOLATION_FAIL", run.outcome]], ([key, value]) => `${key}=${value}`)
  const answer = yield* spawn(["env", "-i", ...assignments, process.execPath, "test", "--timeout", "60000", "--preload", preload, suite.file, ...suite.only], REAL, CLI_TIMEOUT)
  const records = Arr.map(
    Arr.filter(readFileSync(out, "utf8").split("\n"), (line) => line !== ""),
    (line) => Schema.decodeUnknownSync(Snapshot)(line),
  )
  const label = { seed, suite: suite.file, outcome: run.outcome }
  expect({ ...label, code: answer.code, ran: records.length > 1 }).toEqual({ ...label, code: OUTCOMES[run.outcome], ran: true })
  expect({ ...label, moved: Arr.filter(records, (record) => movedKeys(run.env, record).length > 0) }).toEqual({ ...label, moved: [] })
  expect({ ...label, installed: Arr.filter(records, (record) => suite.registry && record.registry) }).toEqual({ ...label, installed: [] })
  const tallies = [path.join(run.state, "opencode-pool/limits.json"), path.join(run.home, ".local/state/opencode-pool/limits.json")]
  expect({ ...label, written: Arr.filter(tallies, existsSync) }).toEqual({ ...label, written: [] })
})

describe("the fixtures that wrote the process's env or registry, under generated parent envs", () => {
  test.concurrent(
    "keep every watched key as the parent gave it, present or missing, install no registry and write no limit tally, whether the run passes or fails",
    () =>
      runScoped(
        Effect.forEach(
          Arr.flatMap(Arr.range(1, 4), (seed) => Arr.map(SUITES, (suite) => [seed, suite] as const)),
          ([seed, suite]) => runSuite(seed, suite),
          { concurrency: 3, discard: true },
        ),
      ),
    TEST_TIMEOUT,
  )
})
