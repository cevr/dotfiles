// The guard's handler over stand-ins for its contracts: it reads the call
// from the session's directory and its `workdir`, asks about each target's
// repository, and fails closed when it cannot tell. The domain fence keeps
// the root off its folders, so the stand-ins are built here from service.ts.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as Model from "./model.ts"
import { RepoRootUnknown, RepoRoots, SessionDirectories, SessionUnreadable, Subagents } from "./service.ts"
import type { Idle } from "./sleep.ts"
import type { Destructive } from "./verdict.ts"

const HOME = "/Users/owner"
const SESSIONS: Readonly<Record<string, string>> = { root: "/work/app/src", other: "/tmp/scratch", child: "/work/app/src", orphan: "/tmp/scratch" }

/** The repositories on the stand-in disk, and the paths it cannot read. */
interface Repos {
  readonly repos: ReadonlyArray<string>
  readonly unreadable?: ReadonlyArray<string>
}

const repoRoots = (world: Repos) =>
  Layer.succeed(
    RepoRoots,
    RepoRoots.of({
      isRoot: (path) =>
        world.unreadable?.includes(path)
          ? Effect.fail(new RepoRootUnknown({ path, message: "permission denied" }))
          : Effect.succeed(world.repos.includes(path)),
    }),
  )

const sessionDirectories = Layer.succeed(
  SessionDirectories,
  SessionDirectories.of({
    directoryOf: (sessionID) => {
      const directory = Object.hasOwn(SESSIONS, sessionID) ? SESSIONS[sessionID] : undefined
      return directory === undefined ? Effect.fail(new SessionUnreadable({ sessionID, message: `no session ${sessionID}` })) : Effect.succeed(directory)
    },
  }),
)

/** Each session's parent: `child` is a subagent of `root`, `other` is a root; any other session cannot be read. */
const PARENTS: Readonly<Record<string, string | undefined>> = { root: undefined, other: undefined, child: "root" }

const subagents = Layer.succeed(
  Subagents,
  Subagents.of({
    isSubagent: (sessionID) =>
      Object.hasOwn(PARENTS, sessionID)
        ? Effect.succeed(PARENTS[sessionID] !== undefined)
        : Effect.fail(new SessionUnreadable({ sessionID, message: `no session ${sessionID}` })),
  }),
)

const run = (call: Model.ShellCall, repos: Repos = { repos: ["/work/app"] }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const guard = yield* Model.Guard
      return yield* guard.judge(call).pipe(
        Effect.as(undefined),
        Effect.catchTag("Destructive", (refusal: Destructive) => Effect.succeed(refusal.reason)),
        Effect.catchTag("Idle", (refusal: Idle) => Effect.succeed(`idle: ${refusal.reason}`)),
      )
    }).pipe(
      Effect.provide(
        Model.layer({ home: HOME }).pipe(
          Layer.provide(Layer.mergeAll(repoRoots(repos), sessionDirectories, subagents)),
        ),
      ),
    ),
  )

describe("the guard", () => {
  test("lets a harmless call run and refuses one that loses work", async () => {
    expect(await run({ sessionID: "root", command: "ls -la" })).toBeUndefined()
    expect(await run({ sessionID: "root", command: "git reset --hard" })).toBe(
      "`git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first",
    )
  })

  test("reads paths from the session's directory, moved by the call's workdir", async () => {
    expect(await run({ sessionID: "root", command: "rm -rf ../../app" })).toContain("would delete the directory it runs in")
    expect(await run({ sessionID: "root", command: "rm -rf app", workdir: "../.." })).toContain("would delete the repository at /work/app")
    expect(await run({ sessionID: "other", command: "rm -rf ../app" })).toBeUndefined()
    expect(await run({ sessionID: "other", command: "rm -rf app", workdir: "/work" })).toContain("would delete the repository at /work/app")
    // The shell runs in the workdir: the session's own directory is a plain target from there.
    expect(await run({ sessionID: "root", command: "rm -rf src", workdir: ".." })).toBeUndefined()
    expect(await run({ sessionID: "root", command: "rm -rf .", workdir: ".." })).toContain("would delete the directory it runs in")
    expect(await run({ sessionID: "other", command: "rm -rf dotfiles", workdir: "~" })).toBeUndefined()
    expect(await run({ sessionID: "other", command: "rm -rf dotfiles", workdir: "~" }, { repos: [`${HOME}/dotfiles`] })).toContain(
      `would delete the repository at ${HOME}/dotfiles`,
    )
  })

  test("fails closed when it cannot tell where the call runs or what a target is", async () => {
    expect(await run({ sessionID: "gone", command: "ls" })).toBe("cannot tell where `ls` runs (no session gone); the guard refuses rather than guess")
    expect(await run({ sessionID: "other", command: "rm -rf locked" }, { repos: [], unreadable: ["/tmp/scratch/locked"] })).toBe(
      "cannot tell whether /tmp/scratch/locked is a repository (permission denied); remove what you mean by a path the guard can read",
    )
    // A path it cannot read is asked about only when a recursive rm names it.
    expect(await run({ sessionID: "other", command: "cat locked/x" }, { repos: [], unreadable: ["/tmp/scratch/locked"] })).toBeUndefined()
  })

  test("refuses a subagent's foreground call that opens by sleeping 30 s or more, and names the wait to use instead", async () => {
    const refused = await run({ sessionID: "child", command: "sleep 60 && tail -5 build.log" })
    expect(refused).toStartWith("idle: `sleep 60` would hold this subagent's turn for 60 s doing nothing")
    expect(refused).toContain('`shell({ action: "wait", id, ms })`')
    expect(refused).toContain("`background: true`")
    expect(await run({ sessionID: "child", command: "sleep 30; gh run view" })).toStartWith("idle: `sleep 30` would hold")
    expect(await run({ sessionID: "child", command: "sleep 2m" })).toStartWith("idle: `sleep 2m` would hold this subagent's turn for 120 s")
  })

  test("lets a root session sleep, a short sleep, a background sleep and a sleep later in the line run", async () => {
    expect(await run({ sessionID: "root", command: "sleep 600" })).toBeUndefined()
    expect(await run({ sessionID: "child", command: "sleep 29 && tail build.log" })).toBeUndefined()
    expect(await run({ sessionID: "child", command: "sleep 600", background: true })).toBeUndefined()
    expect(await run({ sessionID: "child", command: "until test -f done; do sleep 60; done" })).toBeUndefined()
    // A session the host cannot place as a subagent sleeps: a sleep loses nothing.
    expect(await run({ sessionID: "orphan", command: "sleep 600" })).toBeUndefined()
  })

  test("refuses a destructive call before it reads the sleep", async () => {
    expect(await run({ sessionID: "child", command: "sleep 60; git reset --hard" })).toBe(
      "`git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first",
    )
  })
})
