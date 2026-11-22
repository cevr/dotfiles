// A read's and a land's claims (commitments-tool.ts `laneFactsOf` and `claimsOf`, as cmd/orchestrate/server.ts runs
// them at status, a land and the queue check) over real git in scratch repositories this test makes with git
// plumbing: a base, and each lane its own clone (`--shared`: it sees the base's objects, the base none of its own until
// a land fetches them), as a workspace is. A unit's commitment lands only when its lane held work of its own past the
// commit the lane started at and that work reached main, by a merge or a fast-forward, whether or not the lane is
// still there. Never by a lane's start: not a stacked child's parent work, not a base's unpushed commit.
import { env as processEnv, spawnSync } from "bun"
import { expect } from "bun:test"
import { Array as Arr, Effect, Option, Result } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import * as Seed from "../../../sim/seed.ts"
import { claimsOf, factsOf, type LaneHead, laneFactsOf } from "../commitments-tool.ts"
import { type Actor, Command, EMPTY, fold, type Snapshot } from "../record.ts"
import { MainLine } from "../service.ts"
import { decideCommand, standingOf } from "../standing.ts"
import * as GitMainLine from "./main-line.ts"

const ENV = {
  PATH: processEnv["PATH"] ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
}
const T0 = Date.parse("2026-11-22T10:00:00.000Z")
const ROOT: Actor = { id: "ses_root", role: "root" }

