// @reads .claude .claude/skills/verify-opencode/SKILL.md .claude/skills/verify-opencode/features/*.md cmd decider formal lint mods scenarios scripts scripts/**/*.ts scripts/**/*.tsx sim sim-tui testbeds tests themes
// @reads-indirect .claude/** cmd/** decider/** formal/** lint/** mods/** scenarios/** sim-tui/** sim/** testbeds/** tests/** themes/**
// The verify-opencode skill's docs guard: the skill and its feature map name only what the tree has. Every
// path they backtick exists, every `bun run <script>` is a package script, every feature file keeps the entry
// contract with its world suites, real checks and code on disk, the index lists exactly the feature files,
// and AGENTS.md points verifiers at the skill.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Glob } from "bun"
import { Array as Arr, Effect, FileSystem, Option, Path, Schema } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { matchingInput } from "../tests/read-path.ts"
import { FEATURES_DIR, INDEX, noDrive, parseFeature, SKILL_DIR, touched, uncovered, undriven } from "./verify-map.ts"

/** The H2s of a feature file, in order. */
const CONTRACT = ["Sub-features", "How to get to it (user POV)", "Driving it with the world", "Driving it with real OpenCode", "Gotchas"]
/** The folders a backticked path may start with, from opencode/; `out/` is a drive's output, never checked. */
const PATH = /^(?:\.claude|cmd|mods|sim|sim-tui|scripts|tests|scenarios|testbeds|decider|themes|formal|lint)\/[\w./-]*$/
// The feature map can point to directories as well as files.
const DOC_INPUT = "{.claude,.claude/**,cmd,cmd/**,mods,mods/**,sim,sim/**,sim-tui,sim-tui/**,scripts,scripts/**/*.ts,scripts/**/*.tsx,tests,tests/**,scenarios,scenarios/**,testbeds,testbeds/**,decider,decider/**,themes,themes/**,formal,formal/**,lint,lint/**}"
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
  const at = yield* root
  const features = [...new Glob(".claude/skills/verify-opencode/features/*.md").scanSync({ cwd: at })].sort()
  const read = (file: string) => Effect.map(fs.readFileString(matchingInput("{.claude/skills/verify-opencode/SKILL.md,.claude/skills/verify-opencode/features/*.md}", file)), (text) => ({ file, text }))
  return yield* Effect.forEach([`${SKILL_DIR}/SKILL.md`, ...features], read)
})

