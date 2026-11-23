// @reads all
// @reads-reason nonliteral subprocess arguments at mods/orchestrate/git/claims.test.ts: spawnSync(["git", "-C", repo, ...args], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "i
// What claims a unit's commitment, over real git in scratch repositories this test makes with git plumbing: a base,
// and each lane its own clone (`--shared`: it sees the base's objects, the base none of its own until a land fetches
// them), as a workspace is. Only a land event claims (commitments-tool.ts `landClaimsOf`, `claimsRecorded`: what
// `orchestrate land` and the work tool's land hook in cmd/orchestrate/server.ts run), or the root's `landed`; a
// status's pass (`passed`) only weighs the claims standing against git. A claimed head lands once git has it on the
// default branch. Where a lane's head happens to be when someone reads claims nothing: ancestry is not authorship.
import { env as processEnv, spawnSync } from "bun"
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { gitClone, gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import * as Seed from "../../../sim/seed.ts"
import { answerOf, claimsRecorded, factsOf, landClaimsOf, passed } from "../commitments-tool.ts"
import * as MemoryRecord from "../memory/record.ts"
import { printable } from "../printable.ts"
import { type Actor, Command, PartInput, type Snapshot } from "../record.ts"
import { CommitmentRecord, type Evidence, MainLine } from "../service.ts"
import { noEvidence } from "../reasons.ts"
import { standingOf } from "../standing.ts"
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
/** The two tools a land goes through, each its own actor and hand-back role (server.ts `ORCHESTRATE_LAND`, `WORK_LAND`). */
const TOOLS = ["orchestrate-land", "work-land"] as const
type Tool = (typeof TOOLS)[number]

const git = (repo: string, args: ReadonlyArray<string>) =>
  spawnSync(["git", "-C", repo, ...args], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()

/** A commit in `repo` on `parents`, its message its own (two commits never share a hash). */
const commitIn = (repo: string, parents: ReadonlyArray<string>, message: string) => git(repo, ["commit-tree", git(repo, ["mktree"]), ...parents.flatMap((parent) => ["-p", parent]), "-m", message])

/**
 * A scratch base on `main` with one root commit, and its lanes: each a clone at its source's head (the base's, or a
 * parent lane's), moved by `move`, or to another lane's commit by `follow`. A lane's work reaches the base by `merge`
 * (a merge commit) or `fastForward`.
 */
const repository = (dir: string) => {
  const path = `${dir}/base`
  gitInit(path, ["-q", "-b", "main"], ENV)
  const main = (sha: string) => void git(path, ["update-ref", "refs/heads/main", sha])
  const root = commitIn(path, [], "root")
  main(root)
  const followed = { n: 0 }
  const lane = (unit: string, source: string = path) => {
    const at = `${dir}/lanes/${unit}`
    gitClone(source, at, ["-q", "--shared", "--no-checkout"], ENV)
    const head = () => git(at, ["rev-parse", "HEAD"])
    const move = (sha: string) => void git(at, ["update-ref", "HEAD", sha])
    const work = (message: string) => {
      move(commitIn(at, [head()], message))
      return head()
    }
    /** The lane moved to `other`'s head (a fast-forward onto it, a reset to it): no commit of its own. */
    const follow = (other: { readonly path: string; readonly head: () => string }) => {
      git(at, ["fetch", "-q", other.path, `HEAD:refs/followed/${++followed.n}`])
      move(other.head())
      return head()
    }
    return { unit, path: at, head, move, work, follow }
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
type Repository = ReturnType<typeof repository>
type Lane = ReturnType<Repository["lane"]>

/** The record's commands and reads as the plugin runs them, on a memory record and git's main line of the scratch base. */
const recordOf = (repo: Repository) => {
  const facts = (gone: ReadonlyArray<string>) => (snapshot: Snapshot) =>
    Effect.gen(function* () {
      return yield* factsOf(yield* MainLine, repo.path, () => Effect.succeed(new Set(gone)), snapshot, T0)
    }).pipe(Effect.provide(GitMainLine.layer))
  return {
    /** `orchestrate lane`: the unit's commitment, its lane's workspace and the commit it started at recorded. */
    laned: (lane: Lane) =>
      Effect.gen(function* () {
        return yield* (yield* CommitmentRecord).run(Command.cases.lane.make({ run: "default", unit: lane.unit, startHead: Option.some(lane.head()), path: Option.some(lane.path) }), { actor: ROOT, now: T0 })
      }),
    /** A land event by `tool`: the workspaces it pushed, each at the head it merged; `gone` the owners whose lane is gone after it. */
    landed: (tool: Tool, lanes: ReadonlyArray<{ readonly path: string; readonly head: string }>, gone: ReadonlyArray<string> = []) =>
      Effect.gen(function* () {
        const claims = landClaimsOf(yield* (yield* CommitmentRecord).read, lanes)
        return yield* claimsRecorded(claims, tool, "ses_root", { id: tool, role: "plugin" }, T0 + 1000, facts(gone))
      }),
    /** A status: the claims standing weighed against git, claiming nothing. */
    status: (gone: ReadonlyArray<string> = []) => passed({ id: "orchestrate-pass", role: "plugin" }, T0 + 2000, facts(gone)),
    /** The root's `landed`, as the commitments tool answers it. */
    explicitly: (id: string, head: string, gone: ReadonlyArray<string> = []) =>
      answerOf({ action: "landed", id, head }, ROOT, T0 + 3000, { facts: facts(gone), register: () => Effect.fail(printable("no register")), checkout: repo.path }),
    history: (id: string) =>
      Effect.gen(function* () {
        return yield* (yield* CommitmentRecord).history("commitment", id)
      }),
    /** A part added by the root, unowned. */
    added: (id: string) =>
      Effect.gen(function* () {
        return yield* (yield* CommitmentRecord).run(Command.cases.add.make({ run: "default", sourceKind: "plan-part", sourceRef: "plan.md:1", parts: [PartInput.make({ id, title: "a part" })] }), { actor: ROOT, now: T0 })
      }),
  }
}

/** Where `unit`'s commitment stands: its state once closed, else its standing with `gone` the owners whose lane is gone. */
const where = (snapshot: Snapshot, unit: string, gone: ReadonlyArray<string> = []) =>
  Option.map(Option.fromUndefinedOr(snapshot.commitments.get(unit)), (row) => {
    if (row.state !== "open") return row.state
    return standingOf(snapshot, row, { now: T0, onMain: new Set(), gone: new Set(gone) })
  })

const headOf = (snapshot: Snapshot, unit: string) => Option.flatMap(Option.fromUndefinedOr(snapshot.commitments.get(unit)), (row) => row.head)

/** A lane as a land event names it: its workspace and its head now. */
const at = (lane: Lane) => ({ path: lane.path, head: lane.head() })

const inRepository = <A, E>(name: string, body: (repo: Repository, record: ReturnType<typeof recordOf>) => Effect.Effect<A, E, CommitmentRecord | Evidence>) =>
  Seed.effect(
    name,
    Effect.acquireUseRelease(
      Effect.sync(() => scratch("record-claims-")),
      (held) => {
        const repo = repository(held.path)
        return body(repo, recordOf(repo)).pipe(Effect.provide(Layer.merge(MemoryRecord.layer, noEvidence)))
      },
      (held) => Effect.sync(() => held[Symbol.dispose]()),
    ),
  )

// ── Reads claim nothing ──

inRepository("a lane with work of its own is claimed by no status, however often read", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    u1.work("u1's work")
    yield* record.status()
    const after = yield* record.status()
    expect([where(after, "u1"), headOf(after, "u1"), after.handBacks.size]).toEqual([Option.some("held"), Option.none(), 0])
  }),
)

inRepository("work merged by hand with no land event stays open, and is orphaned once its lane is gone", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    u1.work("u1's work")
    repo.merge(u1)
    const after = yield* record.status(["u1"])
    expect([where(after, "u1", ["u1"]), headOf(after, "u1")]).toEqual([Option.some("orphaned"), Option.none()])
  }),
)

