// The commitment record's one output boundary (mods/orchestrate/printable.ts), held three ways: every secret kind at
// every place in a text comes out of `printable` with no fragment of it (sim/tokens.ts states the bound); every maker
// of an output (a refusal, a failure, the CLI's run, a defect's text) takes only what `printable` made, so a raw text
// does not compile; and the record's modules cut no text before the boundary and redact nowhere else.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Cause, Effect, Exit, FileSystem, Path, Predicate } from "effect"
import { type MemberExpression, parseSync, Visitor } from "oxc-parser"
import { whyOf } from "@dotfiles/opencode-orchestrate/commitments-tool"
import { printable } from "@dotfiles/opencode-orchestrate/printable"
import { RecordRefused } from "@dotfiles/opencode-orchestrate/record"
import { EvidenceRefused, RecordFailed } from "@dotfiles/opencode-orchestrate/service"
import { hostServices } from "../../sim/host-services.ts"
import { generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import { KINDS, LEAK_MIN, leaked, OFFSETS, type Placed, placements } from "../../sim/tokens.ts"
import { ranOf } from "./record.ts"

/** Every offset a value's text may have before a token, not only the sampled ones: 0 to 120 characters. */
const EVERY = Arr.range(0, 120)
/** Draws of each kind: a token's body is random, so a kind is tried on several. */
const DRAWS = 8

const drawsOf = KINDS.flatMap(([kind, draw]) => Arr.makeBy(DRAWS, (at) => [kind, draw(generator(`${kind}-${at}`))] as const))
/** Each kind at each placement, on `DRAWS` draws. */
const sampled: ReadonlyArray<readonly [string, Placed]> = drawsOf.flatMap(([kind, each]) => placements(each).map(([where, placed]): readonly [string, Placed] => [`${kind} ${where}`, placed]))
/** And at every offset from 0 to 120, after a space and glued. */
const cases: ReadonlyArray<readonly [string, Placed]> = [
  ...sampled,
  ...drawsOf.flatMap(([kind, each]) => [
    ...EVERY.map((n): readonly [string, Placed] => [`${kind} after ${n} letters`, { value: `${"a".repeat(n)} ${each.text}`, secrets: [each.secret] }]),
    ...EVERY.map((n): readonly [string, Placed] => [`${kind} glued after ${n}`, { value: `${"x1".repeat(n).slice(0, n)}${each.text}`, secrets: [each.secret] }]),
    ]),
]

/** The cases whose output holds a fragment of their secret: name and fragments. */
const leaksOf = (output: (value: string) => string, over = cases) =>
  over.flatMap(([name, placed]) => Arr.match(leaked(output(placed.value), placed), { onEmpty: () => [], onNonEmpty: (fragments) => [[name, fragments.slice(0, 2)] as const] }))

describe("printable", () => {
  test(`every secret kind at every placement and offset leaves no fragment of ${LEAK_MIN} characters (${KINDS.length} kinds)`, () => {
    expect(cases.length).toBeGreaterThan(KINDS.length * DRAWS * (2 * EVERY.length + OFFSETS.length))
    expect(leaksOf((value) => printable(value))).toEqual([])
  })

  test("each output maker passes it whole: a refusal, a failure, a tool's refusal, the CLI's refusal and a defect", () => {
    const outputs: ReadonlyArray<readonly [string, (value: string) => string]> = [
      ["a refusal", (value) => whyOf(new RecordRefused({ reason: printable(`the owner ${value} is not one token`) }))],
      ["a failure", (value) => whyOf(new RecordFailed({ message: printable(`record add: SQLiteError: CHECK constraint failed: ${value}`) }))],
      ["an evidence refusal", (value) => new EvidenceRefused({ reason: printable(`the receipt ${value} does not exist`) }).reason],
      ["a tool's refusal", (value) => whyOf(`follow_up: the id ${value} is taken`)],
      ["the CLI's answer", (value) => ranOf(Exit.succeed(printable(`commitments: ${value}`))).out],
      ["a defect, as the CLI prints it", (value) => ranOf(Exit.die(new Error(`SQLiteError: UNIQUE constraint failed: ${value}`))).err],
      ["a defect's cause", (value) => ranOf(Exit.die(new Error("the store failed", { cause: Cause.squash(Cause.die(value)) }))).err],
      ["a defect that is a bare text", (value) => ranOf(Exit.failCause(Cause.die(value))).err],
    ]
    expect(outputs.flatMap(([name, output]) => Arr.map(leaksOf(output, sampled), ([which]) => `${name}: ${which}`))).toEqual([])
  })

  test("the CLI prints a defect's words, past its secrets: the defect reaches the output, so the test above reads a real path", () => {
    const ran = ranOf(Exit.die(new Error("SQLiteError: database is locked")))
    expect<ReadonlyArray<string | number | boolean>>([ran.code, ran.err.includes("database is locked"), ran.out]).toEqual([1, true, ""])
  })

  test("an output maker takes only a printable text: a raw one does not compile", () => {
    const typecheckOnly = (raw: string) => [
      // @ts-expect-error -- the point of the test: a refusal's reason is printable, never a raw text
      new RecordRefused({ reason: raw }),
      // @ts-expect-error -- the point of the test: a failure's message is printable
      new RecordFailed({ message: raw }),
      // @ts-expect-error -- the point of the test: an evidence refusal's reason is printable
      new EvidenceRefused({ reason: raw }),
      // @ts-expect-error -- the point of the test: the CLI's answer is printable
      ranOf(Exit.succeed(raw)),
    ]
    expect(typecheckOnly).toBeFunction()
  })
})

/** The record's modules: every text they print leaves through `printable`. */
const SERVER = "cmd/orchestrate/server.ts"
const MODULES = [
  "mods/orchestrate/record.ts",
  "mods/orchestrate/commitments-tool.ts",
  "mods/orchestrate/reasons.ts",
  "mods/orchestrate/standing.ts",
  "mods/orchestrate/sqlite/record.ts",
  "mods/orchestrate/sqlite/ergo-register.ts",
  "cmd/orchestrate/record.ts",
  SERVER,
]
/** A check of the modules' texts, run as a test. */
const onTexts = (name: string, check: (textOf: (file: string) => string) => void) =>
  Seed.effect(
    name,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // Tests run from opencode/, the root the modules are named from (as scripts/no-prose-state.test.ts reads it).
      return yield* Effect.forEach(MODULES, (file) => Effect.map(fs.readFileString(path.resolve(file)), (text) => [file, text] as const))
    }).pipe(
      Effect.map((texts) => check((file) => Arr.join(Arr.map(Arr.filter(texts, ([name]) => name === file), ([, text]) => text), ""))),
      Effect.provide(hostServices),
    ),
  )

