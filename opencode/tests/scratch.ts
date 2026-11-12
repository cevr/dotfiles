import { afterAll } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
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

/** A test or setup body: synchronous, or a promise of its end. */
export type Body = () => PromiseLike<void> | void

/**
 * An e2e suite's directory: its scenarios' frames, logs and media for the run, removed at the
 * suite's end whether it passed or failed. It is made when the suite's first setup or test starts,
 * so a skipped suite, or one a `-t` filter leaves with nothing to run, makes none.
 */
export interface Kept {
  /** The suite's directory; "" for a suite that does not run. */
  readonly path: string
  /** A fresh directory inside it, for one scenario's output; after the suite's end it throws ENOENT and makes nothing. */
  readonly dir: (prefix: string) => string
  /** A test's body, run once the suite's directory exists. */
  readonly test: (body: Body) => () => Promise<void>
  /** A `beforeAll` body and its timeout, spread into the hook: `beforeAll(...kept.setup(body, ms))`. */
  readonly setup: (body: Body, timeoutMs: number) => readonly [() => Promise<void>, number]
  /** Ends the suite: removes its directory. */
  readonly done: () => void
}

/** A suite's directory name, unique but not made yet; "" for a suite that does not run. */
const suitePath = (runs: boolean, prefix: string) => {
  if (!runs) return ""
  return `${tmpdir()}/${prefix}${randomBytes(4).toString("hex")}`
}

/**
 * The directory of a `describe.skipIf(!runs)` suite. The suite ends at its `afterAll`, whatever a
 * `-t` filter left out or a test failed: keptScratch registers one that calls `done`, or, with
 * `closesItself`, the suite calls `done` last in its own `afterAll`, after what it stops still
 * writes there.
 */
export const keptScratch = (runs: boolean, prefix: string, closesItself = false): Kept => {
  const path = suitePath(runs, prefix)
  const suite = { ended: false }
  /** Makes the folder until the suite ends; after, a body Bun gave up on gets none, and its `dir` fails. */
  const make = () => {
    if (path !== "" && !suite.ended) mkdirSync(path, { recursive: true })
  }
  const run = async (body: Body) => {
    make()
    await body()
  }
  const done = () => {
    suite.ended = true
    if (path !== "") removeScratch(path)
  }
  if (runs && !closesItself) afterAll(done)
  return {
    path,
    dir: (inner) => {
      make()
      return mkdtempSync(`${path}/${inner}`)
    },
    test: (body) => () => run(body),
    setup: (body, timeoutMs) => [() => run(body), timeoutMs],
    done,
  }
}
