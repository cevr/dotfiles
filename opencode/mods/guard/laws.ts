// What every implementation of the guard's contracts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option, Result, type Scope } from "effect"
import { Checkouts, Processes, RepoRootUnknown, RepoRoots, SessionDirectories, SessionUnreadable, Subagents, type WarmSource } from "./service.ts"

/** `layer` lists the processes running now; `self` is a process it must list: the test's own. */
export const processesLaws = (name: string, layer: Layer.Layer<Processes>, self: { readonly pid: number; readonly args: string }) =>
  describe(`${name} keeps the Processes laws`, () => {
    test("it lists the running process with its name and its whole command line, each PID once", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const listed = yield* (yield* Processes).list()
          const own = listed.find((each) => each.pid === self.pid)
          expect(own?.args).toBe(self.args)
          expect(own?.name).not.toBe("")
          expect(new Set(listed.map((each) => each.pid)).size).toBe(listed.length)
        }).pipe(Effect.provide(layer)),
      ))
  })

/** An implementation of RepoRoots and the paths it was set up with. */
export interface RepoBench {
  readonly layer: Layer.Layer<RepoRoots>
  /** A repository's root. */
  readonly repo: string
  /** A directory inside that repository. */
  readonly inside: string
  /** A directory that is no repository. */
  readonly plain: string
  /** A path that does not exist. */
  readonly missing: string
  /** A path the implementation cannot read, when it can set one up. */
  readonly unreadable?: string
}

/** A bench's layer. */
const layerOf = <S>(bench: { readonly layer: Layer.Layer<S> }): Layer.Layer<S> => bench.layer

/** Makes a fresh bench, runs `body` on its layer, and releases the bench. */
const check = <B, S, A, E>(bench: () => Effect.Effect<B, never, Scope.Scope>, layerOf: (bench: B) => Layer.Layer<S>, body: (bench: B) => Effect.Effect<A, E, S>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const made = yield* bench()
        return yield* body(made).pipe(Effect.provide(layerOf(made)))
      }),
    ),
  )

/** `bench` makes a fresh implementation over a repository, a directory in it, a plain directory and a missing path. */
export const repoRootsLaws = (name: string, bench: () => Effect.Effect<RepoBench, never, Scope.Scope>) =>
  describe(`${name} keeps the RepoRoots laws`, () => {
    test("a repository's root is one; a directory inside it, a plain directory and a missing path are not", () =>
      check(bench, layerOf, (paths) =>
        Effect.gen(function* () {
          const roots = yield* RepoRoots
          expect(yield* roots.isRoot(paths.repo)).toBe(true)
          expect(yield* roots.isRoot(paths.inside)).toBe(false)
          expect(yield* roots.isRoot(paths.plain)).toBe(false)
          expect(yield* roots.isRoot(paths.missing)).toBe(false)
        }),
      ))

    test("a path it cannot read fails RepoRootUnknown naming the path, never a guess", () =>
      check(bench, layerOf, (paths) =>
        Effect.gen(function* () {
          if (paths.unreadable === undefined) return
          const roots = yield* RepoRoots
          const error = yield* Effect.flip(roots.isRoot(paths.unreadable))
          expect(error).toBeInstanceOf(RepoRootUnknown)
          expect(error.path).toBe(paths.unreadable)
        }),
      ))
  })

/** An implementation of Checkouts and what it was set up with. */
export interface CheckoutBench {
  readonly layer: Layer.Layer<Checkouts>
  /** A checkout's root, with an origin. */
  readonly repo: string
  readonly origin: string
  /** The type of the file system the checkouts sit on, as `mount` names it. */
  readonly filesystem: string
  /** A directory inside that checkout. */
  readonly inside: string
  /** A checkout with no origin. */
  readonly bare: string
  /** A directory no checkout holds. */
  readonly plain: string
  /** A path that does not exist. */
  readonly missing: string
  /** The warm sources the implementation lists, in order; a failure when it cannot list them. */
  readonly sources: ReadonlyArray<WarmSource> | "unreadable"
}

