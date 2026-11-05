import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { skillFilesLaws, type Placed, type Root } from "../laws.ts"
import { folders, layer } from "./skill-files.ts"

/** A scratch layout for the scope's lifetime: a home holding the config directory, and a project two levels under a parent. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "skills-")))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const layout = (dir: string) => {
  const home = join(dir, "home")
  return { home, config: join(home, ".config", "opencode"), parent: join(dir, "work"), directory: join(dir, "work", "app") }
}

const rootOf = (dir: string, root: Root) => {
  const at = layout(dir)
  return root === "project" ? at.directory : root === "parent" ? at.parent : root === "config" ? at.config : at.home
}

skillFilesLaws("filesystem SkillFiles", (placed) =>
  Effect.gen(function* () {
    const dir = yield* scratch
    const pathOf = (item: Placed) => join(rootOf(dir, item.root), item.folder, item.file)
    for (const item of placed) {
      mkdirSync(dirname(pathOf(item)), { recursive: true })
      writeFileSync(pathOf(item), item.contents)
    }
    const at = layout(dir)
    mkdirSync(at.directory, { recursive: true })
    return { layer: layer({ directory: at.directory, home: at.home, config: at.config }), pathOf }
  }),
)

describe("filesystem SkillFiles folders", () => {
  test("a project folder inside a global root is global only: OpenCode's config directory in the project, as opencode-drive sets it", () => {
    const folders_ = folders({ directory: "/w/app", home: "/h", config: "/w/app/.opencode" })
    expect(folders_.global).toEqual(["/w/app/.opencode/skills", "/w/app/.opencode/skill", "/h/.claude/skills", "/h/.agents/skills"])
    expect(folders_.local).not.toContain("/w/app/.opencode/skills")
    expect(folders_.local.slice(0, 2)).toEqual(["/w/app/.claude/skills", "/w/app/.agents/skills"])
  })

  test("the home directory's own folders are not local when the project sits under home", () => {
    const local = folders({ directory: "/h/code/app", home: "/h", config: "/h/.config/opencode" }).local
    expect(local).not.toContain("/h/.claude/skills")
    expect(local).toContain("/h/code/.claude/skills")
  })
})

describe("filesystem SkillFiles over linked folders", () => {
  test("a dotfiles checkout linked in as both global folders reads once, as global, from inside the checkout", async () => {
    const found = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratch
          const home = join(dir, "home")
          const dotfiles = join(home, "dotfiles")
          mkdirSync(join(dotfiles, "skills", "review"), { recursive: true })
          writeFileSync(join(dotfiles, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Reviews a change\n---\nRead the diff.\n")
          for (const at of [".claude", ".agents"]) {
            mkdirSync(join(home, at), { recursive: true })
            symlinkSync(join(dotfiles, "skills"), join(home, at, "skills"))
          }
          const { SkillFiles } = yield* Effect.promise(() => import("../service.ts"))
          return yield* SkillFiles.use((files) => files.scan).pipe(Effect.provide(layer({ directory: dotfiles, home, config: join(home, ".config", "opencode") })))
        }),
      ),
    )
    expect(found.map((skill) => [skill.id, skill.tier])).toEqual([["review", "global"]])
  })
})
