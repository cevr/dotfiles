import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect } from "effect"

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
 * An e2e suite's directory: its scenarios' frames, logs and media, kept for triage when the suite
 * fails and removed when it passes. Made only when the suite runs (`describe.skipIf(!runs)`), since
 * Bun reads a skipped suite's body but runs none of its hooks or tests; a skipped suite gets "" and
 * makes nothing.
 */
export interface Kept {
  /** The suite's directory. */
  readonly path: string
  /** A fresh directory inside it, for one scenario's output. */
  readonly dir: (prefix: string) => string
  /** A test's body that counts toward the suite: a failure keeps the directory and names it in its error. */
  readonly test: (body: Body) => () => Promise<void>
  /** A `beforeAll` body: a failure keeps the directory and names it in its error; it does not count as a test. */
  readonly setup: (body: Body) => () => Promise<void>
  /** Ends the suite: removes the directory unless a test or setup failed, or names it if one did. */
  readonly done: () => void
}

const suiteDirectory = (runs: boolean, prefix: string) => {
  if (!runs) return ""
  return mkdtempSync(`${tmpdir()}/${prefix}`)
}

/** The suite directory of a `describe.skipIf(!runs)` suite; with `closesItself`, the suite calls `done` in its own `afterAll`, else the last test to settle does. */
export const keptScratch = (runs: boolean, prefix: string, closesItself = false): Kept => {
  const path = suiteDirectory(runs, prefix)
  const state = { pending: 0, failed: false, closed: false }
  const done = () => {
    if (state.closed || path === "") return
    state.closed = true
    if (state.failed) console.error(`kept the failed suite's frames and logs: ${path}`)
    else removeScratch(path)
  }
  /** A failure keeps the directory; an Error's message names it. */
  const named = <E,>(error: E) => {
    state.failed = true
    if (error instanceof Error) error.message = `${error.message}\n(its frames and logs, kept: ${path})`
    return error
  }
  const run = (body: Body, counted: boolean): Promise<void> =>
    Effect.runPromise(
      Effect.tryPromise({ try: async () => body(), catch: (error) => named(error) }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!counted) return
            state.pending -= 1
            if (state.pending === 0 && !closesItself) done()
          }),
        ),
      ),
    )
  return {
    path,
    dir: (inner) => mkdtempSync(`${path}/${inner}`),
    test: (body) => {
      state.pending += 1
      return () => run(body, true)
    },
    setup: (body) => () => run(body, false),
    done,
  }
}
