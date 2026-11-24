// @reads tests/** sim/** sim-tui/** scripts/** scenarios/** testbeds/** cmd/**
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Path, Predicate } from "effect"
import { it } from "effect-bun-test"
import { type CallExpression, parseSync, Visitor } from "oxc-parser"
import { hangGuard } from "../tests/hang-guard.ts"
import { codeOf, importsOf, load, ROOT } from "./reach.ts"
import { testHostEnv, testHostOptions } from "./test-host.ts"

/** Match native boundaries, not every subprocess (e.g. git) or use of a simulated client. */
const sdkCreate = /(?:^|\.)(?:OpenCode|EmbeddedHost|host)\.create$/
const processStart = /(?:^|\.)(?:spawn(?:Sync)?|make|serve|run|runOne|runSync|owned)$/
const cliArgv = /(?:["'](?:opencode2?|opencode-drive|serve|--standalone)["']|packages\/cli\/src\/index\.ts)/
const policyImport = /(?:^|\/)test-host\.ts$/
const driverImport = /(?:^|\/)test-driver\.ts$/
const usesForkLaunch = /(?:^|\/)gamut(?:\/gamut)?\.ts$/
const cliFlags = /\bOPENCODE_(?:DISABLE_FILEWATCHER|FILEWATCHER_DISABLE)\b/
const driverArgv = /["']opencode-drive["']/

type Located = { readonly start: number; readonly end: number }
type Arg = CallExpression["arguments"][number]
type Source = (node: Located) => string

const optIn = (callee: string, [first, second, third]: ReadonlyArray<Arg>, driver: boolean) => {
  if (callee === "testHostEnv") return first
  if (callee === "testHostOptions") return second
  if (driver && callee === "OpenCodeDriver.use") return third
}

const hasReason = (reason: Arg, text: Source): boolean => {
  if (reason.type !== "ObjectExpression" || reason.properties.length !== 1) return false
  return reason.properties.some((property) =>
    property.type === "Property" && text(property.key) === "fileWatching" &&
    property.value.type === "Literal" && Predicate.isString(property.value.value) && property.value.value.trim() !== "")
}

const hasSdkPolicy = (policy: boolean, text: Source, first?: Arg) =>
  policy && first?.type === "CallExpression" && text(first.callee) === "testHostOptions"

const violations = (file: string, source: string): ReadonlyArray<string> => {
  const errors: Array<string> = []
  const imports = importsOf(file, source)
  const policy = imports.some((path) => policyImport.test(path))
  const driver = imports.some((path) => driverImport.test(path))
  const owned = imports.some((path) => /(?:^|\/)owned\.ts$/.test(path))
  const launch = imports.some((path) => usesForkLaunch.test(path))
  const code = codeOf(file, source)
  const addsPolicy = policy && /\.\.\.testHostEnv\s*\(/.test(code)
  const launchEnv = launch && (/\.\.\.launch\.env\b/.test(code) || /\brunEnv\s*\(/.test(code))
  const ast = parseSync(file, source)
  const report = (start: number, message: string) => errors.push(`${file}:${source.slice(0, start).split("\n").length}: ${message}`)
  const text: Source = (node) => source.slice(node.start, node.end)
  const inspectCli = (node: CallExpression, callee: string) => {
    if (addsPolicy || !processStart.test(callee) || (owned && callee === "owned")) return
    const argv = node.arguments.find((arg) => arg.type === "ArrayExpression" && cliArgv.test(text(arg)))
    if (Predicate.isNotUndefined(argv) && (driverArgv.test(text(argv)) || !launchEnv))
      report(node.start, "start native CLI hosts through owned, forkLaunch/runEnv, or testHostEnv")
  }
  new Visitor({
    ImportDeclaration(node) {
      if (node.source.value === "opencode-drive" && node.specifiers.some((specifier) => specifier.type === "ImportSpecifier" && text(specifier.imported) === "OpenCodeDriver"))
        report(node.start, "use scenarios/test-driver.ts instead of the native driver")
    },
    CallExpression(node) {
      const callee = text(node.callee)
      if (sdkCreate.test(callee) && !hasSdkPolicy(policy, text, node.arguments[0]))
        report(node.start, "wrap native SDK options in testHostOptions")
      const reason = optIn(callee, node.arguments, driver)
      if (Predicate.isNotUndefined(reason) && !hasReason(reason, text))
        report(reason.start, "give fileWatching a nonempty literal reason at the host call")
      inspectCli(node, callee)
    },
    Identifier(node) {
      if (cliFlags.test(node.name)) report(node.start, "set CLI watcher flags only in testHostEnv")
    },
    Literal(node) {
      if (Predicate.isString(node.value) && cliFlags.test(node.value)) report(node.start, "set CLI watcher flags only in testHostEnv")
    },
    Property(node) {
      if (/^["']?filewatcher["']?$/.test(text(node.key))) report(node.start, "set SDK filewatcher only in testHostOptions")
      if (/^["']?OPENCODE_DB["']?$/.test(text(node.key)) && !addsPolicy && !launchEnv && !owned)
        report(node.start, "build the scratch host environment through forkLaunch/runEnv, owned, or testHostEnv")
    },
  }).visit(ast.program)
  return errors
}

test("both native entry paths default off, and a reason explicitly enables watching", () => {
  const keys = ["OPENCODE_FILEWATCHER_DISABLE", "OPENCODE_DISABLE_FILEWATCHER"] as const
  const enabled = { fileWatching: "The fixture edits a loaded plugin and waits for reload." }
  expect(keys.map((key) => testHostEnv()[key])).toEqual(["1", "1"])
  expect(keys.map((key) => testHostEnv(enabled)[key])).toEqual(["0", "0"])
  expect(testHostOptions({ fs: { fff: false }, port: 0 })).toEqual({ fs: { fff: false, filewatcher: false }, port: 0 })
  expect(testHostOptions({}, enabled).fs.filewatcher).toBe(true)
  expect(testHostEnv({ fileWatching: "  " })).toEqual(testHostEnv())
})

test("the scanner rejects new native bypasses and undocumented opt-ins", () => {
  expect(violations("tests/fixture.ts", `
    import { testHostOptions } from "../scripts/test-host.ts"
    OpenCode.create({})
    Bun.spawn(["opencode2", "serve"])
    OpenCode.create(testHostOptions({}, { fileWatching: "" }))
  `)).toEqual([
    "tests/fixture.ts:3: wrap native SDK options in testHostOptions",
    "tests/fixture.ts:4: start native CLI hosts through owned, forkLaunch/runEnv, or testHostEnv",
    "tests/fixture.ts:5: give fileWatching a nonempty literal reason at the host call",
  ])
})

it.live.layer(BunServices.layer)("native test hosts use the shared watcher policy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // The two boundaries implement the policy and its driver adapter. This scanner contains negative fixtures.
    const boundaries = ["scripts/test-host.ts", "scripts/test-host.test.ts", "scenarios/test-driver.ts"]
    const { files } = yield* Effect.promise(load)
    const sources = files.filter((file) => /^(?:tests|sim|sim-tui|scripts|scenarios|testbeds|cmd)\/.*\.[cm]?[jt]sx?$/.test(file) && !boundaries.includes(file))
    const errors = yield* Effect.forEach(sources, (file) =>
      fs.readFileString(path.join(ROOT, file)).pipe(Effect.map((source) => violations(file, source))))
    expect(errors.flat()).toEqual([])
  }),
  hangGuard("process-tree"),
)
