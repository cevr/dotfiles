// The built page's stamp: one hash over everything the build reads (ui/, index.html, the Vite config, the package
// and its lock), and one over what the build wrote (dist/ but the stamp), written into dist/source.sha256 after each
// build as `<source hash>\n<dist hash>`. mods/digest/http/page.test.ts recomputes both, so a change to the page's
// source that was not rebuilt and committed fails the gate, and so does a hand edit of dist/.
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

/** One hash over `files`, each by its path under `root` and its bytes. */
const hashOf = (root: string, files: ReadonlyArray<string>): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of files.toSorted()) {
    hasher.update(`${relative(root, file)}\n`)
    hasher.update(readFileSync(file))
  }
  return hasher.digest("hex")
}

/** The hash of the page's source as it is on disk now. */
export const sourceHash = (root: string = HERE): string => hashOf(root, [...INPUTS.map((name) => join(root, name)), ...filesUnder(join(root, "ui"))])

/** The hash of the built page as it is on disk now: every file under dist/ but the stamp. */
export const distHash = (root: string = HERE): string => hashOf(root, filesUnder(join(root, "dist")).filter((file) => file !== join(root, STAMP)))

/** The stamp as it should read now. */
export const stampOf = (root: string = HERE): string => `${sourceHash(root)}\n${distHash(root)}\n`

if (import.meta.main) writeFileSync(join(HERE, STAMP), stampOf())
