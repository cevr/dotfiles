// What every implementation of the SkillFiles contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over a bench that
// places skill files where that implementation looks.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { SkillFiles } from "./service.ts"
import type { Found } from "./tier.ts"

/** Where a placed file goes: the working directory, its parent, OpenCode's config directory or the user's home. */
export type Root = "project" | "parent" | "config" | "home"

/** One file to place: `file` inside `folder` (`.claude/skills`) under `root`. */
export interface Placed {
  readonly root: Root
  readonly folder: string
  readonly file: string
  readonly contents: string
}

export interface Bench {
  readonly layer: Layer.Layer<SkillFiles>
  /** The absolute path a placed file got. */
  readonly pathOf: (placed: Placed) => string
}

const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

const check = (placed: ReadonlyArray<Placed>, bench: (placed: ReadonlyArray<Placed>) => Effect.Effect<Bench, never, Scope.Scope>, body: (found: ReadonlyArray<Found>, bench: Bench) => void) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const made = yield* bench(placed)
        const found = yield* SkillFiles.use((files) => files.scan).pipe(Effect.provide(made.layer))
        body(found, made)
      }),
    ),
  )

/** `bench` places the files in a fresh layout and makes an implementation that scans it. */
export const skillFilesLaws = (name: string, bench: (placed: ReadonlyArray<Placed>) => Effect.Effect<Bench, never, Scope.Scope>) =>
  describe(`${name} keeps the SkillFiles laws`, () => {
    test("nothing placed: no skills, and no failure for the missing folders", () => check([], bench, (found) => expect(found).toEqual([])))

    test("a SKILL.md is named by its folder and read by its frontmatter; a top-level .md by its file name", () => {
      const folder: Placed = { root: "project", folder: ".claude/skills", file: "review/SKILL.md", contents: skill("Review", "Reviews a change", "Read the diff.") }
      const loose: Placed = { root: "project", folder: ".opencode/skills", file: "notes.md", contents: "---\ndescription: Loose notes\n---\nKeep notes.\n" }
      return check([folder, loose], bench, (found, made) => {
        expect(found).toContainEqual({ id: "review", name: "Review", description: "Reviews a change", path: made.pathOf(folder), content: "Read the diff.\n", tier: "local" })
        expect(found).toContainEqual({ id: "notes", name: "notes", description: "Loose notes", path: made.pathOf(loose), content: "Keep notes.\n", tier: "local" })
      })
    })

    test("the local tier comes first, the working directory before its parent, then the global tier", () => {
      const placed: ReadonlyArray<Placed> = [
        { root: "home", folder: ".claude/skills", file: "review/SKILL.md", contents: skill("review", "home", "home") },
        { root: "config", folder: "skills", file: "review/SKILL.md", contents: skill("review", "config", "config") },
        { root: "parent", folder: ".agents/skills", file: "review/SKILL.md", contents: skill("review", "parent", "parent") },
        { root: "project", folder: ".claude/skills", file: "review/SKILL.md", contents: skill("review", "project", "project") },
      ]
      return check(placed, bench, (found) => {
        expect(found.map((skill) => [skill.tier, skill.description])).toEqual([
          ["local", "project"],
          ["local", "parent"],
          ["global", "config"],
          ["global", "home"],
        ])
      })
    })

    test("a skill folder's own files are not skills, and hidden folders are skipped", () => {
      const placed: ReadonlyArray<Placed> = [
        { root: "project", folder: ".claude/skills", file: "review/SKILL.md", contents: skill("review", "outer", "outer") },
        { root: "project", folder: ".claude/skills", file: "review/inner/SKILL.md", contents: skill("inner", "inner", "inner") },
        { root: "project", folder: ".claude/skills", file: ".hidden/SKILL.md", contents: skill("hidden", "hidden", "hidden") },
      ]
      return check(placed, bench, (found) => expect(found.map((skill) => skill.id)).toEqual(["review"]))
    })
  })