const git = (repo: string, args: ReadonlyArray<string>) =>
  spawnSync(["git", "-C", repo, ...args], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()

/** A commit in `repo` on `parents`, its message its own (two commits never share a hash). */
const commitIn = (repo: string, parents: ReadonlyArray<string>, message: string) => git(repo, ["commit-tree", git(repo, ["mktree"]), ...parents.flatMap((parent) => ["-p", parent]), "-m", message])

/**
 * A scratch base on `main` with one root commit, and its lanes: each a clone at its source's head (the base's, or a
 * parent lane's), moved by `move`. A lane's work reaches the base by `merge` (a merge commit) or `fastForward`.
 */
const repository = (dir: string) => {
  const path = `${dir}/base`
  gitInit(path, ["-q", "-b", "main"], ENV)
  const main = (sha: string) => void git(path, ["update-ref", "refs/heads/main", sha])
  const root = commitIn(path, [], "root")
  main(root)
  const lane = (unit: string, source: string = path) => {
    const at = `${dir}/lanes/${unit}`
    spawnSync(["git", "clone", "-q", "--shared", "--no-checkout", source, at], { env: ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    const head = () => git(at, ["rev-parse", "HEAD"])
    const move = (sha: string) => void git(at, ["update-ref", "HEAD", sha])
    const work = (message: string) => {
      move(commitIn(at, [head()], message))
      return head()
    }
    return { unit, path: at, head, move, work, now: (): LaneHead => ({ unit, head: head(), path: at }) }
  }
  type Lane = ReturnType<typeof lane>
  const fetched = (from: Lane) => {
    git(path, ["fetch", "-q", from.path, `HEAD:refs/lanes/${from.unit}`])
    return from.head()
  }
  const tip = () => git(path, ["rev-parse", "main"])
  const merge = (from: Lane) => main(commitIn(path, [tip(), fetched(from)], `Merge branch 'feat/${from.unit}'`))
  const fastForward = (from: Lane) => main(fetched(from))
  return { path, main, root, tip, lane, merge, fastForward, commit: (parents: ReadonlyArray<string>, message: string) => commitIn(path, parents, message) }
}

const step = (snapshot: Snapshot, command: Command, actor: Actor, now: number) => fold(snapshot, Result.getOrThrow(decideCommand(snapshot, command, { actor, now })))

/** The unit's commitment as `orchestrate lane` makes it, the lane started at `start` (none: a lane made before start heads). */
const laned = (snapshot: Snapshot, unit: string, start: Option.Option<string>) => step(snapshot, Command.cases.lane.make({ run: "default", unit, startHead: start }), ROOT, T0)

/** One read (or a land, `by`): the lanes' claims, each a routed hand-back, then the pass; `gone` the owners whose lane is gone. */
const read = (checkout: string, snapshot: Snapshot, lanes: ReadonlyArray<LaneHead>, gone: ReadonlyArray<string>, now: number, by: "land" | "read" = "read") =>
  Effect.gen(function* () {
    const mainLine = yield* MainLine
    const actor: Actor = { id: `orchestrate ${by}`, role: "plugin" }
    const claims = claimsOf(snapshot, lanes, yield* laneFactsOf(mainLine, checkout, snapshot, lanes), by)
    const claimed = claims.reduce((held, claim) => {
      const handed = step(held, Command.cases.hand_back.make({ run: claim.run, ownerLane: claim.unit, role: by, session: "ses_root", verdict: "done", head: Option.some(claim.head), claims: [claim.unit] }), actor, now)
      return Arr.reduce([...handed.handBacks.keys()], handed, (each, id) => Result.getOrElse(Result.map(decideCommand(each, Command.cases.route.make({ handBack: id, as: "routed" }), { actor, now }), (events) => fold(each, events)), () => each))
    }, snapshot)
    const facts = yield* factsOf(mainLine, checkout, () => Effect.succeed(new Set(gone)), claimed, now)
    return step(claimed, Command.cases.pass.make({ onMain: [...facts.onMain], gone: [...facts.gone], root: Option.none() }), actor, now)
  }).pipe(Effect.provide(GitMainLine.layer))

const where = (snapshot: Snapshot, unit: string, gone: ReadonlyArray<string> = []) =>
  Option.map(Option.fromUndefinedOr(snapshot.commitments.get(unit)), (row) => {
    if (row.state !== "open") return row.state
    return standingOf(snapshot, row, { now: T0, onMain: new Set(), gone: new Set(gone) })
  })

const headOf = (snapshot: Snapshot, unit: string) => Option.flatMap(Option.fromUndefinedOr(snapshot.commitments.get(unit)), (row) => row.head)

const inRepository = <A, E>(name: string, body: (repo: ReturnType<typeof repository>) => Effect.Effect<A, E>) =>
  Seed.effect(
    name,
    Effect.acquireUseRelease(
      Effect.sync(() => scratch("record-claims-")),
      (held) => body(repository(held.path)),
      (held) => Effect.sync(() => held[Symbol.dispose]()),
    ),
  )

inRepository("a fresh lane at main's tip claims nothing, and nothing lands", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const after = yield* read(repo.path, laned(EMPTY, "u1", Option.some(u1.head())), [u1.now()], [], T0 + 1000)
    expect([where(after, "u1"), headOf(after, "u1")]).toEqual([Option.some("held"), Option.none()])
  }),
)

inRepository("a lane only moved to a newer main claims nothing, and nothing lands", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const start = laned(EMPTY, "u1", Option.some(u1.head()))
    const newer = repo.commit([repo.root], "another unit")
    repo.main(newer)
    git(u1.path, ["fetch", "-q", repo.path, "main"])
    u1.move(newer)
    const after = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    expect([where(after, "u1"), headOf(after, "u1")]).toEqual([Option.some("held"), Option.none()])
  }),
)

inRepository("a lane with work of its own is claimed and stays open until the work is on main; a second read claims nothing more", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const start = laned(EMPTY, "u1", Option.some(u1.head()))
    const work = u1.work("u1's work")
    const after = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    expect([where(after, "u1"), headOf(after, "u1")]).toEqual([Option.some("held"), Option.some(work)])
    const again = yield* read(repo.path, after, [u1.now()], [], T0 + 2000)
    expect(again.handBacks.size).toBe(1)
  }),
)

inRepository("claimed work merged by a merge commit lands", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const start = laned(EMPTY, "u1", Option.some(u1.head()))
    const work = u1.work("u1's work")
    const seen = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    repo.merge(u1)
    const after = yield* read(repo.path, seen, [u1.now()], [], T0 + 2000)
    expect([where(after, "u1"), after.commitments.get("u1")?.landedCommit]).toEqual([Option.some("landed"), Option.some(work)])
  }),
)

inRepository("claimed work fast-forwarded onto main lands", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const start = laned(EMPTY, "u1", Option.some(u1.head()))
    u1.work("u1's work")
    const seen = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    repo.fastForward(u1)
    const after = yield* read(repo.path, seen, [], [], T0 + 2000)
    expect(where(after, "u1")).toEqual(Option.some("landed"))
  }),
)

