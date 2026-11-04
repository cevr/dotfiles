// Points each plugin's node_modules at the OpenCode checkout in OPENCODE_DEV,
// so the plugins typecheck against the host's API, OpenTUI and Solid. At
// runtime OpenCode provides these modules itself; the links are for tooling.
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"

const dev = process.env.OPENCODE_DEV
if (!dev) {
  console.error("OPENCODE_DEV is not set: point it at an OpenCode checkout, e.g. the prime-look Rift.")
  process.exit(1)
}
const target = path.resolve(dev, "packages/tui/node_modules")
if (!existsSync(path.join(target, "@opencode/plugin"))) {
  console.error(`${target} has no @opencode/plugin: run bun install in ${dev} first.`)
  process.exit(1)
}

const root = path.resolve(import.meta.dir, "../plugins")
for (const name of readdirSync(root)) {
  const link = path.join(root, name, "node_modules")
  const current = existsSync(link) || isLink(link) ? lstatSync(link) : undefined
  if (current?.isSymbolicLink() && readlinkSync(link) === target) continue
  if (current && !current.isSymbolicLink()) {
    console.error(`${link} is a real directory; remove it to link the fork.`)
    process.exit(1)
  }
  if (current) rmSync(link)
  symlinkSync(target, link)
}

function isLink(file: string) {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}
