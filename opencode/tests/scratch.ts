import { afterAll, onTestFinished } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
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
 * fails and removed when it passes. It is made when the suite's first setup or test starts, so a
 * skipped suite, or one a `-t` filter leaves with nothing to run, makes none.
 */
export interface Kept {
  /** The suite's directory; "" for a suite that does not run. */
  readonly path: string
  /** A fresh directory inside it, for one scenario's output. */
  readonly dir: (prefix: string) => string
  /** A test's body: a failure, or a timeout it never returns from, keeps the directory and names it. */
  readonly test: (body: Body) => () => Promise<void>
  /**
   * A `beforeAll` body and its timeout, spread into the hook: `beforeAll(...kept.setup(body, ms))`.
   * A failure, or a timeout, keeps the directory and names it, even when the body returns later.
   */
  readonly setup: (body: Body, timeoutMs: number) => readonly [() => Promise<void>, number]
  /** Ends the suite: removes the directory, or keeps and names it when a setup or test failed or never returned. */
  readonly done: () => void
}

/** Where a kept directory is named, so triage finds its frames and logs. */
const keptLine = (path: string) => `(its frames and logs, kept: ${path})`

/** A suite's directory name, unique but not made yet; "" for a suite that does not run. */
const suitePath = (runs: boolean, prefix: string) => {
  if (!runs) return ""
  return `${tmpdir()}/${prefix}${randomBytes(4).toString("hex")}`
}

/** Whether one body has returned, so a test that ends first ran out of time. */
interface Settled {
  settled: boolean
}

/**
 * The directory of a `describe.skipIf(!runs)` suite. The suite ends at its `afterAll`, whatever a
 * `-t` filter left out: keptScratch registers one that calls `done`, or, with `closesItself`, the
 * suite calls `done` last in its own `afterAll`, after what it stops still writes there.
 */
export const keptScratch = (runs: boolean, prefix: string, closesItself = false): Kept => {
  const path = suitePath(runs, prefix)
  const state = { failed: false, running: 0, closed: false }
  const make = () => {
    if (path !== "") mkdirSync(path, { recursive: true })
  }
  const done = () => {
    if (state.closed || path === "") return
    state.closed = true
    if (state.failed || state.running > 0) console.error(`kept the failed suite's frames and logs: ${path}`)
    else removeScratch(path)
  }
  /** A failure keeps the directory; an Error's message names it. */
  const named = <E,>(error: E) => {
    state.failed = true
    if (error instanceof Error) error.message = `${error.message}\n${keptLine(path)}`
    return error
  }
  /** A body Bun gave up on: the suite failed, whatever the body does later. */
  const outlived = (what: string) => {
    state.failed = true
    console.error(`a ${what} outlived its timeout ${keptLine(path)}`)
  }
  /**
   * Runs a body and hands `ended` the milliseconds it took; one Bun gives up on at its timeout
   * stays running, which `done` reads as a failure.
   */
  const run = (body: Body, ended: (tookMs: number) => void): Promise<void> => {
    make()
    state.running += 1
    const started = performance.now()
    return Effect.runPromise(
      Effect.tryPromise({ try: async () => body(), catch: (error) => named(error) }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            state.running -= 1
            ended(performance.now() - started)
          }),
        ),
      ),
    )
  }
  if (runs && !closesItself) afterAll(done)
  return {
    path,
    dir: (inner) => {
      make()
      return mkdtempSync(`${path}/${inner}`)
    },
    test: (body) => () => {
      const each: Settled = { settled: false }
      onTestFinished(() => {
        if (!each.settled) outlived("test")
      })
      return run(body, () => {
        each.settled = true
      })
    },
    setup: (body, timeoutMs) => [
      () =>
        run(body, (tookMs) => {
          if (tookMs > timeoutMs) outlived("setup")
        }),
      timeoutMs,
    ],
    done,
  }
}