inRepository("work merged and its lane removed lands by the head a read saw; a lane never read is orphaned", (repo) =>
  Effect.gen(function* () {
    const [u1, u2] = [repo.lane("u1"), repo.lane("u2")]
    const start = laned(laned(EMPTY, "u1", Option.some(u1.head())), "u2", Option.some(u2.head()))
    u1.work("u1's work")
    const seen = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    u2.work("u2's work, never read")
    repo.merge(u1)
    repo.merge(u2)
    // Both lanes are gone now: u1's claimed head is on main, u2 had none.
    const after = yield* read(repo.path, seen, [], ["u1", "u2"], T0 + 2000)
    expect([where(after, "u1", ["u1", "u2"]), where(after, "u2", ["u1", "u2"])]).toEqual([Option.some("landed"), Option.some("orphaned")])
  }),
)

inRepository("a stacked child with no commit of its own stays open when its parent merges", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    u1.work("u1's work")
    const u2 = repo.lane("u2", u1.path)
    const start = laned(laned(EMPTY, "u1", Option.some(repo.root)), "u2", Option.some(u2.head()))
    const seen = yield* read(repo.path, start, [u1.now(), u2.now()], [], T0 + 1000)
    expect(headOf(seen, "u2")).toEqual(Option.none())
    repo.merge(u1)
    const after = yield* read(repo.path, seen, [u2.now()], ["u1"], T0 + 2000)
    expect([where(after, "u1", ["u1"]), where(after, "u2"), headOf(after, "u2")]).toEqual([Option.some("landed"), Option.some("held"), Option.none()])
  }),
)

inRepository("a stacked child with a commit of its own stays open when its parent merges, and lands when it merges", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    u1.work("u1's work")
    const u2 = repo.lane("u2", u1.path)
    const start = laned(laned(EMPTY, "u1", Option.some(repo.root)), "u2", Option.some(u2.head()))
    const own = u2.work("u2's own work")
    const seen = yield* read(repo.path, start, [u1.now(), u2.now()], [], T0 + 1000)
    expect(headOf(seen, "u2")).toEqual(Option.some(own))
    repo.merge(u1)
    const parentIn = yield* read(repo.path, seen, [u2.now()], ["u1"], T0 + 2000)
    expect(where(parentIn, "u2")).toEqual(Option.some("held"))
    repo.merge(u2)
    const after = yield* read(repo.path, parentIn, [], ["u1", "u2"], T0 + 3000)
    expect([where(after, "u2", ["u1", "u2"]), after.commitments.get("u2")?.landedCommit]).toEqual([Option.some("landed"), Option.some(own)])
  }),
)

inRepository("a lane cut from a base holding an unpushed commit claims nothing for it, and only its own work lands", (repo) =>
  Effect.gen(function* () {
    // origin/main at root and origin/HEAD at it: the default branch; the base's own main holds X, not pushed.
    git(repo.path, ["update-ref", "refs/remotes/origin/main", repo.root])
    git(repo.path, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
    const x = repo.commit([repo.root], "the base's own commit")
    repo.main(x)
    const [u3, u4] = [repo.lane("u3"), repo.lane("u4")]
    const start = laned(laned(EMPTY, "u3", Option.some(u3.head())), "u4", Option.some(u4.head()))
    const own = u4.work("u4's own work")
    const seen = yield* read(repo.path, start, [u3.now(), u4.now()], [], T0 + 1000)
    expect([headOf(seen, "u3"), headOf(seen, "u4")]).toEqual([Option.none(), Option.some(own)])
    git(repo.path, ["update-ref", "refs/remotes/origin/main", x])
    const pushed = yield* read(repo.path, seen, [u3.now(), u4.now()], [], T0 + 2000)
    expect([where(pushed, "u3"), where(pushed, "u4")]).toEqual([Option.some("held"), Option.some("held")])
    git(repo.path, ["fetch", "-q", u4.path, "HEAD:refs/lanes/u4"])
    git(repo.path, ["update-ref", "refs/remotes/origin/main", own])
    const after = yield* read(repo.path, pushed, [u3.now()], ["u4"], T0 + 3000)
    expect([where(after, "u3"), where(after, "u4", ["u4"])]).toEqual([Option.some("held"), Option.some("landed")])
  }),
)

inRepository("a lane cut from main and rebased onto a newer main claims its rebased work, which lands", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const start = laned(EMPTY, "u1", Option.some(u1.head()))
    u1.work("u1's work")
    const newer = repo.commit([repo.root], "another unit")
    repo.main(newer)
    git(u1.path, ["fetch", "-q", repo.path, "main"])
    const rebased = commitIn(u1.path, [newer], "u1's work, rebased")
    u1.move(rebased)
    const seen = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    expect(headOf(seen, "u1")).toEqual(Option.some(rebased))
    repo.fastForward(u1)
    const after = yield* read(repo.path, seen, [], ["u1"], T0 + 2000)
    expect(where(after, "u1", ["u1"])).toEqual(Option.some("landed"))
  }),
)

