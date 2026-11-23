// dotfiles/chrome-mock-keychain (lint/chrome-keychain.ts), through the oxlint
// binary the gate runs, with the repository's own setting (.oxlintrc.json): an
// argument list that starts a Chrome headless or with its DevTools protocol
// and lacks either keychain flag is refused, in each form the rule's header
// lists (a literal, a template, a spread `const` list of the same file); a
// list with both flags, one with no such flag, and a flag only looked for are
// left alone. Its test registers through sim-tui/effect-test.ts, as
// lint/tui-dirs.test.ts does.
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { platformTest } from "../sim-tui/effect-test.ts"

const CODE = "dotfiles(chrome-mock-keychain)"
/** One oxlint run over a few files. */
const TIMEOUT_MS = 60_000

/** Each planted file, by its path under the tree, and how many diagnostics it must get. */
const FILES: ReadonlyArray<readonly [string, string, number]> = [
  ["bare.ts", 'export const a = ["--headless=new", "--dump-dom"]', 1],
  ["port.ts", "export const a = (port: number) => [`--remote-debugging-port=${port}`, '--no-first-run']", 1],
  ["pipe.ts", 'export const a = ["--remote-debugging-pipe", "--use-mock-keychain"]', 1],
  ["linux-only.ts", 'export const a = ["--headless", "--password-store=basic"]', 1],
  [
    "spread.ts",
    ['const BASE = ["--headless", "--no-first-run"]', 'export const a = [...BASE, "--remote-debugging-address=127.0.0.1"]'].join("\n"),
    2,
  ],
  [
    "safe.ts",
    [
      'export const a = ["--headless=new", "--use-mock-keychain", "--password-store=basic"]',
      'const KEYCHAIN = ["--use-mock-keychain", "--password-store=basic"]',
      'export const b = [...KEYCHAIN, "--remote-debugging-port=0"]',
      'export const c = ["--window-size=800,600", "--no-first-run"]',
      "export const d = (args: ReadonlyArray<string>) => args.includes('--headless')",
    ].join("\n"),
    0,
  ],
]

const Repo = Schema.fromJsonString(Schema.Struct({ rules: Schema.Record(Schema.String, Schema.Unknown) }))
const Report = Schema.fromJsonString(Schema.Struct({ diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, filename: Schema.String })) }))
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("chrome-mock-keychain", () => {
  platformTest(
    "it refuses a headless or DevTools list without both keychain flags, in every form, and nothing else",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)))
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "lint-chrome-keychain-" })
      for (const [file, code] of FILES) yield* fs.writeFileString(path.join(dir, file), `${code}\n`)
      const repo = yield* fs.readFileString(path.join(root, ".oxlintrc.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Repo)))
      const rules = { "dotfiles/chrome-mock-keychain": repo.rules["dotfiles/chrome-mock-keychain"] }
      const config = path.join(dir, "oxlintrc.json")
      yield* fs.writeFileString(config, toJson({ jsPlugins: [path.join(root, "lint/test-env.ts")], rules }))
      const command = ChildProcess.make(path.join(root, "node_modules/.bin/oxlint"), ["-c", config, "--format", "json", dir], { cwd: dir, stdin: "ignore", forceKillAfter: "3 seconds" })
      const child = yield* spawner.spawn(command)
      const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
      yield* child.exitCode
      const report = yield* Schema.decodeUnknownEffect(Report)(out)
      const found = report.diagnostics.filter((each) => each.code === CODE).map((each) => path.relative(dir, path.resolve(dir, each.filename)))
      expect(FILES.map(([file]) => [file, found.filter((each) => each === file).length])).toEqual(FILES.map(([file, , errors]) => [file, errors]))
      expect(rules["dotfiles/chrome-mock-keychain"]).toBe("error")
    }),
    TIMEOUT_MS,
  )
})
