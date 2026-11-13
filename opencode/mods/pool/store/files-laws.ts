// What every keeper of a login store's files and lock (store.ts `SlotFiles`)
// owes, as a shared suite: the disk (`NODE_FILES`, files.test.ts) and the
// memory double the simulated world uses (memory/slots.ts) both run it.
import { describe, expect, test } from "bun:test"
import { Effect, Option, type Scope } from "effect"
import { type SlotFiles, withStoreLock } from "./store.ts"

/** A store's files over an empty directory `dir` with nothing else in it. */
export interface SlotFilesWorld {
  readonly files: SlotFiles
  readonly dir: string
}

const law = (name: string, body: Effect.Effect<void, unknown, Scope.Scope>) =>
  test(name, () => Effect.runPromise(Effect.scoped(body)))

/** `world` opens a fresh, empty directory each time, closed with its scope. */
export const slotFilesLaws = (name: string, world: Effect.Effect<SlotFilesWorld, never, Scope.Scope>) =>
  describe(`${name} keeps the login store files laws`, () => {
    law(
      "a missing file fails as missing; a written file reads back whole; a second write replaces it",
      Effect.gen(function* () {
        const { files, dir } = yield* world
        const missing = yield* Effect.flip(files.read(`${dir}/alpha`))
        expect(missing).toMatchObject({ code: "ENOENT" })
        yield* files.write(`${dir}/alpha`, '{"first":1}')
        expect(yield* files.read(`${dir}/alpha`)).toBe('{"first":1}')
        yield* files.write(`${dir}/alpha`, "{}")
        expect(yield* files.read(`${dir}/alpha`)).toBe("{}")
      }),
    )

    law(
      "names lists the files written, and nothing staged beside them",
      Effect.gen(function* () {
        const { files, dir } = yield* world
        yield* files.write(`${dir}/beta`, "{}")
        yield* files.write(`${dir}/alpha`, "{}")
        expect([...(yield* files.names(dir))].sort()).toEqual(["alpha", "beta"])
      }),
    )

    law(
      "the lock has one holder: a second try finds it held until the first lets go",
      Effect.gen(function* () {
        const { files, dir } = yield* world
        const first = yield* files.tryLock(dir)
        expect(Option.isSome(first)).toBe(true)
        expect(Option.isNone(yield* files.tryLock(dir))).toBe(true)
        yield* Option.getOrElse(first, () => Effect.void)
        const second = yield* files.tryLock(dir)
        expect(Option.isSome(second)).toBe(true)
        yield* Option.getOrElse(second, () => Effect.void)
      }),
    )

    law(
      "a lock held through every poll gives up busy, with a time to try again; once let go, the work runs",
      Effect.gen(function* () {
        const { files, dir } = yield* world
        const held = yield* files.tryLock(dir)
        const failed = yield* Effect.flip(withStoreLock(dir, Effect.void, 2, files))
        expect(failed.kind).toBe("busy")
        expect(failed.retryAt ?? 0).toBeGreaterThan(0)
        yield* Option.getOrElse(held, () => Effect.void)
        expect(yield* withStoreLock(dir, Effect.succeed("ran"), 2, files)).toBe("ran")
      }),
    )
  })
