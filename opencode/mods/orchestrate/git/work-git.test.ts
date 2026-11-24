// WorkGit over real git in a scratch folder: a base with its default branch `main`, and lanes copied from it whole
// (as `work` copies one), whose commits the base never fetched. Each head is read in the base with the lanes'
// objects borrowed: on main (merged), patch-equivalent (cherry-picked; rebased then squash-merged), absent (its own
// commits nowhere on main, a stack above another lane's), unknown (its lane removed). The lanes are never written by
// the read; a process working in a lane holds it.
import { describe, expect, test } from "bun:test"
import { env as processEnv, spawn, spawnSync } from "bun"
import { Effect, Layer, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import { OnMain } from "../lost.ts"
import { WorkGit } from "../service.ts"
import * as Live from "./work-git.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const ENV = {
  GIT_AUTHOR_NAME: "Lost Test",
  GIT_AUTHOR_EMAIL: "lost@example.invalid",
  GIT_COMMITTER_NAME: "Lost Test",
  GIT_COMMITTER_EMAIL: "lost@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  PATH: processEnv["PATH"] ?? "/usr/bin:/bin",
  HOME: "/nonexistent/loop-probe-x",
}

/** Runs `argv` in `cwd`; its output, or a defect naming what failed. */
const sh = (cwd: string, ...argv: ReadonlyArray<string>) =>
  Effect.sync(() => spawnSync([...argv], { cwd, env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" })).pipe(
    Effect.filterOrElse(
      (ran) => ran.exitCode === 0,
      (ran) => Effect.die(`${argv.join(" ")} in ${cwd}: ${ran.stderr.toString()}`),
    ),
    Effect.map((ran) => ran.stdout.toString().trim()),
  )

/** A commit in `repo` of `name` with `text`, its subject `subject`; its full hash. */
const commit = (repo: string, name: string, text: string, subject: string) =>
  Effect.gen(function* () {
    yield* sh(repo, "sh", "-c", 'printf "%s\\n" "$1" > "$2"', "write", text, name)
    yield* sh(repo, "git", "add", name)
    yield* sh(repo, "git", "commit", "-q", "-m", subject)
    return yield* sh(repo, "git", "rev-parse", "HEAD")
  })

/** A lane copied from `from` whole, as work copies a workspace. */
const laneOf = (from: string, to: string) => sh("/", "cp", "-R", from, to).pipe(Effect.as(to))

const bench = Effect.acquireRelease(
  Effect.sync(() => scratch("work-git-")),
  (made) => Effect.sync(() => made[Symbol.dispose]()),
  // Its real path (macOS's temp folder is behind a link), as a process's working directory reads.
).pipe(Effect.flatMap((made) => sh(made.path, "pwd", "-P")))

effectTest(
  "each lane's head against main, read in the base with the lanes' objects borrowed: on main, patch-equivalent, absent, stacked, unknown",
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* bench
      const base = `${root}/app`
      yield* Effect.sync(() => gitInit(base, ["-q", "-b", "main"], ENV))
      yield* sh(base, "git", "config", "gc.auto", "0")
      yield* commit(base, "README", "base", "base")
      const alpha = yield* laneOf(base, `${root}/alpha`)
      yield* commit(alpha, "a.txt", "one", "alpha one")
      const alphaHead = yield* commit(alpha, "a.txt", "two", "alpha two")
      const picked = yield* laneOf(base, `${root}/picked`)
      const pickedHead = yield* commit(picked, "p.txt", "picked", "picked work")
      const merged = yield* laneOf(base, `${root}/merged`)
      const mergedHead = yield* commit(merged, "m.txt", "merged", "merged work")
      const gone = yield* laneOf(base, `${root}/gone`)
      const goneHead = yield* commit(gone, "g.txt", "gone", "gone work")
      const stacked = yield* laneOf(alpha, `${root}/stacked`)
      const stackedHead = yield* commit(stacked, "s.txt", "stacked", "stacked work")
      // Main moves on; the squashed lane rebases onto it, then lands squashed.
      yield* commit(base, "main.txt", "moved", "main moves")
      const squashed = yield* laneOf(base, `${root}/squashed`)
      const squashedHead = yield* commit(squashed, "q.txt", "squashed", "squashed work")
      // The base takes three of them as a land would: a cherry-pick, a merge, a squash.
      yield* sh(base, "git", "fetch", "-q", picked, "HEAD")
      yield* sh(base, "git", "cherry-pick", "FETCH_HEAD")
      yield* sh(base, "git", "fetch", "-q", merged, "HEAD")
      yield* sh(base, "git", "merge", "-q", "--no-edit", "FETCH_HEAD")
      yield* sh(base, "git", "fetch", "-q", squashed, "HEAD")
      yield* sh(base, "git", "merge", "-q", "--squash", "FETCH_HEAD")
      yield* sh(base, "git", "commit", "-q", "-m", "squashed as one")
      yield* sh(root, "rm", "-r", gone)
      const before = yield* sh(alpha, "git", "status", "--porcelain=v2", "--branch")
      const git = yield* WorkGit
      const own = (head: string, lane: string) => ({ head, lanes: [lane] })
      const tagOf = (seen: ReadonlyMap<string, { readonly onMain: OnMain }>, head: string) => Option.map(Option.fromUndefinedOr(seen.get(head)), (each): string => each.onMain._tag)
      // Only the lanes named for a head are borrowed: the stacked head is in no other lane's objects (and, unknown, is not kept).
      expect(tagOf(yield* git.heads(base, "main", [own(stackedHead, picked)]), stackedHead)).toEqual(Option.some("Unknown"))
      const seen = yield* git.heads(base, "main", [own(alphaHead, alpha), own(pickedHead, picked), own(mergedHead, merged), own(goneHead, gone), own(stackedHead, stacked), own(squashedHead, squashed)])
      const tags = [alphaHead, pickedHead, mergedHead, goneHead, stackedHead, squashedHead].map((head) => tagOf(seen, head))
      expect(tags).toEqual(["Absent", "Equivalent", "Landed", "Unknown", "Absent", "Equivalent"].map(Option.some))
      const absent = Option.liftPredicate(Option.getOrThrow(Option.fromUndefinedOr(seen.get(alphaHead))).onMain, OnMain.guards.Absent)
      expect(Option.map(absent, (each) => [each.missing.length, each.subject, each.missing[0]])).toEqual(Option.some([2, "alpha two", alphaHead]))
      const stack = Option.liftPredicate(Option.getOrThrow(Option.fromUndefinedOr(seen.get(stackedHead))).onMain, OnMain.guards.Absent)
      expect(Option.map(stack, (each) => [each.missing.length, each.own.includes(alphaHead)])).toEqual(Option.some([3, true]))
      expect(Option.isSome(Option.getOrThrow(Option.fromUndefinedOr(seen.get(alphaHead))).at)).toBe(true)
      // A short name reads too; a read never writes in a lane.
      expect(tagOf(yield* git.heads(base, "main", [own(alphaHead.slice(0, 9), alpha)]), alphaHead.slice(0, 9))).toEqual(Option.some("Absent"))
      expect(yield* sh(alpha, "git", "status", "--porcelain=v2", "--branch")).toBe(before)
      // The default branch's first-parent line: base, main moves, the pick, the merge, the squash.
      expect((yield* git.lands(base, "main", 10)).length).toBe(5)
      expect(Option.isSome(yield* git.touchedAt(alpha))).toBe(true)
      expect(yield* git.touchedAt(gone)).toEqual(Option.none())
      // Alpha lands: read again at the new tip, it is on main (an absent head is kept per tip, never past a land).
      yield* sh(base, "git", "fetch", "-q", alpha, "HEAD")
      yield* sh(base, "git", "merge", "-q", "--no-edit", "FETCH_HEAD")
      expect(tagOf(yield* git.heads(base, "main", [own(alphaHead, alpha)]), alphaHead)).toEqual(Option.some("Landed"))
    }),
  ).pipe(Effect.provide(Live.layer)),
  hangGuard("process-fixture"),
)