// ── Land events ──

for (const tool of TOOLS)
  inRepository(`a land by ${tool} of work merged by a merge commit lands it, attributed to that land`, (repo, record) =>
    Effect.gen(function* () {
      const u1 = repo.lane("u1")
      yield* record.laned(u1)
      const work = u1.work("u1's work")
      repo.merge(u1)
      const after = yield* record.landed(tool, [at(u1)], ["u1"])
      const history = yield* record.history("u1")
      expect([where(after, "u1"), after.commitments.get("u1")?.landedCommit]).toEqual([Option.some("landed"), Option.some(work)])
      expect(history.filter((event) => ["claimed", "landed"].includes(event.happening._tag)).map((event) => `${event.happening._tag} by ${event.actor.id}`)).toEqual([`claimed by ${tool}`, `landed by ${tool}`])
      expect([...after.handBacks.values()].map((each) => [each.role, each.head, each.routing])).toEqual([[tool, Option.some(work), "routed"]])
    }),
  )

inRepository("a land that fast-forwards main onto the lane lands it", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    u1.work("u1's work")
    repo.fastForward(u1)
    const after = yield* record.landed("work-land", [at(u1)], ["u1"])
    expect(where(after, "u1")).toEqual(Option.some("landed"))
  }),
)

inRepository("two units landed in one land call each land with their own head", (repo, record) =>
  Effect.gen(function* () {
    const [u1, u2] = [repo.lane("u1"), repo.lane("u2")]
    yield* record.laned(u1)
    yield* record.laned(u2)
    const [w1, w2] = [u1.work("u1's work"), u2.work("u2's work")]
    repo.merge(u1)
    repo.merge(u2)
    const after = yield* record.landed("orchestrate-land", [at(u1), at(u2)], ["u1", "u2"])
    expect([after.commitments.get("u1")?.landedCommit, after.commitments.get("u2")?.landedCommit]).toEqual([Option.some(w1), Option.some(w2)])
  }),
)

