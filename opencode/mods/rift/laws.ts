// What every implementation of the rift tool's contracts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { RiftFailed, Rifts, SessionDirectories, SessionUnreadable } from "./service.ts"

/** An implementation of Rifts over one warm source. */
export interface RiftBench {
  readonly layer: Layer.Layer<Rifts>
  /** The warm source. */
  readonly source: string
  /** A directory inside it. */
  readonly inside: string
  /** A directory that is no Rift workspace. */
  readonly plain: string
  /** Commits a change in the Rift at `path` that exists nowhere else. */
  readonly commit: (path: string) => Effect.Effect<void>
  /** Leaves an uncommitted change in the Rift at `path`. */
  readonly dirty: (path: string) => Effect.Effect<void>
}

const check = <A, E>(bench: () => Effect.Effect<RiftBench, never, Scope.Scope>, body: (bench: RiftBench) => Effect.Effect<A, E, Rifts>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const made = yield* bench()
        return yield* body(made).pipe(Effect.provide(made.layer))
      }),
    ),
  )

/** `bench` makes a fresh implementation over a fresh warm source. */
export const riftsLaws = (name: string, bench: () => Effect.Effect<RiftBench, never, Scope.Scope>, timeout = 5_000) =>
  describe(`${name} keeps the Rifts laws`, () => {
    test(
      "a created Rift is listed under its source, on its branch and clean; the source, a directory in it and the Rift all have that source",
      () =>
        check(bench, (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            const path = yield* rifts.create({ source: made.source, from: made.inside, name: "feat-x", branch: "feat/x" })
            expect(path.endsWith("/feat-x")).toBe(true)
            expect(yield* rifts.list(made.source)).toEqual([path])
            const workspace = yield* rifts.inspect(path)
            expect(workspace).toMatchObject({ path, source: false, children: [], git: true, branch: "feat/x", uncommitted: [], unpushed: [], stashes: 0 })
            const source = yield* rifts.inspect(made.source)
            expect(source).toMatchObject({ source: true, children: [path] })
            expect(yield* rifts.source(made.source)).toBe(made.source)
            expect(yield* rifts.source(made.inside)).toBe(made.source)
            expect(yield* rifts.source(path)).toBe(made.source)
          }),
        ),
      timeout,
    )

    test(
      "a commit found only in a Rift is unpushed, an edit is uncommitted, and a removed Rift is listed no more",
      () =>
        check(bench, (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            const path = yield* rifts.create({ source: made.source, from: made.inside, name: "work", branch: "work" })
            yield* made.commit(path)
            yield* made.dirty(path)
            const workspace = yield* rifts.inspect(path)
            expect(workspace.unpushed).toHaveLength(1)
            expect(workspace.uncommitted).toHaveLength(1)
            yield* rifts.remove(path)
            expect(yield* rifts.list(made.source)).toEqual([])
          }),
        ),
      timeout,
    )

    test(
      "a second Rift of one name, and a directory that is no Rift, fail RiftFailed",
      () =>
        check(bench, (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            yield* rifts.create({ source: made.source, from: made.inside, name: "twice", branch: "twice" })
            const again = yield* Effect.flip(rifts.create({ source: made.source, from: made.inside, name: "twice", branch: "twice" }))
            expect(again).toBeInstanceOf(RiftFailed)
            expect(yield* Effect.flip(rifts.inspect(made.plain))).toBeInstanceOf(RiftFailed)
            expect(yield* Effect.flip(rifts.source(made.plain))).toBeInstanceOf(RiftFailed)
          }),
        ),
      timeout,
    )
  })

/** `layer` makes a fresh implementation over the sessions the host knows, each to its directory. */
export const sessionDirectoriesLaws = (name: string, layer: (world: Readonly<Record<string, string>>) => Layer.Layer<SessionDirectories>) =>
  describe(`${name} keeps the SessionDirectories laws`, () => {
    const world = { root: "/work/app" }

    test("a session's directory is the one the host knows; a session it cannot read fails SessionUnreadable naming it", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionDirectories
          expect(yield* sessions.directoryOf("root")).toBe("/work/app")
          const error = yield* Effect.flip(sessions.directoryOf("gone"))
          expect(error).toBeInstanceOf(SessionUnreadable)
          expect(error.sessionID).toBe("gone")
        }).pipe(Effect.provide(layer(world))),
      ))
  })
