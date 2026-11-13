// The verify-opencode skill's docs guard: the skill and its feature map name only what the tree has. Every
// path they backtick exists, every `bun run <script>` is a package script, every feature file keeps the entry
// contract with its world suites, real checks and code on disk, the index lists exactly the feature files,
// and AGENTS.md points verifiers at the skill.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, PlatformError, Schema } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { FEATURES_DIR, parseFeature, SHARED, SKILL_DIR, undriven } from "./verify-map.ts"

/** The H2s of a feature file, in order. */
const CONTRACT = ["Sub-features", "How to get to it (user POV)", "Driving it with the world", "Driving it with real OpenCode", "Gotchas"]
/** The folders a backticked path may start with, from opencode/; `out/` is a drive's output, never checked. */
const PATH = /^(?:\.claude|cmd|mods|sim|sim-tui|scripts|tests|scenarios|testbeds|decider|themes)\/[\w./-]*$/
/** A drive's own output (`out/`, `sim/out/`): git ignores it, and a fresh checkout has none. */
const OUTPUT = /(?:^|\/)out\//
const Manifest = Schema.fromJsonString(Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }))

/** opencode/, from this file's URL. */
const root = Effect.gen(function* () {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("..", import.meta.url))
})

/** The skill's markdown files, from opencode/, with their text. */
const docs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const at = yield* root
  const features = (yield* fs.readDirectory(path.join(at, FEATURES_DIR))).filter((file) => file.endsWith(".md")).map((file) => `${FEATURES_DIR}/${file}`)
  const files = [`${SKILL_DIR}/SKILL.md`, ...features.sort()]
  return yield* Effect.forEach(files, (file) => Effect.map(fs.readFileString(path.join(at, file)), (text) => ({ file, text })))
})

/** Whether `file` exists from opencode/. */
const exists = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* fs.exists(path.join(yield* root, file))
  })

/** Every file under `dir` (from opencode/), node_modules and dot folders aside, as paths from opencode/. */
const files = (dir: string): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError | PlatformError.BadArgument, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const at = yield* root
    const found = yield* Effect.forEach(yield* fs.readDirectory(path.join(at, dir)), (name) =>
      Effect.gen(function* () {
        const entry = `${dir}/${name}`
        const info = yield* fs.stat(path.join(at, entry))
        if (info.type === "Directory" && name !== "node_modules" && !name.startsWith(".")) return yield* files(entry)
        if (info.type === "File") return [entry]
        return []
      }),
    )
    return found.flat()
  })

const backticked = (text: string): ReadonlyArray<string> => Arr.map(Array.from(text.matchAll(/`([^`\n]+)`/g)), (match) => Option.getOrElse(Option.fromNullishOr(match[1]), () => ""))

describe("the verify-opencode skill names only what the tree has", () => {
  const live = it.live.layer(BunServices.layer)

  live("every path it backticks exists", () =>
    Effect.gen(function* () {
      const named = Arr.dedupe((yield* docs).flatMap(({ text }) => backticked(text).flatMap((word) => word.split(/[\s,]+/))))
      const paths = named.map((word) => word.replace(/[:.,)]+$/, "")).filter((word) => PATH.test(word) && !OUTPUT.test(word))
      const missing = yield* Effect.filter(paths, (file) => Effect.map(exists(file.replace(/\/$/, "")), (here) => !here))
      expect(missing).toEqual([])
    }),
  )

  live("every bun run it names is a package script", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifest = Schema.decodeUnknownSync(Manifest)(yield* fs.readFileString(path.join(yield* root, "package.json")))
      const scripts = Arr.dedupe((yield* docs).flatMap(({ text }) => Array.from(text.matchAll(/bun run ([\w:-]+)/g)).map((match) => Option.getOrElse(Option.fromNullishOr(match[1]), () => ""))))
      expect(scripts.filter((name) => !(name in manifest.scripts))).toEqual([])
      expect(scripts).toContain("verify:drive")
    }),
  )

  live("every feature file keeps the entry contract, with its suites, checks and code on disk", () =>
    Effect.gen(function* () {
      const features = (yield* docs).filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md"))
      expect(features.length).toBeGreaterThanOrEqual(5)
      for (const { file, text } of features) {
        const heads = text.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3))
        expect({ file, heads }).toEqual({ file, heads: CONTRACT })
        const feature = parseFeature(file.slice(FEATURES_DIR.length + 1), text)
        expect({ file, world: feature.world.filter((suite) => !/\.sim\.test\.tsx?$/.test(suite)) }).toEqual({ file, world: [] })
        expect({ file, code: feature.code.length > 0, real: feature.real.length > 0 }).toEqual({ file, code: true, real: true })
        const named = [...feature.world, ...feature.real, ...feature.code.map((prefix) => prefix.replace(/\/$/, ""))]
        expect({ file, missing: yield* Effect.filter(named, (each) => Effect.map(exists(each), (here) => !here)) }).toEqual({ file, missing: [] })
      }
    }),
  )

  live("every world suite under a feature's own code is in its drive", () =>
    Effect.gen(function* () {
      const features = (yield* docs)
        .filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md"))
        .map(({ file, text }) => parseFeature(file.slice(FEATURES_DIR.length + 1), text))
      // The suites on disk under each claimed folder, node_modules aside; `sim/` is every feature's and no one's.
      const folders = Arr.dedupe(features.flatMap((feature) => feature.code.filter((prefix) => prefix.endsWith("/") && prefix !== SHARED)))
      const suites = Arr.dedupe((yield* Effect.forEach(folders, (folder) => files(folder.replace(/\/$/, "")))).flat())
      expect(suites).toContain("cmd/queue/queue.sim.test.ts")
      expect(features.map((feature) => ({ feature: feature.id, undriven: undriven(feature, suites) }))).toEqual(features.map((feature) => ({ feature: feature.id, undriven: [] })))
    }),
  )

  live("the index lists exactly the feature files, and AGENTS.md points verifiers at the skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const at = yield* root
      const all = yield* docs
      const files = all.filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md")).map(({ file }) => file.slice(FEATURES_DIR.length + 1))
      const index = yield* fs.readFileString(path.join(at, FEATURES_DIR, "README.md"))
      const linked = Array.from(index.matchAll(/\]\(([\w-]+\.md)\)/g)).map((match) => Option.getOrElse(Option.fromNullishOr(match[1]), () => ""))
      expect(linked.toSorted()).toEqual(files.toSorted())
      expect(yield* fs.readFileString(path.join(at, "AGENTS.md"))).toContain(SKILL_DIR)
    }),
  )
})