/** `bench` makes a fresh implementation over a checkout with an origin, a directory in it, one with none, a plain directory and a missing path. */
export const checkoutsLaws = (name: string, bench: () => Effect.Effect<CheckoutBench, never, Scope.Scope>) =>
  describe(`${name} keeps the Checkouts laws`, () => {
    test("a directory in a checkout answers its root, the file system it sits on and its origin, the same from anywhere in it", () =>
      check(bench, layerOf, (made) =>
        Effect.gen(function* () {
          const checkouts = yield* Checkouts
          const top = yield* checkouts.of(made.repo)
          expect(top).toEqual(Option.some({ root: made.repo, filesystem: made.filesystem, origin: Option.some(made.origin) }))
          expect(yield* checkouts.of(made.inside)).toEqual(top)
          expect(yield* checkouts.of(made.bare)).toEqual(Option.some({ root: made.bare, filesystem: made.filesystem, origin: Option.none() }))
        }),
      ))

    test("a directory no checkout holds, and a missing path, are none", () =>
      check(bench, layerOf, (made) =>
        Effect.gen(function* () {
          const checkouts = yield* Checkouts
          expect(yield* checkouts.of(made.plain)).toEqual(Option.none())
          expect(yield* checkouts.of(made.missing)).toEqual(Option.none())
        }),
      ))

    test("the warm sources are listed with their origins, or fail CheckoutUnknown when they cannot be, never a guess", () =>
      check(bench, layerOf, (made) =>
        Effect.gen(function* () {
          const listed = yield* Effect.result((yield* Checkouts).warmSources)
          if (made.sources === "unreadable") expect(listed._tag === "Failure" && listed.failure._tag).toBe("CheckoutUnknown")
          else expect(listed).toEqual(Result.succeed(made.sources))
        }),
      ))
  })

/** `layer` makes a fresh implementation over the sessions the host knows, each to its parent (undefined for a root session). */
export const subagentsLaws = (name: string, layer: (world: Readonly<Record<string, string | undefined>>) => Layer.Layer<Subagents>) =>
  describe(`${name} keeps the Subagents laws`, () => {
    const world = { root: undefined, child: "root", grandchild: "child" }

    test("a session with a parent is a subagent; a root session is not", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const subagents = yield* Subagents
          expect(yield* subagents.isSubagent("root")).toBe(false)
          expect(yield* subagents.isSubagent("child")).toBe(true)
          expect(yield* subagents.isSubagent("grandchild")).toBe(true)
        }).pipe(Effect.provide(layer(world))),
      ))

    test("a session the host cannot read fails SessionUnreadable naming it", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* Subagents).isSubagent("gone"))
          expect(error).toBeInstanceOf(SessionUnreadable)
          expect(error.sessionID).toBe("gone")
        }).pipe(Effect.provide(layer(world))),
      ))
  })

/** `layer` makes a fresh implementation over the sessions the host knows, each to its directory. */
export const sessionDirectoriesLaws = (name: string, layer: (world: Readonly<Record<string, string>>) => Layer.Layer<SessionDirectories>) =>
  describe(`${name} keeps the SessionDirectories laws`, () => {
    const world = { root: "/work/app", child: "/work/app/packages/core" }

    test("a session's directory is the one the host knows", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionDirectories
          expect(yield* sessions.directoryOf("root")).toBe("/work/app")
          expect(yield* sessions.directoryOf("child")).toBe("/work/app/packages/core")
        }).pipe(Effect.provide(layer(world))),
      ))

    test("a session the host cannot read fails SessionUnreadable naming it", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionDirectories
          const error = yield* Effect.flip(sessions.directoryOf("gone"))
          expect(error).toBeInstanceOf(SessionUnreadable)
          expect(error.sessionID).toBe("gone")
        }).pipe(Effect.provide(layer(world))),
      ))
  })
