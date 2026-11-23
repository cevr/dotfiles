import { CryptoHasher, revision, version } from "bun"

/** Inputs every acceptance run shares, except the lint and unit gate. */
export const ACCEPT_SHARED = [
  "package.json", "bun.lock", "bunfig.toml", "tsconfig.json",
  "scripts/reach.ts", "scripts/read-declarations.ts", "scripts/test-read-project.ts",
  "scripts/test-reads.ts", "scripts/test-reads-ast.ts", "scripts/test-reads-modules.ts",
  "scripts/test-population.ts", "scripts/link-fork.ts", "scripts/accept.ts",
  "scripts/accept-plan.ts", "scripts/accept-ledger.ts", "scripts/accept-key.ts", "scripts/leaks.ts", "scripts/fork.ts",
]

/** The acceptance shared key, from a caller-provided file hash rather than a read of this checkout. */
export const acceptSharedFrom = (hashFile: (file: string) => string, fork: string, extra: ReadonlyArray<string>) => {
  const hash = new CryptoHasher("sha256")
  for (const file of ACCEPT_SHARED) hash.update(`${file}:${hashFile(file)}\n`)
  hash.update(`bun:${version}:${revision}\n`)
  hash.update(`${fork}\n`)
  for (const each of extra) hash.update(`${each}\n`)
  return hash.digest("hex")
}

/** An acceptance file's key: the shared key and the contents of the selected inputs. */
export const acceptKey = (shared: string, reached: Iterable<string>, hashFile: (file: string) => string, repoState = "") => {
  const hash = new CryptoHasher("sha256")
  hash.update(shared)
  if (repoState) hash.update(`\nrepository:${repoState}\n`)
  for (const file of [...reached].sort()) hash.update(`${file}:${hashFile(file)}\n`)
  return hash.digest("hex")
}
