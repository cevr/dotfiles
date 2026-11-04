// `bun run typecheck`: links the fork's modules (scripts/link-fork.ts), then
// checks the root project and every workspace package that has a tsconfig.json
// (mods/*, cmd/*), each against its own compiler options.
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"

const root = path.resolve(import.meta.dir, "..")
await $`bun ${path.join(import.meta.dir, "link-fork.ts")}`.cwd(root)
const projects = ["mods", "cmd"].flatMap((group) => {
  const dir = path.join(root, group)
  return existsSync(dir) ? readdirSync(dir).map((name) => `${group}/${name}`) : []
})
await $`bun check --no-script`.cwd(root)
for (const project of projects.filter((name) => existsSync(path.join(root, name, "tsconfig.json"))))
  await $`bun check --no-script -p ${project}`.cwd(root)
