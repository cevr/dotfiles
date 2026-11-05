// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option, type Scope } from "effect"
import { type ChangedFile, EMPTY_TREE } from "./checkout.ts"
import type { PullRequest } from "./pull-request.ts"
import { SIGNED_OUT } from "./pull-request.ts"
import { Checkouts, Programs, PullRequests, SessionDirectories, SessionUnreadable } from "./service.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

const byPath = (files: ReadonlyArray<ChangedFile>) => [...files].sort((left, right) => left.path.localeCompare(right.path))

// ── SessionDirectories ──

export const sessionDirectoriesLaws = (name: string, layer: (world: Readonly<Record<string, string>>) => Layer.Layer<SessionDirectories>) =>
  describe(`${name} keeps the SessionDirectories laws`, () => {
    test("a session's directory is the one the host knows now", () =>
      scenario(
        Effect.gen(function* () {
          const world: Record<string, string> = { root: "/work/app" }
          const sessions = yield* SessionDirectories.pipe(Effect.provide(layer(world)))
          expect(yield* sessions.directoryOf("root")).toBe("/work/app")
          world.root = "/work/moved"
          expect(yield* sessions.directoryOf("root")).toBe("/work/moved")
        }),
      ))

    test("a session the host cannot read fails SessionUnreadable naming it", () =>
      scenario(
        Effect.gen(function* () {
          const sessions = yield* SessionDirectories.pipe(Effect.provide(layer({})))
          const error = yield* Effect.flip(sessions.directoryOf("gone"))
          expect(error).toBeInstanceOf(SessionUnreadable)
          expect(error.sessionID).toBe("gone")
        }),
      ))
  })

// ── Checkouts ──

/**
 * Checkouts under test, each directory set up as its doc says, and ways to
 * change them.
 */
export interface CheckoutsProbe {
  readonly layer: Layer.Layer<Checkouts>
  /**
   * The top of a checkout on branch `feature`, tracking `origin/main`, one
   * commit ahead of it and one behind, with: `a.txt` modified (`one\n` to
   * `uno\n`), `old.txt` renamed to `moved.txt` (staged, content unchanged),
   * `staged.txt` added (staged, three lines), `new.txt` untracked (two
   * lines) and `logo.bin` untracked (binary).
   */
  readonly repository: string
  /** A directory inside `repository`. */
  readonly nested: string
  /** A checkout on the unborn branch `main` with `first.txt` (one line) staged. */
  readonly unborn: string
  /** A directory in no checkout. */
  readonly outside: string
  /** A path that does not exist. */
  readonly gone: string
  /** Writes the untracked file `later.txt` (one line) into `repository`. */
  readonly write: Effect.Effect<void>
  /** Makes `repository` unreadable to git (a corrupt index). */
  readonly spoil: Effect.Effect<void>
}

