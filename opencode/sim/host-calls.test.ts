// No argument of a world plugin's host call stands without a law: every field,
// hook name, event type and choice a plugin the world loads passes to OpenCode's
// plugin context is one some host law (host-laws.ts) passes too, so the law runs
// it on the world and on real OpenCode alike. host-laws.test.ts holds every
// operation of the world's context to a law; this holds every argument.
//
// The calls are read through the compiler (host-calls.ts) on sim/tsconfig.json,
// whose program is what the world loads: the plugins' files are every file of it
// in this repository outside sim/ and its tests.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { type Call, open } from "./host-calls.ts"
import * as Seed from "./seed.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()
const CONFIG = `${ROOT}/sim/tsconfig.json`
const LAWS = `${ROOT}/sim/host-laws.ts`
const PLANTED = `${ROOT}/sim/fixtures/host-calls.fixture.ts`

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
const scanned = (pick: (files: ReadonlyArray<string>) => ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scanner = yield* open(CONFIG, ROOT)
      const laws = yield* scanner.calls(LAWS)
      const plugins = yield* Effect.forEach(pick(scanner.files), scanner.calls)
      return { files: scanner.files, laws, plugins: plugins.flat() }
    }),
  )

describe("every argument a world plugin passes to the host is one a law passes", () => {
  Seed.effect(
    "a planted plugin's arguments no law passes are found: through a spread, a narrowed view and a constant",
    Effect.gen(function* () {
      const { laws, plugins } = yield* scanned(() => [PLANTED])
      expect(laws.length).toBeGreaterThan(20)
      expect(unlawful(plugins, laws)).toEqual([
        'session.synthetic delivery="queue" at sim/fixtures/host-calls.fixture.ts:37',
        "session.prompt metadata at sim/fixtures/host-calls.fixture.ts:38",
        'session.compact reason="manual" at sim/fixtures/host-calls.fixture.ts:39',
        'session.hook #0="experimental.ws.send" at sim/fixtures/host-calls.fixture.ts:40',
      ])
      expect(plugins.map((call) => call.operation)).toEqual(["session.synthetic", "session.prompt", "session.compact", "session.hook", "session.get"])
    }),
  )

  Seed.effect(
    "no world plugin passes one no law passes",
    Effect.gen(function* () {
      const { files, laws, plugins } = yield* scanned((all) => all.filter(isPlugin))
      // The world loads wake, idle compaction, questions, the pool and the Anthropic login: each one's root is read.
      for (const root of ["cmd/wake/server.ts", "cmd/idle-compact/server.ts", "cmd/questions/server.ts", "cmd/pool/server.ts", "cmd/anthropic-auth/server.ts"])
        expect(files).toContain(`${ROOT}/${root}`)
      expect(plugins.length).toBeGreaterThan(50)
      expect(unlawful(plugins, laws)).toEqual([])
    }),
  )
})
