// What every implementation of the guard's contracts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { Processes, RepoRootUnknown, RepoRoots, SessionDirectories, SessionUnreadable } from "./service.ts"

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

const check = <A, E>(bench: () => Effect.Effect<RepoBench, never, Scope.Scope>, body: (bench: RepoBench) => Effect.Effect<A, E, RepoRoots>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const made = yield* bench()
        return yield* body(made).pipe(Effect.provide(made.layer))
      }),
    ),
  )

/** `bench` makes a fresh implementation over a repository, a directory in it, a plain directory and a missing path. */
export const repoRootsLaws = (name: string, bench: () => Effect.Effect<RepoBench, never, Scope.Scope>) =>
  describe(`${name} keeps the RepoRoots laws`, () => {
    test("a repository's root is one; a directory inside it, a plain directory and a missing path are not", () =>
      check(bench, (paths) =>
        Effect.gen(function* () {
          const roots = yield* RepoRoots
          expect(yield* roots.isRoot(paths.repo)).toBe(true)
          expect(yield* roots.isRoot(paths.inside)).toBe(false)
          expect(yield* roots.isRoot(paths.plain)).toBe(false)
          expect(yield* roots.isRoot(paths.missing)).toBe(false)
        }),
      ))

    test("a path it cannot read fails RepoRootUnknown naming the path, never a guess", () =>
      check(bench, (paths) =>
        Effect.gen(function* () {
          if (paths.unreadable === undefined) return
          const roots = yield* RepoRoots
          const error = yield* Effect.flip(roots.isRoot(paths.unreadable))
          expect(error).toBeInstanceOf(RepoRootUnknown)
          expect(error.path).toBe(paths.unreadable)
        }),
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
