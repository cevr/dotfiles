// dotfiles/tui-dirs-only (lint/tui-dirs.ts), through the oxlint binary the
// gate runs, with the repository's own overrides (.oxlintrc.json): a planted
// `homedir()` or `process.env.HOME` anywhere in mods/ and cmd/ (a TUI
// filestore, a TUI or a server composition root, a server store) is refused,
// as is each form the rule's header lists; the seam's own reads, other
// variables, a property named like one, a test file and a pool peer's SSH
// program are left alone, and a file outside mods/ and cmd/ (sim/, the seam
// itself) is never read by the rule. Its test registers through
// sim-tui/effect-test.ts: lint resolves the fork's Effect, whose types are not
// effect-bun-test's.
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { platformTest } from "../sim-tui/effect-test.ts"

const CODE = "dotfiles(tui-dirs-only)"
/** One oxlint run over a few files. */
const TIMEOUT_MS = 60_000

/** Each planted file, by its path under the tree, and how many diagnostics it must get. */
const FILES: ReadonlyArray<readonly [string, string, number]> = [
  ["mods/prime/filestore/planted.ts", 'import { homedir } from "node:os"\nexport const at = `${homedir()}/.local/state`', 1],
  ["cmd/git/tui.tsx", "export const home = process.env.HOME", 1],
  [
    "mods/queue/tui/forms.ts",
    [
      'import os from "node:os"',
      "export const a = os.homedir()",
      'export const b = process.env["XDG_STATE_HOME"]',
      "export const c = process.env.XDG_CONFIG_HOME",
      "export const d = Bun.env.HOME",
      "export const { HOME } = process.env",
      "export const { XDG_DATA_HOME: data } = Bun.env",
      "export const e = process.env['HOME']",
    ].join("\n"),
    7,
  ],
  [
    "mods/escape/quiet.ts",
    [
      'import * as TuiDirs from "@dotfiles/decider/tui-dirs"',
      "export const a = TuiDirs.dirs().home",
      "export const b = process.env.TERM",
      "export const c = { homedir: () => '' }.homedir()",
      "export const { TERM } = process.env",
      "export const d = env.HOME",
    ].join("\n"),
    0,
  ],
  ["cmd/wake/server.ts", "export const a = process.env.HOME", 1],
  ["mods/pool/store/planted.ts", 'import { homedir } from "node:os"\nexport const a = homedir()', 1],
  ["cmd/prime/tui/dirs.test.ts", "export const a = process.env.HOME", 0],
  ["mods/pool/ssh/push.ts", "export const a = process.env.HOME", 0],
  ["sim/free.ts", "export const a = process.env.HOME", 0],
  ["decider/tui-dirs.ts", 'import { homedir } from "node:os"\nexport const a = homedir()', 0],
]

const Override = Schema.Struct({ files: Schema.Array(Schema.String), rules: Schema.Record(Schema.String, Schema.Unknown) })
const Repo = Schema.fromJsonString(Schema.Struct({ overrides: Schema.Array(Override) }))
const Report = Schema.fromJsonString(Schema.Struct({ diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, filename: Schema.String })) }))
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("tui-dirs-only", () => {
  platformTest(
    "it refuses a host-dir read in the TUI plugins' folders and nothing else",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)))
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "lint-tui-dirs-" })
      for (const [file, code] of FILES) {
        yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
        yield* fs.writeFileString(path.join(dir, file), `${code}\n`)
      }
      const repo = yield* fs.readFileString(path.join(root, ".oxlintrc.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Repo)))
      const overrides = repo.overrides.filter((each) => "dotfiles/tui-dirs-only" in each.rules)
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
