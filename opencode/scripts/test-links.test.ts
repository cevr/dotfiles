// @reads all
// @reads-reason computed read at scripts/test-links.ts: const physical = yield* fs.realPath(root)
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Option, Path, Result } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { initScratchGit, spawnScratchGitSync } from "../tests/scratch-child.ts"
import { scratchInput } from "../tests/read-path.ts"
import { checkoutLinks, closeLinks, linkReads, predecessorLinks } from "./test-links.ts"
import { spellingReads, trackedSpellings } from "./test-path-spellings.ts"
import { readMapAt } from "./test-read-map.ts"
import { testReadInputs, type Workspace } from "./reach.ts"

describe("tracked input links", () => {
  it.live.layer(BunServices.layer)("file, chain, directory, re-entry, dangling, external and retargeted links preserve the correct identities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = scratchInput(yield* fs.makeTempDirectoryScoped())
      const repo = path.join(dir, "repo")
      yield* fs.makeDirectory(path.join(repo, "opencode/values"), { recursive: true })
      const write = (name: string, text: string) => fs.writeFileString(scratchInput(path.join(repo, "opencode", name)), text)
      const symlink = (target: string, name: string) => fs.symlink(target, path.join(repo, "opencode", name))
      const git = (...args: string[]) => {
        const ran = spawnScratchGitSync(repo, args)
        expect(ran.exitCode, ran.stderr.toString()).toBe(0)
        return ran.stdout.toString().trim()
      }
      initScratchGit(repo, ["-q", "-b", "main"])
      yield* write("values/leaf.txt", "before")
      yield* write("next.txt", "after")
      yield* fs.writeFileString(scratchInput(path.join(dir, "outside.txt")), "outside")
      yield* symlink("values/leaf.txt", "file.txt")
      yield* symlink("file.txt", "chain.txt")
      yield* symlink("values", "folder")
      yield* symlink("../../repo/opencode/values/leaf.txt", "reenter.txt")
      yield* symlink("missing.txt", "dangling.txt")
      yield* symlink("../../outside.txt", "external.txt")
      git("add", ".")
      git("commit", "-m", "initial links")
      const base = git("rev-parse", "HEAD")
      const before = yield* Effect.promise(() => checkoutLinks(repo))
      for (const name of ["file.txt", "chain.txt", "reenter.txt"]) {
        const reader = linkReads(before, (file) => file === name, new Set([name]), [name])
        expect(reader.has("values/leaf.txt")).toBe(true)
        expect(reader.has(name)).toBe(true)
        expect(reader.has("next.txt")).toBe(false)
      }
      const initial = ["file.txt", "chain.txt", "reenter.txt", "folder/leaf.txt", "values/leaf.txt"]
      expect(closeLinks(before, new Map(), ["values/leaf.txt"], []).toSorted()).toEqual(initial.toSorted())
      for (const leaf of ["new.txt", "deleted.txt"])
        expect(closeLinks(before, new Map(), [`values/${leaf}`], []).toSorted()).toEqual([`folder/${leaf}`, `values/${leaf}`])
      for (const unresolved of ["dangling.txt", "external.txt"]) {
        const reader = linkReads(before, (file) => file === unresolved, new Set([unresolved]), [unresolved])
        expect(reader.unsafe).toBe(unresolved)
        expect(reader.has("next.txt")).toBe(false)
        expect(before.get(unresolved)?.target._tag).toBe("None")
      }
      yield* fs.remove(path.join(repo, "opencode/file.txt"))
      yield* symlink("next.txt", "file.txt")
      const after = yield* Effect.promise(() => checkoutLinks(repo))
      const prior = yield* Effect.promise(() => predecessorLinks(repo, base, ["file.txt"]))
      const retarget = closeLinks(after, prior, ["file.txt"], [])
      expect(retarget).toContain("values/leaf.txt")
      expect(retarget).toContain("next.txt")
      expect(retarget).toContain("chain.txt")
    }).pipe(Effect.scoped),
  )

  it.live.layer(BunServices.layer)("a malformed read map names the file for syntax errors and missing fields", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = scratchInput(yield* fs.makeTempDirectoryScoped())
      yield* fs.makeDirectory(scratchInput(path.join(root, "scripts")))
      const map = scratchInput(path.join(root, "scripts/test-impact-observations.json"))
      for (const contents of ["{", "{}", '{"paths":[],"untracedSubprocesses":{},"compilerProjects":{}}']) {
        yield* fs.writeFileString(map, contents)
        const verdict = yield* Effect.result(readMapAt(root))
        const failure = Result.getFailure(verdict)
        expect(Option.map(failure, (error) => error._tag)).toEqual(Option.some("InvalidTestReadMap"))
        expect(Option.getOrElse(Option.map(failure, (error) => error.message), () => "")).toContain(map)
      }
    }).pipe(Effect.scoped),
  )
})

it.effect("tracked spelling rejects case and Unicode aliases, but cleans separators before deciding", () =>
  Effect.sync(() => {
    const names = ["sim/r7/target.txt", "sim/r7/café.txt"]
    const resolve = trackedSpellings(names, () => "")
    const dirty = spellingReads(resolve, ["sim/r7/TARGET.txt"], ["sim/r7/cafe\u0301.txt"])
    expect(dirty.rejected.join("\n")).toContain('"sim/r7/TARGET.txt"')
    expect(dirty.rejected.join("\n")).toContain('"sim/r7/café.txt"')
    expect(dirty.patterns).toEqual([names[0]])
    expect(dirty.paths).toEqual([names[1]])
    expect(spellingReads(resolve, ["./sim//r7/local/../target.txt"], ["sim//r7/café.txt"]).rejected).toEqual([])
    expect(spellingReads(resolve, ["sim/R7/*.txt"], ["sim/R7/"]).patterns).toEqual(["sim/r7/*.txt"])
    const more = trackedSpellings(["sim/[output].txt", ...names], () => "sim/r7/cafe\u0301.txt")
    expect(spellingReads(more, ["sim/[OUTPUT].txt"], [], ["sim/[OUTPUT].txt"]).literalPaths).toEqual(["sim/[output].txt"])
    expect(spellingReads(more, [], ["sim/disk-folded.txt"]).paths).toEqual([names[1]])
  }),
)

it.effect("both observed readers stay selected when tracked names fold to an ambiguous identity", () =>
  Effect.sync(() => {
    const files = ["sim/r7/target.txt", "sim/r7/Target.txt", "sim/r7/café.txt"]
    const inconsistent = "sim/r7/case.test.ts"
    const exact = "sim/r7/exact.test.ts"
    const unicode = "sim/r7/unicode.test.ts"
    const workspace: Workspace = {
      files, spellings: trackedSpellings(files, () => ""), packages: new Map(),
      runtimeReads: {
        paths: { [inconsistent]: ["sim/r7/TARGET.txt"], [exact]: [files[0]!], [unicode]: ["sim/r7/cafe\u0301.txt"] },
        untracedSubprocesses: {}, compilerProjects: {},
      },
    }
    for (const test of [inconsistent, exact]) {
      const reader = testReadInputs(workspace, test)
      expect(reader.unknown).toBe(true)
      expect(reader.has(files[0]!)).toBe(true)
      expect(reader.has(files[1]!)).toBe(true)
    }
    const reader = testReadInputs(workspace, unicode)
    expect(reader.unknown).toBe(false)
    expect(reader.positive(files[2]!)).toBe(true)
    expect(reader.positive("../AGENTS.md")).toBe(false)
  }),
)