export const checkoutsLaws = (name: string, make: Effect.Effect<CheckoutsProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the Checkouts laws`, () => {
    const repositoryFiles: ReadonlyArray<ChangedFile> = [
      { path: "a.txt", status: "M", added: 1, deleted: 1 },
      { path: "logo.bin", status: "?" },
      { path: "moved.txt", from: "old.txt", status: "R", added: 0, deleted: 0 },
      { path: "new.txt", status: "?", added: 2, deleted: 0 },
      { path: "staged.txt", status: "A", added: 3, deleted: 0 },
    ]

    test("reads the branch, its upstream, and every change with its lines against HEAD", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const read = yield* Checkouts.use((checkouts) => checkouts.read(probe.repository)).pipe(Effect.provide(probe.layer))
          expect(Option.map(read, (checkout) => ({ ...checkout, files: byPath(checkout.files) }))).toEqual(
            Option.some({
              root: probe.repository,
              base: "HEAD",
              head: { branch: "feature", oid: expect.stringMatching(/^[0-9a-f]{40}$/), upstream: "origin/main", ahead: 1, behind: 1 },
              files: [...repositoryFiles],
            }),
          )
        }),
      ))

    test("a directory inside the checkout reads the checkout from its top", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const read = yield* Checkouts.use((checkouts) => checkouts.read(probe.nested)).pipe(Effect.provide(probe.layer))
          expect(Option.map(read, (checkout) => [checkout.root, byPath(checkout.files)])).toEqual(Option.some([probe.repository, [...repositoryFiles]]))
        }),
      ))

    test("an unborn branch counts its changes against the empty tree", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const read = yield* Checkouts.use((checkouts) => checkouts.read(probe.unborn)).pipe(Effect.provide(probe.layer))
          expect(read).toEqual(
            Option.some({
              root: probe.unborn,
              base: EMPTY_TREE.sha1,
              head: { branch: "main", ahead: 0, behind: 0 },
              files: [{ path: "first.txt", status: "A", added: 1, deleted: 0 }],
            }),
          )
        }),
      ))

    test("a directory in no checkout, and one that is gone, have none", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const read = (directory: string) => Checkouts.use((checkouts) => checkouts.read(directory)).pipe(Effect.provide(probe.layer))
          expect(yield* read(probe.outside)).toEqual(Option.none())
          expect(yield* read(probe.gone)).toEqual(Option.none())
        }),
      ))

    test("reads afresh on every call", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const read = Checkouts.use((checkouts) => checkouts.read(probe.repository)).pipe(Effect.provide(probe.layer))
          expect(Option.map(yield* read, (checkout) => checkout.files.length)).toEqual(Option.some(5))
          yield* probe.write
          const files = Option.map(yield* read, (checkout) => checkout.files.find((file) => file.path === "later.txt"))
          expect(files).toEqual(Option.some({ path: "later.txt", status: "?", added: 1, deleted: 0 }))
        }),
      ))

    test("a checkout git cannot read fails CheckoutUnreadable and says why", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          yield* probe.spoil
          const failure = yield* Checkouts.use((checkouts) => checkouts.read(probe.repository)).pipe(Effect.provide(probe.layer), Effect.flip)
          expect(failure._tag).toBe("CheckoutUnreadable")
          expect(failure.message).toStartWith("git ")
        }),
      ))
  })

// ── PullRequests ──

/** The request every law's `open` world answers with. */
export const OPEN_REQUEST: PullRequest = {
  number: 123,
  title: "Port the git sidebar",
  url: "https://github.com/cevr/dotfiles/pull/123",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
}

/**
 * What `gh` does in a law's world: answers with OPEN_REQUEST, says the branch
 * has no request, says it is signed out, fails another way, answers with
 * something that is not a request, or is not there at all.
 */
export type GhWorld = "open" | "none" | "signed-out" | "failing" | "garbage" | "missing"

export interface PullRequestsProbe {
  readonly layer: Layer.Layer<PullRequests>
  /** The checkout root to ask about. */
  readonly root: string
}

export const pullRequestsLaws = (name: string, make: (world: GhWorld) => Effect.Effect<PullRequestsProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the PullRequests laws`, () => {
    const read = (world: GhWorld) =>
      Effect.gen(function* () {
        const probe = yield* make(world)
        return yield* PullRequests.use((requests) => requests.read(probe.root)).pipe(Effect.provide(probe.layer))
      })

    test("names the branch's request", () => scenario(Effect.gen(function* () {
      expect(yield* read("open")).toEqual(Option.some(OPEN_REQUEST))
    })))

    test("a branch with no request, or a checkout with no GitHub remote, has none", () => scenario(Effect.gen(function* () {
      expect(yield* read("none")).toEqual(Option.none())
    })))

    test("no gh fails GhMissing", () => scenario(Effect.gen(function* () {
      expect((yield* Effect.flip(read("missing")))._tag).toBe("GhMissing")
    })))

    test("a signed-out gh fails PullRequestUnreadable saying how to sign in", () => scenario(Effect.gen(function* () {
      expect(yield* Effect.flip(read("signed-out"))).toMatchObject({ _tag: "PullRequestUnreadable", message: SIGNED_OUT })
    })))

    test("a gh that fails, or answers with no request, fails PullRequestUnreadable and says why", () => scenario(Effect.gen(function* () {
      const failing = yield* Effect.flip(read("failing"))
      expect(failing._tag).toBe("PullRequestUnreadable")
      expect(failing._tag === "PullRequestUnreadable" ? failing.message : "").toStartWith("gh pr view: ")
      expect(yield* Effect.flip(read("garbage"))).toMatchObject({ _tag: "PullRequestUnreadable", message: "gh pr view: unreadable answer" })
    })))
  })

// ── Programs ──

/** `make(names)` gives Programs on which exactly `names` are found. */
export const programsLaws = (name: string, make: (names: ReadonlyArray<string>) => Effect.Effect<Layer.Layer<Programs>, never, Scope.Scope>) =>
  describe(`${name} keeps the Programs laws`, () => {
    test("finds the programs there are, and only those", () =>
      scenario(
        Effect.gen(function* () {
          const programs = yield* Programs.pipe(Effect.provide(yield* make(["hunk"])))
          expect(yield* programs.found("hunk")).toBe(true)
          expect(yield* programs.found("no-such-program-anywhere")).toBe(false)
        }),
      ))

    test("with none there, finds none", () =>
      scenario(
        Effect.gen(function* () {
          const programs = yield* Programs.pipe(Effect.provide(yield* make([])))
          expect(yield* programs.found("hunk")).toBe(false)
        }),
      ))
  })
