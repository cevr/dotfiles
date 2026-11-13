// `bun run typecheck`: links the fork's modules (scripts/link-fork.ts), then
// checks the root project and every workspace package that has a tsconfig.json
// (mods/*, cmd/*, sim), each against its own compiler options, in one `bun check -b`
// over a tsconfig that only references them, written fresh each run to
// node_modules/.cache/gate/tsconfig.json from the folders that exist.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

/** Every mods/* and cmd/* package with a tsconfig.json, relative to the workspace root. */
export const projects = () =>
  ["mods", "cmd"]
    .flatMap((group) => {
      const dir = path.join(root, group)
      return existsSync(dir) ? readdirSync(dir).map((name) => `${group}/${name}`) : []
    })
    .concat(["sim"])
    .filter((name) => existsSync(path.join(root, name, "tsconfig.json")))

/** The `bun check` command that checks every project; writes the tsconfig it reads. */
export const checkCommand = (): ReadonlyArray<string> => {
  const dir = path.join(root, "node_modules/.cache/gate")
  mkdirSync(dir, { recursive: true })
  const all = path.join(dir, "tsconfig.json")
  const references = ["tsconfig.json", ...projects()].map((project) => ({ path: path.relative(dir, path.join(root, project)) }))
  writeFileSync(all, JSON.stringify({ files: [], references }, null, 2))
  return [process.execPath, "check", "--no-script", "-b", "-p", all]
}

if (import.meta.main) {
  const link = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "link-fork.ts")], { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (link.exitCode !== 0) process.exit(link.exitCode ?? 1)
  const check = Bun.spawnSync([...checkCommand()], { cwd: root, stdout: "inherit", stderr: "inherit" })
  process.exit(check.exitCode ?? 1)
}
