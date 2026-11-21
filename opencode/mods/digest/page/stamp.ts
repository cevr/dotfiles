// The built page's stamp: one hash over everything the build reads (src/, index.html, the Vite config, the package
// and its lock), written into dist/source.sha256 after each build. mods/digest/page.test.ts recomputes it, so a
// change to the page's source that was not rebuilt and committed fails the gate.
//
//   bun stamp.ts          write dist/source.sha256 (the build script runs it after `vite build`)
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

/** The page package's folder. */
export const HERE = import.meta.dir
export const STAMP = "dist/source.sha256"
const INPUTS = ["index.html", "vite.config.ts", "package.json", "bun.lock", "tsconfig.json"]

const filesUnder = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))

/** The hash of the page's source as it is on disk now. */
export const sourceHash = (root: string = HERE): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  const files = [...INPUTS.map((name) => join(root, name)), ...filesUnder(join(root, "src"))].toSorted()
  for (const file of files) {
    hasher.update(`${relative(root, file)}\n`)
    hasher.update(readFileSync(file))
  }
  return hasher.digest("hex")
}

if (import.meta.main) writeFileSync(join(HERE, STAMP), `${sourceHash()}\n`)
