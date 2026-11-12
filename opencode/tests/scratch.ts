import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

/**
 * A test's own directory under the system temp directory. Hold it with `using dir = scratch("name-")`:
 * it is removed when the block that holds it ends, whether the test passed or threw.
 */
export interface Scratch extends Disposable {
  readonly path: string
}

/** Removes a scratch directory and everything in it; one already gone is fine. */
export const removeScratch = (path: string) => rmSync(path, { recursive: true, force: true })

/** A fresh directory named `prefix` plus a random suffix, removed when its `using` block ends. */
export const scratch = (prefix: string): Scratch => {
  const path = mkdtempSync(`${tmpdir()}/${prefix}`)
  return { path, [Symbol.dispose]: () => removeScratch(path) }
}

/**
 * A fresh directory for a `describe.skipIf(!runs)` suite that removes it in its own `afterAll`: made
 * only when the suite runs, since Bun reads a skipped suite's body but runs none of its hooks. A
 * skipped suite gets "" and makes nothing.
 */
export const scratchWhen = (runs: boolean, prefix: string): string => {
  if (!runs) return ""
  return mkdtempSync(`${tmpdir()}/${prefix}`)
}
