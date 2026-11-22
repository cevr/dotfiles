// A read's claims (commitments-tool.ts `claimsOf`, as cmd/orchestrate/server.ts runs them at status, a land and the
// queue check) over real git in scratch repositories this test makes with git plumbing: a unit's commitment lands
// only when its lane held work main did not have and that work reached main, by a merge or a fast-forward, whether or
// not the lane is still there; a lane at a commit main already has claims nothing.
import { env as processEnv, spawnSync } from "bun"
import { expect } from "bun:test"
import { Array as Arr, Effect, Option, Result } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import * as Seed from "../../../sim/seed.ts"
import { claimsOf, factsOf, type LaneHead, onMainAmong } from "../commitments-tool.ts"
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
const PLUGIN: Actor = { id: "orchestrate status", role: "plugin" }

const git = (repo: string, args: ReadonlyArray<string>) =>
  spawnSync(["git", "-C", repo, ...args], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()

/** A scratch repository on `main` with one root commit: commits made by plumbing, main moved by `update-ref`. */
const repository = (path: string) => {
  gitInit(path, ["-q", "-b", "main"], ENV)
  const tree = git(path, ["mktree"])
  const commit = (parents: ReadonlyArray<string>, message: string) => git(path, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message])
  const main = (sha: string) => void git(path, ["update-ref", "refs/heads/main", sha])
  const root = commit([], "root")
  main(root)
  return { path, commit, main, root }
}

const step = (snapshot: Snapshot, command: Command, actor: Actor, now: number) => fold(snapshot, Result.getOrThrow(decideCommand(snapshot, command, { actor, now })))

/** The unit's commitment as `orchestrate lane` makes it. */
const laned = (unit: string) => step(EMPTY, Command.cases.lane.make({ run: "default", unit }), ROOT, T0)

/** One read: the lanes' claims, each a routed hand-back, then the pass; `gone` the owners whose lane is gone. */
const read = (checkout: string, snapshot: Snapshot, lanes: ReadonlyArray<LaneHead>, gone: ReadonlyArray<string>, now: number) =>
  Effect.gen(function* () {
    const mainLine = yield* MainLine
    const claims = claimsOf(snapshot, lanes, yield* onMainAmong(mainLine, checkout, lanes.map((lane) => lane.head)))
    const claimed = claims.reduce((held, claim) => {
      const handed = step(held, Command.cases.hand_back.make({ run: claim.run, ownerLane: claim.unit, role: "status", session: "ses_root", verdict: "done", head: Option.some(claim.head), claims: [claim.unit] }), PLUGIN, now)
      return Arr.reduce([...handed.handBacks.keys()], handed, (each, id) => Result.getOrElse(Result.map(decideCommand(each, Command.cases.route.make({ handBack: id, as: "routed" }), { actor: PLUGIN, now }), (events) => fold(each, events)), () => each))
    }, snapshot)
    const facts = yield* factsOf(mainLine, checkout, () => Effect.succeed(new Set(gone)), claimed, now)
    return step(claimed, Command.cases.pass.make({ onMain: [...facts.onMain], gone: [...facts.gone], root: Option.none() }), PLUGIN, now)
  }).pipe(Effect.provide(GitMainLine.layer))

const where = (snapshot: Snapshot, unit: string, gone: ReadonlyArray<string> = []) =>
  Option.map(Option.fromUndefinedOr(snapshot.commitments.get(unit)), (row) => {
    if (row.state !== "open") return row.state
    return standingOf(snapshot, row, { now: T0, onMain: new Set(), gone: new Set(gone) })
  })

const inRepository = <A, E>(name: string, body: (repo: ReturnType<typeof repository>) => Effect.Effect<A, E>) =>
  Seed.effect(
    name,
    Effect.acquireUseRelease(
      Effect.sync(() => scratch("record-claims-")),
      (held) => body(repository(`${held.path}/repo`)),
      (held) => Effect.sync(() => held[Symbol.dispose]()),
    ),
  )

inRepository("a fresh lane at main's tip claims nothing, and nothing lands", (repo) =>
  Effect.gen(function* () {
    const after = yield* read(repo.path, laned("u1"), [{ unit: "u1", head: repo.root }], [], T0 + 1000)
    expect([where(after, "u1"), after.commitments.get("u1")?.head]).toEqual([Option.some("held"), Option.none()])
  }),
)

inRepository("a lane only moved to a newer main claims nothing, and nothing lands", (repo) =>
  Effect.gen(function* () {
    const newer = repo.commit([repo.root], "another unit")
    repo.main(newer)
    const after = yield* read(repo.path, laned("u1"), [{ unit: "u1", head: newer }], [], T0 + 1000)
    expect(where(after, "u1")).toEqual(Option.some("held"))
  }),
)

inRepository("a lane with work main lacks is claimed and stays open until the work is on main", (repo) =>
  Effect.gen(function* () {
    const work = repo.commit([repo.root], "u1's work")
    const after = yield* read(repo.path, laned("u1"), [{ unit: "u1", head: work }], [], T0 + 1000)
    expect([where(after, "u1"), after.commitments.get("u1")?.head]).toEqual([Option.some("held"), Option.some(work)])
    const again = yield* read(repo.path, after, [{ unit: "u1", head: work }], [], T0 + 2000)
    expect(again.handBacks.size).toBe(1)
  }),
)

inRepository("claimed work merged by a merge commit lands", (repo) =>
  Effect.gen(function* () {
    const work = repo.commit([repo.root], "u1's work")
    const seen = yield* read(repo.path, laned("u1"), [{ unit: "u1", head: work }], [], T0 + 1000)
    repo.main(repo.commit([repo.root, work], "Merge branch 'feat/u1'"))
    const after = yield* read(repo.path, seen, [{ unit: "u1", head: work }], [], T0 + 2000)
    expect([where(after, "u1"), after.commitments.get("u1")?.landedCommit]).toEqual([Option.some("landed"), Option.some(work)])
  }),
)

inRepository("claimed work fast-forwarded onto main lands", (repo) =>
  Effect.gen(function* () {
    const work = repo.commit([repo.root], "u1's work")
    const seen = yield* read(repo.path, laned("u1"), [{ unit: "u1", head: work }], [], T0 + 1000)
    repo.main(work)
    const after = yield* read(repo.path, seen, [], [], T0 + 2000)
    expect(where(after, "u1")).toEqual(Option.some("landed"))
  }),
)

inRepository("work merged and its lane removed lands by the head a read saw; a lane never read is orphaned", (repo) =>
  Effect.gen(function* () {
    const work = repo.commit([repo.root], "u1's work")
    const seen = yield* read(repo.path, step(laned("u1"), Command.cases.lane.make({ run: "default", unit: "u2" }), ROOT, T0), [{ unit: "u1", head: work }], [], T0 + 1000)
    const unseen = repo.commit([repo.root], "u2's work, never read")
    repo.main(repo.commit([repo.commit([repo.root, work], "Merge branch 'feat/u1'"), unseen], "Merge branch 'feat/u2'"))
    // Both lanes are gone now: u1's claimed head is on main, u2 had none.
    const after = yield* read(repo.path, seen, [], ["u1", "u2"], T0 + 2000)
    expect([where(after, "u1", ["u1", "u2"]), where(after, "u2", ["u1", "u2"])]).toEqual([Option.some("landed"), Option.some("orphaned")])
  }),
)