inRepository("a land event for a workspace no commitment recorded creates nothing and claims nothing", (repo, record) =>
  Effect.gen(function* () {
    const old = repo.lane("old")
    old.work("old work")
    repo.merge(old)
    const after = yield* record.landed("work-land", [at(old)])
    expect([after.commitments.size, after.handBacks.size]).toEqual([0, 0])
  }),
)

inRepository("the same land event twice (the hook firing again) claims once and lands once", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    u1.work("u1's work")
    const event = at(u1)
    yield* record.landed("work-land", [event])
    const twice = yield* record.landed("work-land", [event])
    repo.merge(u1)
    yield* record.landed("work-land", [event], ["u1"])
    const after = yield* record.status(["u1"])
    const history = yield* record.history("u1")
    expect([twice.handBacks.size, after.handBacks.size, where(after, "u1")]).toEqual([1, 1, Option.some("landed")])
    expect(history.filter((event) => event.happening._tag === "landed").length).toBe(1)
  }),
)

inRepository("a land event whose head never reaches main (a squash) stays open and owned, orphaned once its lane is gone", (repo, record) =>
  Effect.gen(function* () {
    const u4 = repo.lane("u4")
    yield* record.laned(u4)
    const work = u4.work("u4's work")
    repo.main(repo.commit([repo.root], "u4's work, squashed"))
    const landing = yield* record.landed("orchestrate-land", [at(u4)])
    expect([where(landing, "u4"), headOf(landing, "u4"), landing.commitments.get("u4")?.ownerLane]).toEqual([Option.some("held"), Option.some(work), Option.some("u4")])
    const later = yield* record.status(["u4"])
    expect(where(later, "u4", ["u4"])).toEqual(Option.some("orphaned"))
  }),
)

inRepository("a claim not yet on main lands at a later status once git has it there (the re-check claims nothing new)", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    const work = u1.work("u1's work")
    const landing = yield* record.landed("work-land", [at(u1)])
    expect(where(landing, "u1")).toEqual(Option.some("held"))
    u1.work("u1's later work, never landed")
    // The landed head reaches main later (a PR merged after the land, a push that lagged).
    git(repo.path, ["fetch", "-q", u1.path, "HEAD:refs/lanes/u1"])
    repo.main(commitIn(repo.path, [repo.tip(), work], "Merge u1's landed head"))
    const after = yield* record.status(["u1"])
    expect([where(after, "u1"), after.commitments.get("u1")?.landedCommit, after.handBacks.size]).toEqual([Option.some("landed"), Option.some(work), 1])
  }),
)