inRepository("a stacked child rebased away from its start is claimed by no read and no land: it is listed once its lane is gone", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    u1.work("u1's work")
    const u2 = repo.lane("u2", u1.path)
    const start = laned(laned(EMPTY, "u1", Option.some(repo.root)), "u2", Option.some(u2.head()))
    // The parent amends its work; the child restacks onto it with no commit of its own: git cannot tell whose it is.
    const amended = commitIn(u1.path, [repo.root], "u1's work, amended")
    u1.move(amended)
    git(u2.path, ["fetch", "-q", u1.path, "HEAD"])
    u2.move(amended)
    const seen = yield* read(repo.path, start, [u1.now(), u2.now()], [], T0 + 1000)
    expect([headOf(seen, "u1"), headOf(seen, "u2")]).toEqual([Option.some(amended), Option.none()])
    repo.merge(u1)
    const after = yield* read(repo.path, seen, [u2.now()], ["u1"], T0 + 2000)
    expect([where(after, "u1", ["u1"]), where(after, "u2")]).toEqual([Option.some("landed"), Option.some("held")])
    // With a commit of its own on the restacked parent, neither a read nor its land claims: git cannot say which of
    // its commits are its own, so it is listed (orphaned) once its lane is gone, for the root to decide, never landed.
    u2.work("u2's own work")
    const read2 = yield* read(repo.path, after, [u2.now()], ["u1"], T0 + 3000)
    const landing = yield* read(repo.path, read2, [u2.now()], ["u1"], T0 + 4000, "land")
    repo.merge(u2)
    const gone = yield* read(repo.path, landing, [], ["u1", "u2"], T0 + 5000)
    expect([headOf(landing, "u2"), where(gone, "u2", ["u1", "u2"])]).toEqual([Option.none(), Option.some("orphaned")])
  }),
)

inRepository("a lane reset back to its start claims nothing more, and its earlier claim does not land", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const started = u1.head()
    const start = laned(EMPTY, "u1", Option.some(started))
    const work = u1.work("u1's work, dropped later")
    const seen = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    u1.move(started)
    const reset = yield* read(repo.path, seen, [u1.now()], [], T0 + 2000)
    expect([reset.handBacks.size, headOf(reset, "u1"), where(reset, "u1")]).toEqual([1, Option.some(work), Option.some("held")])
    const other = repo.commit([repo.root], "another unit")
    repo.main(other)
    const later = yield* read(repo.path, reset, [u1.now()], [], T0 + 3000)
    expect(where(later, "u1")).toEqual(Option.some("held"))
  }),
)

inRepository("a lane made before start heads were kept is claimed by no read, only by an explicit land", (repo) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const start = laned(EMPTY, "u1", Option.none())
    const work = u1.work("u1's work")
    const seen = yield* read(repo.path, start, [u1.now()], [], T0 + 1000)
    expect(headOf(seen, "u1")).toEqual(Option.none())
    const landing = yield* read(repo.path, seen, [u1.now()], [], T0 + 2000, "land")
    expect(headOf(landing, "u1")).toEqual(Option.some(work))
    repo.merge(u1)
    const after = yield* read(repo.path, landing, [], ["u1"], T0 + 3000)
    expect(where(after, "u1", ["u1"])).toEqual(Option.some("landed"))
  }),
)