effectTest(
  "a lane some process works in is held; the others are not",
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* bench
      const busy = `${root}/busy`
      const idle = `${root}/idle`
      yield* sh(root, "mkdir", "-p", `${busy}/src`, idle)
      // A process of its own group, working in a folder inside the lane, killed with its group when the test ends.
      yield* Effect.acquireRelease(
        Effect.sync(() => spawn(["sleep", "60"], { cwd: `${busy}/src`, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true })),
        (child) => Effect.sync(() => child.kill()),
      )
      const git = yield* WorkGit
      const held = yield* Effect.retry(
        git.held([busy, idle]).pipe(Effect.filterOrFail((found) => found.has(busy), () => "not yet")),
        { times: 20 },
      )
      expect([...held]).toEqual([busy])
    }),
  ).pipe(Effect.provide(Layer.fresh(Live.layer))),
  hangGuard("local-fixture"),
)

describe("Ergo's `work --json list -status`, read when the installed `work` gives it", () => {
  // Made-up records in the planned shape, as `work` prints them: status on Active records only; Go writes absent fields as null.
  const listed = `[
    {"name":"on-main","path":"/code/.work/app/on-main","state":{"_tag":"Active"},"status":{"default":"main","defaultCommit":"e0e0e0e","ahead":0,"behind":3,"by":"patch","head":"a1b2c3d","branch":"feat/on-main","lastCommit":1763700000,"dirty":false,"error":null}},
    {"name":"ahead","path":"/code/.work/app/ahead","state":{"_tag":"Active"},"status":{"ahead":2,"behind":0,"by":"ancestry","head":"f00d123","lastCommit":"2026-11-21T10:00:00Z","dirty":3,"error":""}},
    {"name":"broken","path":"/code/.work/app/broken","state":{"_tag":"Active"},"status":{"ahead":0,"by":null,"head":null,"lastCommit":null,"dirty":null,"error":"git: bad object"}},
    {"name":"plain","path":"/code/.work/app/plain","state":{"_tag":"Active"}},
    {"name":"gone","path":"/code/.work/app/gone","state":{"_tag":"Trashed"},"status":{"ahead":0}}
  ]`

  test("each Active record's status by path, its times in epoch ms; a record with none, or not Active, is left out", () => {
    const seen = Live.statusesOf(listed)
    expect([...seen.keys()]).toEqual(["/code/.work/app/on-main", "/code/.work/app/ahead", "/code/.work/app/broken"])
    expect(seen.get("/code/.work/app/on-main")).toEqual({ ahead: 0, by: Option.some("patch"), head: Option.some("a1b2c3d"), lastCommit: Option.some(1_763_700_000_000), dirty: Option.some(false), error: Option.none() })
    expect(seen.get("/code/.work/app/ahead")).toEqual({ ahead: 2, by: Option.some("ancestry"), head: Option.some("f00d123"), lastCommit: Option.some(Date.parse("2026-11-21T10:00:00Z")), dirty: Option.some(true), error: Option.none() })
    expect(Option.fromUndefinedOr(seen.get("/code/.work/app/broken")).pipe(Option.flatMap((each) => each.error))).toEqual(Option.some("git: bad object"))
  })

  test("the plain list (today's `work`), or an answer that does not read, is no status at all", () => {
    expect(Live.statusesOf(`[{"name":"plain","path":"/p","state":{"_tag":"Active"}}]`).size).toBe(0)
    expect(Live.statusesOf("usage: work list").size).toBe(0)
  })
})
