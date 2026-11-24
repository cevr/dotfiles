// No argument of a world plugin's host call stands without a law: every field,
// hook name, event type and choice a plugin the world loads passes to OpenCode's
// plugin context is one some host law (host-laws.ts) passes too, so the law runs
// it on the world and on real OpenCode alike. host-laws.test.ts holds every
// operation of the world's context to a law; this holds every argument.
//
// The calls are read through the compiler (host-calls.ts) on sim/tsconfig.json,
// whose program is what the world loads: the plugins' files are every file of it
// in this repository outside sim/ and its tests.
// The wider compiler project reads all shipped server plugin adapters, even
// ones the world does not load, and requires every operation to have a law.
// @reads cmd/**/*.ts cmd/**/*.tsx mods/**/*.ts mods/**/*.tsx sim/tsconfig.host-calls.json
import { describe, expect } from "bun:test"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Effect, FileSystem } from "effect"
import { type Call, open } from "./host-calls.ts"
import { LAWS as DECLARED_LAWS } from "./host-laws.ts"
import { simulationTest } from "./seed.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()
const CONFIG = `${ROOT}/sim/tsconfig.json`
const ALL_ADAPTERS = `${ROOT}/sim/tsconfig.host-calls.json`
const LAWS = `${ROOT}/sim/host-laws.ts`
const PLANTED = `${ROOT}/sim/fixtures/host-calls.fixture.ts`
const PLANTED_OPERATIONS = `${ROOT}/sim/fixtures/host-operations.fixture.ts`
/**
 * The plugins the world loads, which the program holds. Named here so the gate's cache key for this file
 * (scripts/reach.ts follows a named file, not the compiler's program) covers every plugin it reads: a changed
 * host call re-runs it.
 */
const WORLD = `${ROOT}/sim/plugins.ts`

/** A file of a world plugin: in this repository, outside sim/, not a test. */
const isPlugin = (file: string) =>
  file.startsWith(`${ROOT}/`) && !file.includes("/node_modules/") && !file.startsWith(`${ROOT}/sim/`) && !/\.test\.tsx?$/.test(file)

/** Each fact of `calls` no law call of its operation passes, as `<operation> <fact> at <file>:<line>`. */
const unlawful = (calls: ReadonlyArray<Call>, laws: ReadonlyArray<Call>) => {
  const passed = new Set(laws.flatMap((call) => call.facts.map((fact) => `${call.operation} ${fact}`)))
  return calls.flatMap((call) =>
    call.facts.filter((fact) => !passed.has(`${call.operation} ${fact}`)).map((fact) => `${call.operation} ${fact} at ${call.file.slice(ROOT.length + 1)}:${call.line}`),
  )
}

/** The host calls of the laws, of the files `pick` keeps, and of the planted plugin. */
const scanned = (config: string, pick: (files: ReadonlyArray<string>) => ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scanner = yield* open(config, ROOT)
      const laws = yield* scanner.calls(LAWS)
      const plugins = yield* Effect.forEach(pick(scanner.files), scanner.calls)
      return { files: scanner.files, laws, plugins: plugins.flat() }
    }),
  )

