// What every implementation of the rift tool's contracts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { findRift } from "./find.ts"
import { AmbiguousRift, NoSuchRift } from "./rift.ts"
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
  /** Stashes a fresh change in the workspace at `path`, the warm source or a Rift. */
  readonly stash: (path: string) => Effect.Effect<void>
  /** Moves the Rift at `path` to a new branch, as work in it would. */
  readonly switchTo: (path: string, branch: string) => Effect.Effect<void>
  /** The warm source's HEAD commit, in full: a commit a new Rift can be detached at. */
  readonly head: Effect.Effect<string>
  /** A commit the repository and its origin lack. */
  readonly missing: string
}

/** Runs `body` over a fresh bench, its Rifts provided, the bench's scope closed after; for an implementation's own cases too. */
export const check = <B extends { readonly layer: Layer.Layer<Rifts> }, A, E>(
  bench: () => Effect.Effect<B, never, Scope.Scope>,
  body: (bench: B) => Effect.Effect<A, E, Rifts>,
) =>
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
      "a stash a Rift inherited from its warm source is not its own; one stashed in the Rift is",
      () =>
        check(bench, (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            yield* made.stash(made.source)
            const path = yield* rifts.create({ source: made.source, from: made.inside, name: "stashed", branch: "stashed" })
            expect((yield* rifts.inspect(path)).stashes).toBe(0)
            yield* made.stash(path)
            expect((yield* rifts.inspect(path)).stashes).toBe(1)
          }),
        ),
      timeout,
    )

    test(
      "land's findRift finds a Rift by path, by name or by branch (exact, else with / as -), and refuses a name two Rifts answer to, naming both",
      () =>
        check(bench, (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            // Named after their branches, as workrift names them; then each moves to a branch of its run.
            const lexer = yield* rifts.create({ source: made.source, from: made.inside, name: "fu-lexer", branch: "fu/lexer" })
            const parser = yield* rifts.create({ source: made.source, from: made.inside, name: "fu-parser", branch: "fu/parser" })
            yield* made.switchTo(lexer, "run/lexer")
            yield* made.switchTo(parser, "run-parser")
            const find = (target: string) => findRift(made.inside, made.source, target)
            expect(yield* find(lexer)).toBe(lexer)
            expect(yield* find("fu-lexer")).toBe(lexer)
            expect(yield* find("fu/lexer")).toBe(lexer)
            expect(yield* find("run/lexer")).toBe(lexer)
            expect(yield* find("run-lexer")).toBe(lexer)
            // An exact branch wins over another Rift's branch with / as -.
            expect(yield* find("run-parser")).toBe(parser)
            const missing = yield* Effect.flip(find("lexer"))
            expect(missing).toBeInstanceOf(NoSuchRift)

            yield* made.switchTo(parser, "run/lexer")
            const ambiguous = yield* Effect.flip(find("run/lexer"))
            expect(ambiguous).toBeInstanceOf(AmbiguousRift)
            expect(ambiguous._tag === "AmbiguousRift" && ambiguous.matches).toEqual([`${lexer} (branch run/lexer)`, `${parser} (branch run/lexer)`])
          }),
        ),
      timeout,
    )

    test(
      "a Rift created at a commit is detached there; at a commit the repository lacks it fails RiftFailed and leaves no Rift",
      () =>
        check(bench, (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            const head = yield* made.head
            const path = yield* rifts.create({ source: made.source, from: made.inside, name: "verify-batch-1", branch: "verify-batch-1", at: head })
            const workspace = yield* rifts.inspect(path)
            expect(workspace.branch).toBeUndefined()
            expect(workspace.head.length).toBeGreaterThan(0)
            expect(head.startsWith(workspace.head)).toBe(true)
            const failed = yield* Effect.flip(rifts.create({ source: made.source, from: made.inside, name: "verify-batch-2", branch: "verify-batch-2", at: made.missing }))
            expect(failed).toBeInstanceOf(RiftFailed)
            expect(failed.message).toContain("was removed")
            expect(yield* rifts.list(made.source)).toEqual([path])
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