// ── Stacks and moved lanes: only a land of the lane itself claims ──

for (const tool of TOOLS)
  inRepository(`a stacked child fast-forwarded to its parent's later commit stays open when the parent lands by ${tool}, then lands by the root's landed`, (repo, record) =>
    Effect.gen(function* () {
      const u1 = repo.lane("u1")
      yield* record.laned(u1)
      u1.work("u1's work")
      const u2 = repo.lane("u2", u1.path)
      yield* record.laned(u2)
      // The parent's fix round; the child refreshes onto it with no commit of its own.
      const fix = u1.work("u1's fix after verify")
      u2.follow(u1)
      repo.merge(u1)
      const parentIn = yield* record.landed(tool, [at(u1)], ["u1"])
      expect([where(parentIn, "u1"), where(parentIn, "u2"), headOf(parentIn, "u2")]).toEqual([Option.some("landed"), Option.some("held"), Option.none()])
      const said = yield* record.explicitly("u2", fix, ["u1"])
      const after = yield* record.status(["u1"])
      const history = yield* record.history("u2")
      expect<string>(said).toBe(`commitments: u2 landed: ${fix} is on the default branch.`)
      expect([where(after, "u2"), after.commitments.get("u2")?.landedCommit]).toEqual([Option.some("landed"), Option.some(fix)])
      expect(history.filter((event) => ["claimed", "landed"].includes(event.happening._tag)).map((event) => `${event.happening._tag} by ${event.actor.id}`)).toEqual(["claimed by ses_root", "landed by ses_root"])
    }),
  )

inRepository("a stacked child with a commit of its own stays open when its parent lands, and lands by its own land", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    u1.work("u1's work")
    const u2 = repo.lane("u2", u1.path)
    yield* record.laned(u2)
    const own = u2.work("u2's own work")
    repo.merge(u1)
    const parentIn = yield* record.landed("orchestrate-land", [at(u1)], ["u1"])
    expect(where(parentIn, "u2")).toEqual(Option.some("held"))
    repo.merge(u2)
    const after = yield* record.landed("work-land", [at(u2)], ["u1", "u2"])
    expect([where(after, "u2"), after.commitments.get("u2")?.landedCommit]).toEqual([Option.some("landed"), Option.some(own)])
  }),
)

inRepository("a stacked child with no commit of its own stays open when its parent merges", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    u1.work("u1's work")
    const u2 = repo.lane("u2", u1.path)
    yield* record.laned(u2)
    repo.merge(u1)
    yield* record.landed("work-land", [at(u1)], ["u1"])
    const after = yield* record.status(["u1"])
    expect([where(after, "u1", ["u1"]), where(after, "u2"), headOf(after, "u2")]).toEqual([Option.some("landed"), Option.some("held"), Option.none()])
  }),
)

inRepository("a lane cut from main fast-forwarded to another unit's head stays open when that unit lands", (repo, record) =>
  Effect.gen(function* () {
    const [u1, u3] = [repo.lane("u1"), repo.lane("u3")]
    yield* record.laned(u1)
    yield* record.laned(u3)
    u1.work("u1's work")
    u3.follow(u1)
    repo.fastForward(u1)
    yield* record.landed("work-land", [at(u1)], ["u1"])
    const after = yield* record.status(["u1"])
    expect([where(after, "u1", ["u1"]), where(after, "u3"), headOf(after, "u3")]).toEqual([Option.some("landed"), Option.some("held"), Option.none()])
  }),
)

inRepository("a lane reset to another branch's head (main holding a cherry-pick of it) stays open when that branch merges", (repo, record) =>
  Effect.gen(function* () {
    const u9 = repo.lane("u9")
    yield* record.laned(u9)
    u9.work("u9's commit")
    repo.main(repo.commit([repo.root], "u9's commit, cherry-picked"))
    const u4 = repo.lane("u4")
    yield* record.laned(u4)
    u4.follow(u9)
    repo.merge(u9)
    yield* record.landed("orchestrate-land", [at(u9)], ["u9"])
    const after = yield* record.status(["u9"])
    expect([where(after, "u9", ["u9"]), where(after, "u4")]).toEqual([Option.some("landed"), Option.some("held")])
  }),
)