describe("every argument a world plugin passes to the host is one a law passes", () => {
  simulationTest(
    "a planted plugin's arguments no law passes are found: through a spread, a narrowed view and a constant",
    Effect.gen(function* () {
      const { laws, plugins } = yield* scanned(CONFIG, () => [PLANTED])
      expect(laws.length).toBeGreaterThan(20)
      expect(unlawful(plugins, laws)).toEqual([
        'session.synthetic delivery="queue" at sim/fixtures/host-calls.fixture.ts:37',
        "session.prompt metadata at sim/fixtures/host-calls.fixture.ts:38",
        'session.compact reason="manual" at sim/fixtures/host-calls.fixture.ts:39',
        'session.hook #0="experimental.ws.handshake" at sim/fixtures/host-calls.fixture.ts:40',
      ])
      expect(plugins.map((call) => call.operation)).toEqual(["session.synthetic", "session.prompt", "session.compact", "session.hook", "session.get"])
    }),
  )

  simulationTest(
    "no world plugin passes one no law passes",
    Effect.gen(function* () {
      const { files, laws, plugins } = yield* scanned(CONFIG, (all) => all.filter(isPlugin))
      expect(files).toContain(WORLD)
      // The world loads wake, idle compaction, questions, the pool and the Anthropic login: each one's root is read.
      for (const root of ["cmd/wake/server.ts", "cmd/idle-compact/server.ts", "cmd/questions/server.ts", "cmd/pool/server.ts", "cmd/anthropic-auth/server.ts"])
        expect(files).toContain(`${ROOT}/${root}`)
      expect(plugins.length).toBeGreaterThan(50)
      expect(unlawful(plugins, laws)).toEqual([])
    }),
  )
})

const declared = new Set<string>(DECLARED_LAWS.flatMap(({ operations }) => operations))
const operationHasLaw = (operation: string, exercised: ReadonlySet<string>) =>
  exercised.has(operation) && [...declared].some((path) => operation === path || operation.startsWith(`${path}.`))

const unruled = (calls: ReadonlyArray<Call>, laws: ReadonlyArray<Call>) => {
  const exercised = new Set(laws.map(({ operation }) => operation))
  return calls.filter(({ operation }) => !operationHasLaw(operation, exercised))
}

simulationTest("every server plugin host operation has a declared, exercised law, even with no argument facts", Effect.gen(function* () {
  const { files, laws, plugins } = yield* scanned(ALL_ADAPTERS, (all) => [
    PLANTED_OPERATIONS,
    ...all.filter(isPlugin),
  ])
  // These adapters weren't in the World project and used to escape the law check.
  expect(files).toContain(`${ROOT}/cmd/image/server.ts`)
  expect(files).toContain(`${ROOT}/cmd/skills/server.ts`)
  expect(plugins.some(({ operation }) => operation === "permission.assert")).toBe(true)
  expect(plugins.some(({ operation }) => operation === "skill.reload")).toBe(true)
  const failures = unruled(plugins, laws)
  const planted = failures.filter(({ file }) => file === PLANTED_OPERATIONS)
  expect(planted.map(({ operation, facts }) => [operation, facts])).toEqual([
    ["plugin.list", []],
    ["reference.reload", []],
    ["command.reload", []],
    ["reference.transform", []],
  ])
  expect(failures.filter(({ file }) => file !== PLANTED_OPERATIONS).map(({ operation, file, line }) =>
    `${operation} at ${file.slice(ROOT.length + 1)}:${line}`,
  )).toEqual([])
}))

simulationTest("the host scan fails if a new adapter cannot resolve or type its host context", Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "host-context-unresolved-" })
  const config = `${scratch}/tsconfig.json`
  yield* fs.writeFileString(config, `{"extends":"${ALL_ADAPTERS}","files":["./adapter.ts","./bad-context.ts"]}`)
  yield* fs.writeFileString(`${scratch}/adapter.ts`, `
    import type { Plugin } from "@opencode/plugin/effect"
    export const refresh = (ctx: Plugin.Context) => ctx.command.reload()
  `)
  yield* fs.writeFileString(`${scratch}/bad-context.ts`, `
    type Host = Parameters<typeof import("${PLANTED_OPERATIONS}").planted>[0]
    export const refresh = (ctx: Host["MissingContext"]) => ctx.command.reload()
  `)
  const failure = yield* Effect.flip(open(config, ROOT).pipe(Effect.as("the scanner accepted an untyped adapter")))
  expect(failure.message).toContain("adapter.ts:2")
  expect(failure.message).toContain("Cannot find module '@opencode/plugin/effect'")
  expect(failure.message).toContain("bad-context.ts:3")
  expect(failure.message).toContain("Property 'MissingContext' does not exist")
}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)))