/** A cut inside a template's substitution: a text cut before it is printed. */
const CUT = /\$\{[^`}]*\.(?:slice|substring|substr)\(/g
/**
 * The cuts that stay, none of a caller's text: a commit hash the record validated (hex, 40), the day of an ISO time
 * the clock gave, a declared path's leading dot, and the store's own column list.
 */
const CUTS_KEPT: ReadonlyArray<readonly [string, string]> = [
  ["mods/orchestrate/commitments-tool.ts", '${keys.map(segment).join("").slice('],
  ["mods/orchestrate/commitments-tool.ts", "${held.commit.slice("],
  ["mods/orchestrate/sqlite/record.ts", "${COMMITMENT_COLUMNS.slice("],
  ["mods/orchestrate/sqlite/record.ts", "${isoOf(now).slice("],
]

const memberName = (node: MemberExpression): string => {
  if (!node.computed && node.property.type === "Identifier") return node.property.name
  if ("value" in node.property && Predicate.isString(node.property.value)) return node.property.value
  return ""
}

/** Throws, raw console and defect constructors escape the typed record boundary; catch aliases at their member access. */
const unsafeSinks = (file: string, text: string): ReadonlyArray<string> => {
  const sites: Array<string> = []
  const recordRanges = [
    [text.indexOf("const recordServices"), text.indexOf("const digest =")],
    [text.indexOf("const actorOf"), text.indexOf("name: Tools.ORCHESTRATE,")],
  ]
  const holdsRecord = (start: number) => file !== SERVER || recordRanges.some(([lo, hi]) => start >= lo && start < hi)
  new Visitor({
    ThrowStatement: (node) => sites.push(text.slice(node.start, node.end)),
    NewExpression: (node) => {
      if (!holdsRecord(node.start)) return
      const { callee } = node
      const raw = callee.type === "Identifier" && callee.name === "Error"
      const tool = callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "Tool" && memberName(callee) === "Error"
      if (raw || tool) sites.push(text.slice(node.start, node.end))
    },
    MemberExpression: (node) => {
      if (node.object.type !== "Identifier") return
      if (["console", "Console"].includes(node.object.name) || (["Effect", "Cause", "Exit"].includes(node.object.name) && memberName(node).startsWith("die")))
        sites.push(text.slice(node.start, node.end))
    },
    CallExpression: (node) => {
      if (!holdsRecord(node.start) || node.callee.type !== "MemberExpression" || node.callee.object.type !== "Identifier" || node.callee.object.name !== "Effect") return
      const field = memberName(node.callee)
      if (field.startsWith("log") || field.startsWith("annotateLogs"))
        sites.push(text.slice(node.start, node.end))
    },
  }).visit(parseSync(file, text).program)
  return sites
}

describe("the record's modules", () => {
  onTexts("cut no text inside a printed template: a cut before the boundary would leave a fragment too short to be known", (textOf) => {
    const cuts = MODULES.filter((file) => file !== SERVER).flatMap((file) => Arr.map([...textOf(file).matchAll(CUT)], (match): readonly [string, string] => [file, match[0]]))
    expect(cuts).toEqual([...CUTS_KEPT])
  })

  onTexts("redact only through printable: no second layer, no text redacted and then cut", (textOf) => {
    expect(Arr.filter(MODULES, (file) => textOf(file).includes("redact("))).toEqual([])
    expect(Arr.filter(MODULES, (file) => textOf(file).includes("opencode-digest/redact"))).toEqual([])
  })

  onTexts("log and print nothing but a printable text: the CLI's two prints are its run's printable output", (textOf) => {
    const prints = MODULES.flatMap((file) => unsafeSinks(file, textOf(file)).map((site) => `${file}: ${site}`))
    expect(prints).toEqual([
      "cmd/orchestrate/record.ts: Console.log",
      "cmd/orchestrate/record.ts: Console.error",
      `${SERVER}: Effect.logWarning(title, detail)`,
      `${SERVER}: new Tool.Error({ message: why })`,
    ])
    const cli = textOf("cmd/orchestrate/record.ts")
    expect([...cli.matchAll(/Console\.\w+\(([^)]*)\)/g)].map((match) => match[0])).toEqual(["Console.log(ran.out)", "Console.error(ran.err)"])
  })

  test("the sink guard refuses direct console, thrown errors and Effect defects in record tools", () => {
    const source = `const recordServices = (raw: string) => {
      const log = console.log
      log(raw)
      Effect.logWarning(raw)
      if (raw) throw new Error(raw)
      return Effect["die"](raw)
    }
    const digest = {}`
    expect(unsafeSinks(SERVER, source)).toEqual(["console.log", "Effect.logWarning(raw)", "throw new Error(raw)", "new Error(raw)", 'Effect["die"]'])
  })
})
