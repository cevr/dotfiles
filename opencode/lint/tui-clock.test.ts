// dotfiles/tui-clock-only (lint/tui-clock.ts), through the oxlint binary the
// gate runs, with the repository's own override (.oxlintrc.json): a planted
// `setInterval` in mods/prime/tui/ and a planted `Date.now()` in
// cmd/escape/setup.ts are refused, as is each form the rule's header lists;
// the clock's own calls, a property named like a timer, a dated `new Date(x)`
// and a test file are left alone, and a file outside the seam's folders is
// never read by the rule. Its test registers through sim-tui/effect-test.ts:
// lint resolves the fork's Effect, whose types are not effect-bun-test's.
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { platformTest } from "../sim-tui/effect-test.ts"

const CODE = "dotfiles(tui-clock-only)"
/** One oxlint run over a few files. */
const TIMEOUT_MS = 60_000

/** Each planted file, by its path under the tree, and how many diagnostics it must get. */
const FILES: ReadonlyArray<readonly [string, string, number]> = [
  ["mods/prime/tui/planted.tsx", "export const stop = setInterval(() => {}, 1000)", 1],
  ["cmd/escape/setup.ts", "export const at = Date.now()", 1],
  [
    "mods/prime/opencode/forms.ts",
    [
      "export const a = setTimeout(() => {}, 1)",
      "clearTimeout(a)",
      "globalThis.setInterval(() => {}, 1)",
      "export const b = performance.now()",
      "await Bun.sleep(1)",
      "export const c = Bun.nanoseconds()",
      "export const d = process.hrtime()",
      "export const e = new Date()",
      "setImmediate(() => {})",
    ].join("\n"),
    9,
  ],
  [
    "mods/escape/quiet.ts",
    [
      'import * as TuiClock from "@dotfiles/decider/tui-clock"',
      "export const a = TuiClock.now()",
      "TuiClock.once(5, () => {})",
      "export const b = { setTimeout: 1 }.setTimeout",
      "export const c = new Date(0)",
    ].join("\n"),
    0,
  ],
  ["cmd/prime/clock.test.ts", "export const a = Date.now()", 0],
  ["mods/other/free.ts", "export const a = Date.now()", 0],
]

const Override = Schema.Struct({ files: Schema.Array(Schema.String), rules: Schema.Record(Schema.String, Schema.Unknown) })
const Repo = Schema.fromJsonString(Schema.Struct({ overrides: Schema.Array(Override) }))
const Report = Schema.fromJsonString(Schema.Struct({ diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, filename: Schema.String })) }))
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("tui-clock-only", () => {
  platformTest(
    "it refuses a raw timer or clock in the seam's folders and nothing else",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)))
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "lint-tui-clock-" })
      for (const [file, code] of FILES) {
        yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
        yield* fs.writeFileString(path.join(dir, file), `${code}\n`)
      }
      const repo = yield* fs.readFileString(path.join(root, ".oxlintrc.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Repo)))
      const overrides = repo.overrides.filter((each) => "dotfiles/tui-clock-only" in each.rules)
      const config = path.join(dir, "oxlintrc.json")
      yield* fs.writeFileString(config, toJson({ jsPlugins: [path.join(root, "lint/test-env.ts")], overrides }))
      const command = ChildProcess.make(path.join(root, "node_modules/.bin/oxlint"), ["-c", config, "--format", "json", dir], { cwd: dir, stdin: "ignore", forceKillAfter: "3 seconds" })
      const child = yield* spawner.spawn(command)
      const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
      yield* child.exitCode
      const report = yield* Schema.decodeUnknownEffect(Report)(out)
      const found = new Map<string, number>()
      for (const diagnostic of report.diagnostics.filter((each) => each.code === CODE)) {
        const file = path.relative(dir, path.resolve(dir, diagnostic.filename))
        found.set(file, (found.get(file) ?? 0) + 1)
      }
      expect(FILES.map(([file]) => [file, found.get(file) ?? 0])).toEqual(FILES.map(([file, , errors]) => [file, errors]))
    }),
    TIMEOUT_MS,
  )
})