/** Whether `file` exists from opencode/. */
const exists = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(matchingInput(DOC_INPUT, file))
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
      // `undriven` intersects this inventory with each feature's claimed folders; sim/ belongs to every feature.
      const suites = [...new Glob("**/*.sim.test.{ts,tsx}").scanSync({ cwd: yield* root })].filter((file) => !file.includes("node_modules/"))
      expect(suites).toContain("cmd/queue/queue.sim.test.ts")
      expect(features.map((feature) => ({ feature: feature.id, undriven: undriven(feature, suites) }))).toEqual(features.map((feature) => ({ feature: feature.id, undriven: [] })))
    }),
  )

  live("every source file batch 2026-11-15cc's, 2026-11-16cv's, 2026-11-16cx's and 2026-11-16cy's drives found in no feature's Code is now in one, or set aside by the index's No drive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const features = (yield* docs)
        .filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md"))
        .map(({ file, text }) => parseFeature(file.slice(FEATURES_DIR.length + 1), text))
      const exempt = noDrive(yield* fs.readFileString(matchingInput(".claude/skills/verify-opencode/features/*.md", INDEX)))
      const found = [
        "cmd/status/server.test.ts",
        "formal/check.ts",
        "formal/itf.ts",
        "formal/orchestrate/replay.ts",
        "formal/orchestrate/story.ts",
        "formal/orchestrate/trace.ts",
        "mods/status/model.ts",
        "mods/status/pane.test.ts",
        "mods/status/pane.ts",
        "mods/status/run-table.test.ts",
        "mods/status/run-table.ts",
        "mods/status/status.ts",
        "scripts/agents.ts",
        "scripts/link-fork.ts",
        "scripts/typecheck.ts",
        "tests/kernel.test.ts",
        "tests/kernel/run.ts",
        "tests/orchestrate.test.ts",
        "tests/orchestrate/run.ts",
        "tests/orchestrate/sim.ts",
        // 2026-11-16cv: the gamut testbed.
        "testbeds/gamut/gamut.ts",
        "testbeds/gamut/owner.ts",
        "testbeds/gamut/pty-host.ts",
        "testbeds/gamut/sim-model.ts",
        "tests/gamut-owner.test.ts",
        "tests/gamut.test.ts",
        // 2026-11-16cy: the plugin-start check (work's) and the scratch-service helper (mail's), changed by the reaper.
        "tests/plugin-start.test.ts",
        "tests/service.ts",
      ]
      expect({ exempt, uncovered: uncovered(features, found, exempt) }).toEqual({
        exempt: ["scripts/", "formal/", "lint/", "tests/accept-clock.test.ts", "testbeds/gamut/", "tests/gamut.test.ts", "tests/gamut-owner.test.ts", "testbeds/reaper/", "tests/reaper.test.ts", "tests/reaper/"],
        uncovered: [],
      })
    }),
  )

  live("every source file batch 2026-11-15cl's drive found in no feature's Code is now in one, or set aside by the index's No drive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const features = (yield* docs)
        .filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md"))
        .map(({ file, text }) => parseFeature(file.slice(FEATURES_DIR.length + 1), text))
      const exempt = noDrive(yield* fs.readFileString(matchingInput(".claude/skills/verify-opencode/features/*.md", INDEX)))
      const found = [
        "cmd/rex/server.ts",
        "cmd/rex/show.ts",
        "cmd/rex/tui.tsx",
        "mods/rex/model.ts",
        "mods/rex/pane.ts",
        "scenarios/tui-paint.ts",
        "testbeds/busy-agents.ts",
        "tests/accept-clock.test.ts",
      ]
      expect(uncovered(features, found, exempt)).toEqual([])
    }),
  )

  live("the spawn helper and the scratch folders every real check runs through make the features that spawn through them due (batch 2026-11-15cm)", () =>
    Effect.gen(function* () {
      const features = (yield* docs)
        .filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md"))
        .map(({ file, text }) => parseFeature(file.slice(FEATURES_DIR.length + 1), text))
      const due = (path: string) => touched(features, [path]).map((feature) => feature.id).toSorted()
      // A change to owned.ts went to main with neither the herdr test nor the TUI tests run (cl-fu, M1).
      expect(due("tests/owned.ts")).toEqual(["cache", "escape", "guard", "kernel", "mail", "orchestrate", "pool", "prime-panel", "queue", "wake-latch"])
      expect(due("tests/scratch.ts")).toEqual(due("tests/owned.ts"))
      const real = Option.getOrElse(Option.map(Arr.findFirst(features, (feature) => feature.id === "prime-panel"), (feature) => feature.real), (): ReadonlyArray<string> => [])
      expect(["tests/herdr.test.ts", "tests/tui-cpu.test.ts", "tests/tui-paint.test.ts"].filter((test) => !real.includes(test))).toEqual([])
    }),
  )

  live("a change to the escape plugin or the herdr reporter makes the feature that runs their checks due (batch 2026-11-15co)", () =>
    Effect.gen(function* () {
      const features = (yield* docs)
        .filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md"))
        .map(({ file, text }) => parseFeature(file.slice(FEATURES_DIR.length + 1), text))
      const due = (path: string) => touched(features, [path]).map((feature) => feature.id).toSorted()
      const real = (id: string) => Option.getOrElse(Option.map(Arr.findFirst(features, (feature) => feature.id === id), (feature) => feature.real), (): ReadonlyArray<string> => [])
      // cmd/escape changed with none of the escape checks run: no feature's Code covered it (fu-small, co B1).
      for (const path of ["cmd/escape/setup.ts", "cmd/escape/server.ts", "mods/escape/escape.ts", "scenarios/queue-merge.ts"]) expect(due(path)).toContain("escape")
      const escapeChecks = ["tests/escape-send.test.ts", "tests/escape-states.test.ts", "tests/escape-subagent.test.ts", "tests/prime-escape.test.ts", "tests/queue-merge.test.ts"]
      expect(escapeChecks.filter((test) => !real("escape").includes(test))).toEqual([])
      for (const path of ["cmd/herdr/tui.tsx", "mods/herdr/report.ts"]) expect(due(path)).toEqual(["prime-panel"])
      expect(real("prime-panel")).toContain("tests/herdr.test.ts")
    }),
  )

  live("the index lists exactly the feature files, and AGENTS.md points verifiers at the skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const at = yield* root
      const all = yield* docs
      const files = all.filter(({ file }) => file.startsWith(`${FEATURES_DIR}/`) && !file.endsWith("/README.md")).map(({ file }) => file.slice(FEATURES_DIR.length + 1))
      const index = yield* fs.readFileString(matchingInput(".claude/skills/verify-opencode/features/*.md", INDEX))
      const linked = Array.from(index.matchAll(/\]\(([\w-]+\.md)\)/g)).map((match) => Option.getOrElse(Option.fromNullishOr(match[1]), () => ""))
      expect(linked.toSorted()).toEqual(files.toSorted())
      expect(yield* fs.readFileString(path.join(at, "AGENTS.md"))).toContain(SKILL_DIR)
    }),
  )
})