inRepository("a lane that only merged main in (a --no-ff merge commit, no change) stays open until its own land", (repo, record) =>
  Effect.gen(function* () {
    const u5 = repo.lane("u5")
    yield* record.laned(u5)
    const m1 = repo.commit([repo.root], "another unit on main")
    repo.main(m1)
    git(u5.path, ["fetch", "-q", repo.path, "main"])
    u5.move(commitIn(u5.path, [repo.root, m1], "Merge main into u5"))
    const read = yield* record.status()
    expect([where(read, "u5"), headOf(read, "u5")]).toEqual([Option.some("held"), Option.none()])
  }),
)

inRepository("a lane cut from a base holding an unpushed commit lands only by its own land, once that land is pushed", (repo, record) =>
  Effect.gen(function* () {
    // origin/main at root and origin/HEAD at it: the default branch; the base's own main holds X, not pushed.
    git(repo.path, ["update-ref", "refs/remotes/origin/main", repo.root])
    git(repo.path, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
    const x = repo.commit([repo.root], "the base's own commit")
    repo.main(x)
    const [u3, u4] = [repo.lane("u3"), repo.lane("u4")]
    yield* record.laned(u3)
    yield* record.laned(u4)
    const own = u4.work("u4's own work")
    git(repo.path, ["update-ref", "refs/remotes/origin/main", x])
    const pushedX = yield* record.status()
    expect([where(pushedX, "u3"), where(pushedX, "u4")]).toEqual([Option.some("held"), Option.some("held")])
    git(repo.path, ["fetch", "-q", u4.path, "HEAD:refs/lanes/u4"])
    git(repo.path, ["update-ref", "refs/remotes/origin/main", own])
    const after = yield* record.landed("work-land", [at(u4)], ["u4"])
    expect([where(after, "u3"), where(after, "u4"), after.commitments.get("u4")?.landedCommit]).toEqual([Option.some("held"), Option.some("landed"), Option.some(own)])
  }),
)

inRepository("a lane rebased onto a newer main lands by the rebased head its land names", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    u1.work("u1's work")
    const newer = repo.commit([repo.root], "another unit")
    repo.main(newer)
    git(u1.path, ["fetch", "-q", repo.path, "main"])
    const rebased = commitIn(u1.path, [newer], "u1's work, rebased")
    u1.move(rebased)
    repo.fastForward(u1)
    const after = yield* record.landed("orchestrate-land", [at(u1)], ["u1"])
    expect([where(after, "u1"), after.commitments.get("u1")?.landedCommit]).toEqual([Option.some("landed"), Option.some(rebased)])
  }),
)

inRepository("a lane reset back to its start claims nothing at a status", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    const started = u1.head()
    yield* record.laned(u1)
    u1.work("u1's work, dropped later")
    u1.move(started)
    const read = yield* record.status()
    expect([where(read, "u1"), headOf(read, "u1")]).toEqual([Option.some("held"), Option.none()])
  }),
)

inRepository("the root's landed of a head git does not have on main claims it and stays open, refusing a closed or unowned commitment", (repo, record) =>
  Effect.gen(function* () {
    const u1 = repo.lane("u1")
    yield* record.laned(u1)
    const work = u1.work("u1's work")
    const said = yield* record.explicitly("u1", work)
    expect<string>(said).toBe(`commitments: u1 claims ${work}; it lands once git has ${work} on the default branch (it does not now).`)
    const refused = yield* Effect.flip(record.explicitly("nope", work))
    expect<string>(refused).toBe("commitments: nope is not an open commitment")
    yield* record.added("loose")
    const unowned = yield* Effect.flip(record.explicitly("loose", work))
    expect<string>(unowned).toBe('commitments: loose is unowned; own it first: commitments({ action: "assign" })')
  }),
)
