// The runs of a real git repository in a scratch directory, read through a
// stand-in for the orchestrate skill's status script: it prints the
// `table.md` each run holds, and fails with a message on stderr for a run
// holding `broken`. Then the real status script, model-based: a unit's state
// is its files and git (B1), and an `orchestrate.dir` run is read beside
// `tmp/orchestrate`.
import { env, file, spawnSync, write } from "bun"
import { expect, test } from "bun:test"
import { execPath } from "node:process"
import { Array as Arr, Context, Effect, Layer, Option, type Scope } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch as scratchDir } from "../../../tests/scratch.ts"
import { runTablesLaws } from "../laws.ts"
import { type RunTable, unitsOf } from "../run-table.ts"
import { RunTables } from "../service.ts"
import * as RunScript from "./run-tables.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

/** `parts` joined as one path. */
const join = (...parts: ReadonlyArray<string>) => parts.join("/")

/** A path with its links resolved, as git and the status script name it. */
const realOf = (path: string) => spawnSync(["realpath", path], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()

/** Files written at their paths, their directories made. */
const put = (files: ReadonlyArray<readonly [string, string]>) =>
  Effect.forEach(files, ([path, text]) => Effect.promise(() => write(path, text, { createPath: true })), { concurrency: 8, discard: true })

/** A scratch directory, links resolved, removed when the test's scope ends. */
const scratch = Effect.map(
  Effect.acquireRelease(
    Effect.sync(() => scratchDir("status-run-tables-")),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
  (dir) => realOf(dir.path),
)

const STATUS_SCRIPT = `
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.argv[2]
if (existsSync(join(dir, "broken"))) { console.error("cannot read " + dir); process.exit(1) }
process.stdout.write(readFileSync(join(dir, "table.md"), "utf8"))
`

/** A repository holding `tables`, read by the stand-in status script. */
const repositoryOf = (tables: ReadonlyArray<RunTable>) =>
  Effect.gen(function* () {
    const dir = yield* scratch
    const repository = join(dir, "repo")
    const outside = join(dir, "outside")
    gitInit(repository, ["-q"])
    const runs = join(repository, "tmp/orchestrate")
    const script = join(dir, "status.ts")
    yield* put([[join(outside, ".keep"), ""], [script, STATUS_SCRIPT], ...tables.map(({ name, table }) => [join(runs, name, "table.md"), table] as const)])
    return {
      layer: RunScript.layer(script),
      repository,
      outside,
      dir,
      spoil: (name: string) => put([[join(runs, name, "broken"), ""]]),
    }
  })

runTablesLaws("the status script's RunTables", repositoryOf)

/** A test's program, its scratch removed when it ends. */
const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

test("each run names its dir: tmp/orchestrate/<run> at the repository's main checkout", () =>
  scoped(
    Effect.gen(function* () {
        const probe = yield* repositoryOf([{ name: "p5", table: "| Unit | State |\n" }])
        const { runs } = yield* RunTables.use((runs) => runs.list(probe.repository)).pipe(Effect.provide(probe.layer))
        expect(runs.map((run) => run.dir)).toEqual([join(probe.repository, "tmp/orchestrate/p5")])
    }),
  ))

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" }

/** Git in `repo`: its output, trimmed. */
const git = (repo: string, args: ReadonlyArray<string>) =>
  spawnSync(["git", "-C", repo, ...args], { env: { ...env, ...IDENTITY }, stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()

test("each directory `git config --get-all orchestrate.dir` names is one run more, beside tmp/orchestrate; one that is gone is none", () =>
  scoped(
    Effect.gen(function* () {
        const probe = yield* repositoryOf([{ name: "p5", table: "| Unit | State |\n| a | plan |\n" }])
        const flat = join(probe.dir, "flat")
        yield* put([[join(flat, "table.md"), "| Unit | State |\n| b | implement |\n"]])
        for (const named of [flat, join(probe.dir, "gone")]) git(probe.repository, ["config", "--add", "orchestrate.dir", named])
        const tables = Context.get(yield* Layer.build(probe.layer), RunTables)
        const { runs } = yield* tables.list(probe.repository)
        expect(runs.map((run) => ({ name: run.name, dir: run.dir, units: unitsOf(run.table).map((unit) => unit.unit) }))).toEqual([
          { name: "p5", dir: join(probe.repository, "tmp/orchestrate/p5"), units: ["a"] },
          { name: "flat", dir: flat, units: ["b"] },
        ])
    }),
  ))

// ── The host's binary runs the status script as Bun ──

/**
 * A stand-in for OpenCode's compiled binary: Bun underneath, it runs a script
 * as Bun only with BUN_BE_BUN set; without it, it reads the script's path as an
 * OpenCode command, logs an ERROR line to `log` and fails, as the live one did.
 */
const hostBinary = (log: string) => `#!${execPath}
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
if (process.env.BUN_BE_BUN !== "1") {
  appendFileSync("${log}", "level=ERROR message=\\"cli process failed\\" cause=ShowHelp args=" + JSON.stringify(args) + "\\n")
  console.error("Unexpected positional argument: " + JSON.stringify(args[1]))
  process.exit(1)
}
const run = Bun.spawnSync(["${execPath}", ...args], { stdout: "inherit", stderr: "inherit" })
process.exit(run.exitCode ?? 1)
`

test("an old run dir (no units, no plan) is read by the real status script through the host's binary: an empty table each poll, no ERROR logged", () =>
  scoped(
    Effect.gen(function* () {
      const dir = yield* scratch
      const repository = join(dir, "repo")
      gitInit(repository, ["-q"])
      const old = join(repository, "tmp/orchestrate/ftbbrand")
      const host = join(dir, "opencode")
      const log = join(dir, "opencode.log")
      yield* put([[join(old, "e2.mjs"), "1\n"], [join(old, "proto/index.html"), "<p>\n"], [host, hostBinary(log)]])
      spawnSync(["chmod", "+x", host])
      const tables = Context.get(yield* Layer.build(RunScript.layer(REAL_STATUS, host)), RunTables)
      const polls = yield* Effect.forEach(Arr.range(1, 5), () => tables.list(repository))
      expect(polls.map(({ runs }) => runs.map((run) => ({ name: run.name, units: unitsOf(run.table) })))).toEqual(Arr.replicate([{ name: "ftbbrand", units: [] }], 5))
      expect(yield* Effect.promise(() => file(log).exists())).toBe(false)
    }),
  ))

// ── B1: a unit's state is its files and git, by the real status script ──

/** The orchestrate skill's status script, from opencode/; STATUS_SCRIPT points it at another copy (the base's, for red-at-base). */
const REAL_STATUS = Option.getOrElse(Option.fromUndefinedOr(env["STATUS_SCRIPT"]), () => realOf("../skills/orchestrate/scripts/status.ts"))

/** The status script's table for `run`, run in `cwd`, with every unit (`--all`). */
const statusOf = (run: string, repo: string, cwd: string) => spawnSync(["bun", REAL_STATUS, run, "--repo", repo, "--all"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }).stdout.toString()

/** The generator the opencode tests use: a seeded stream, so a failure names its seed. */
const rng = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A repository built with plumbing: `make` makes a commit on parents, `setRef` and `origin` move refs; `reach` is what the model knows a tip holds. */
const plumbing = (repo: string) => {
  gitInit(repo, ["-q", "-b", "main"])
  const tree = git(repo, ["mktree"])
  const count = { made: 0 }
  const ancestors = new Map<string, ReadonlySet<string>>()
  const make = (parents: ReadonlyArray<string>) => {
    count.made += 1
    const sha = git(repo, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", `c${count.made}`])
    ancestors.set(sha, new Set([sha, ...parents.flatMap((parent) => [...(ancestors.get(parent) ?? [])])]))
    return sha
  }
  const root = make([])
  git(repo, ["update-ref", "refs/heads/main", root])
  return {
    make,
    root,
    /** The commits an ancestor check against `tip` finds. */
    reach: (tip: string): ReadonlySet<string> => ancestors.get(tip) ?? new Set<string>(),
    setRef: (ref: string, sha: string) => git(repo, ["update-ref", ref, sha]),
    origin: (sha: string) => {
      git(repo, ["update-ref", "refs/remotes/origin/main", sha])
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
    },
  }
}

type Graph = ReturnType<typeof plumbing>

const STATES = ["plan", "implement", "ready", "verify", "merged", "blocked", "dropped"]
const VERDICTS = ["accepted", "changes", "stuck"]
/** The merged state a log writes, with its commit. */
const LOGGED_MERGE = `merged ${"a".repeat(7)}`

/** A logged state as the log writes it: a merge names its commit. */
const writtenState = (state: string) => state.replace(/^merged$/, LOGGED_MERGE)

/** One unit's generated history, as the model reads it. */
interface History {
  readonly unit: string
  /** Its log's transitions: state and round, in order. */
  readonly log: ReadonlyArray<{ readonly state: string; readonly round: number }>
  /** Its requests: round, the head as written and in full. */
  readonly requests: ReadonlyArray<{ readonly round: number; readonly head: string; readonly full: string }>
  readonly findings: ReadonlyArray<{ readonly round: number; readonly verdict: string }>
}

/** The newest of `entries` by round. */
const newestOf = <A extends { readonly round: number }>(entries: ReadonlyArray<A>): Option.Option<A> => Arr.head(entries.toSorted((a, b) => b.round - a.round))

/** Done 1's rule: the reference model of a unit's state and verdict, from its history and what the default branch holds. */
const expected = (history: History, reach: ReadonlySet<string>) => {
  const logged = Option.match(Arr.last(history.log), { onNone: () => "?", onSome: (last) => writtenState(last.state) })
  const verdict = Option.match(newestOf(history.findings), { onNone: () => "", onSome: (found) => `${found.verdict} r${found.round}` })
  if (logged === "dropped" || logged.startsWith("merged")) return { state: logged, verdict }
  const merged = Option.filter(newestOf(history.requests), (request) => reach.has(request.full))
  return { state: Option.match(merged, { onNone: () => logged, onSome: (request) => `merged ${request.head.slice(0, 7)}` }), verdict }
}

/** The request texts that name a head, in the forms requests write it. */
const requestText = (head: string, pick: () => number): string =>
  Option.getOrElse(
    Arr.get(
      [`Protocol: protocol.md. Spec: /x/spec.md.\nHead: ${head}\n`, `# round request\n\n- base 1234567, head commit ${head}.\n`, `Range 1234567..${head}, stat: 3 files changed\n`],
      Math.floor(pick() * 3),
    ),
    () => "",
  )

const RUNS_PER_REPO = 10
const REPOS = 10

/** A repository's default branch as B1 moves it: the local main, and origin's when the repository has one. */
interface Tips {
  main: string
  origin: string
}

/** One unit's history, generated: its log, its requests as real commits off main (some merged into it), and its findings. */
const historyOf = (unit: string, random: () => number, graph: Graph, tips: Tips): History => {
  const pick = (list: ReadonlyArray<string>) => Option.getOrElse(Arr.get(list, Math.floor(random() * list.length)), () => "")
  // The log: zero to five transitions, rounds never falling.
  const step = { round: 1 }
  const log = Array.from({ length: Math.floor(random() * 6) }, () => {
    step.round += Number(random() < 0.3)
    return { state: pick(STATES), round: step.round }
  })
  // Zero to three requests, each a real commit off the default branch; some merged, by fast-forward or --no-ff.
  const requests = [1, 2, 3]
    .flatMap((round) => Option.toArray(Option.liftPredicate(round, () => random() < 0.5)))
    .map((round) => {
      const full = graph.make([tips.main])
      const merge = random()
      if (merge < 0.25) tips.main = full
      else if (merge < 0.5) tips.main = graph.make([tips.main, full])
      const shown = Option.liftPredicate(full, () => random() < 0.3)
      return { round, head: Option.match(shown, { onNone: () => full, onSome: (sha) => sha.slice(0, 7 + Math.floor(random() * 6)) }), full }
    })
  const findings = [1, 2, 3].flatMap((round) => Option.toArray(Option.liftPredicate(round, () => random() < 0.4))).map((round) => ({ round, verdict: pick(VERDICTS) }))
  return { unit, log, requests, findings }
}

/** A history's unit dir, as its files hold it: the log, the requests and the findings, by path. */
const unitFiles = (run: string, history: History, random: () => number): ReadonlyArray<readonly [string, string]> => {
  const dir = join(run, history.unit)
  const from = { state: "new" }
  const lines = history.log.map((move, i) => {
    const line = `2026-11-14T10:${String(i).padStart(2, "0")}Z ${from.state} → ${writtenState(move.state)} r${move.round} note.md`
    from.state = move.state
    return line
  })
  return [
    [join(dir, "log.md"), Arr.match(lines, { onEmpty: () => "a log with no transition\n", onNonEmpty: (all) => `${all.join("\n")}\n` })],
    ...history.requests.map((request) => [join(dir, `round-${request.round}-request.md`), requestText(request.head, random)] as const),
    ...history.findings.map((found) => [join(dir, `round-${found.round}-findings.md`), `\nverifier batch-${found.round} r1: ${found.verdict} /x/batch-findings.md\n\n## Blockers\n- none (changes elsewhere)\n`] as const),
  ]
}

/** The unit, state and verdict of each row a status table prints. */
const rowsOf = (printed: string) => Object.fromEntries(unitsOf(printed).map((unit) => [unit.unit, { state: unit.state, verdict: Option.getOrElse(Option.fromUndefinedOr(unit.verdict), () => "") }]))

/** One repository's ten runs, each generated, written, printed by the script from two places and checked against the model. */
const repositoryRuns = (root: string, repoSeed: number) =>
  Effect.gen(function* () {
    const random = rng(repoSeed * 7919)
    const repo = join(root, `repo-${repoSeed}`)
    const graph = plumbing(repo)
    const tips: Tips = { main: graph.root, origin: graph.root }
    const useOrigin = random() < 0.5
    for (let runIndex = 0; runIndex < RUNS_PER_REPO; runIndex += 1) {
      const seed = `${repoSeed}/${runIndex}`
      const run = join(root, `run-${repoSeed}-${runIndex}`)
      const histories: Array<History> = []
      const units = 1 + Math.floor(random() * 4)
      for (let u = 0; u < units; u += 1) {
        const unit = `u${u}-${Option.getOrElse(Arr.get(["a", "b", "c"], Math.floor(random() * 3)), () => "a")}`
        if (!histories.some((each) => each.unit === unit)) histories.push(historyOf(unit, random, graph, tips))
      }
      graph.setRef("refs/heads/main", tips.main)
      // origin's default branch, when there is one, is what the default branch is: it may lag the local main.
      const tip = { sha: tips.main }
      if (useOrigin) {
        if (random() < 0.5) tips.origin = tips.main
        graph.origin(tips.origin)
        tip.sha = tips.origin
      }
      yield* put(histories.flatMap((history) => unitFiles(run, history, random)))
      const printed = statusOf(run, repo, root)
      expect([seed, statusOf(run, repo, repo)]).toEqual([seed, printed])
      const reach = graph.reach(tip.sha)
      expect([seed, rowsOf(printed)]).toEqual([seed, Object.fromEntries(histories.map((history) => [history.unit, expected(history, reach)]))])
    }
  })

test(
  "B1: a unit's state is its files and git",
  () =>
    scoped(
      Effect.gen(function* () {
        const root = yield* scratch
        for (let repoSeed = 1; repoSeed <= REPOS; repoSeed += 1) yield* repositoryRuns(root, repoSeed)
      }),
    ),
  hangGuard("fork-session"),
)

test("B1's red at base: a unit logged ready whose head is on the default branch is merged", () =>
  scoped(
    Effect.gen(function* () {
      const root = yield* scratch
      const repo = join(root, "repo")
      const graph = plumbing(repo)
      const head = graph.make([graph.root])
      graph.setRef("refs/heads/main", graph.make([graph.root, head]))
      const dir = join(root, "run", "landed")
      yield* put([
        [join(dir, "log.md"), "2026-11-14T10:00Z implement → ready r1 round-1-request.md\n"],
        [join(dir, "round-1-request.md"), `Head: ${head}\n`],
      ])
      const printed = statusOf(join(root, "run"), repo, root)
      expect(Option.map(Arr.head(unitsOf(printed)), (unit) => unit.state)).toEqual(Option.some(`merged ${head.slice(0, 7)}`))
    }),
  ))
