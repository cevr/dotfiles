// A land by receipts over real Git in a scratch directory: a bare origin, a warm source, its kept Rifts and
// two Rift clones on their branches, the process Landing and the rift tool's handler (Rifts, sessions and
// notices in memory). Each Rift's receipt is written as its round gate writes one (`receipts`); the source's
// `rift.mergeCheck`, `rift.focus` and `rift.gate` each leave a mark naming the checkout they ran in, so the
// test reads which ran where. The other locks are held by this process meanwhile, as a full gate by hand,
// an accept check or a post-land step would hold them.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Match, Option, Predicate, Schema, type Scope } from "effect"
import { gitClone, gitInit } from "../../../tests/git-repo.ts"
import * as MemoryDebts from "../memory/debts.ts"
import * as MemoryNotices from "../memory/notices.ts"
import * as MemoryRifts from "../memory/rifts.ts"
import * as MemorySessionDirectories from "../memory/session-directories.ts"
import * as MemoryWorkbox from "../memory/workbox.ts"
import * as Model from "../model.ts"
import { LandRecordJson, standing as standingOf } from "../receipt.ts"
import { hold, type LockMode } from "./flock.ts"
import * as ProcessLanding from "./landing.ts"

const ENV = {
  GIT_AUTHOR_NAME: "Rift Test",
  GIT_AUTHOR_EMAIL: "rift@example.invalid",
  GIT_COMMITTER_NAME: "Rift Test",
  GIT_COMMITTER_EMAIL: "rift@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

const sh = (cwd: string, ...argv: ReadonlyArray<string>): string => {
  const ran = Bun.spawnSync([...argv], { cwd, env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" })
  expect({ argv, code: ran.exitCode, stderr: ran.stderr.toString() }).toMatchObject({ code: 0 })
  return ran.stdout.toString().trim()
}

const commit = (root: string, file: string, text: string) => {
  writeFileSync(join(root, file), text)
  sh(root, "git", "add", file)
  sh(root, "git", "commit", "-q", "-m", `change ${file}`)
}

/** A check that appends `<name> <checkout>` to `marks`, then exits `code`. */
const marking = (marks: string, name: string, code: number) => `echo "${name} $(pwd)" >> "${marks}"; exit ${code}`

/** The scratch world: origin, the source and its Rifts laid out as Rift lays them, the land logs, and the marks. */
const bench = (exits: { readonly merge?: number; readonly focus?: number } = {}) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rift-receipts-")))
  const origin = join(scratch, "origin.git")
  const source = join(scratch, "app")
  const logs = join(scratch, "logs")
  const marks = join(scratch, "marks")
  gitInit(origin, ["-q", "--bare", "-b", "main"])
  gitClone(origin, source, ["-q"])
  writeFileSync(join(source, "README.md"), "app\n")
  sh(source, "git", "add", "README.md")
  sh(source, "git", "commit", "-q", "-m", "init")
  sh(source, "git", "push", "-q", "-u", "origin", "main")
  sh(source, "git", "remote", "set-head", "origin", "main")
  sh(source, "git", "config", "rift.gate", marking(marks, "full-gate", 0))
  sh(source, "git", "config", "rift.mergeCheck", marking(marks, "merge-check", exits.merge ?? 0))
  sh(source, "git", "config", "rift.focus", `echo focus "$(pwd)" {threads} {paths} >> "${marks}"; exit ${exits.focus ?? 0}`)
  const rifts = join(scratch, ".rifts", "app")
  mkdirSync(rifts, { recursive: true })
  const clone = (name: string, branch: string) => {
    const path = join(rifts, name)
    gitClone(origin, path, ["-q"])
    sh(path, "git", "checkout", "-q", "-B", branch)
    return path
  }
  const integrate = clone("integrate", "integrate")
  const accept = clone("land-accept", "land-accept")
  const x = clone("feat-x", "feat/x")
  const y = clone("feat-y", "feat/y")
  commit(x, "x.txt", "x\n")
  commit(y, "y.txt", "y\n")
  const world = MemoryRifts.world(
    [source],
    [
      [integrate, "integrate"],
      [accept, "land-accept"],
      [x, "feat/x"],
      [y, "feat/y"],
    ].map(([path, branch]) => MemoryRifts.clean(path!, branch)),
  )
  const layer = Model.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        MemoryRifts.layer(world),
        MemorySessionDirectories.layer({ ses_1: source }),
        ProcessLanding.layer({ logs, env: ENV }),
        MemoryNotices.layer([]),
        MemoryWorkbox.layer(false, []),
        MemoryDebts.layer(MemoryDebts.world()),
      ),
    ),
  )
  const kit = ProcessLanding.receipts(logs, ENV)
  /** Writes the green round receipt the Rift at `path`'s round gate would write for it now. */
  const receipt = (path: string) =>
    Effect.flatMap(kit.snapshot(path), (at) => Effect.flatMap(kit.made(path, at, "round", [{ command: "bun run gate --focused", code: 0, seconds: 1 }]), kit.write))
  /** The marks so far, one `<name> <checkout> …` per check run. */
  const marked = (): ReadonlyArray<string> => Option.match(Option.liftPredicate(marks, existsSync), { onNone: () => [], onSome: (file) => readFileSync(file, "utf8").trim().split("\n") })
  /** One land's answer, or the words of its failure. */
  const land = (names: ReadonlyArray<string>) =>
    Effect.flatMap(Model.RiftTool, (tool) =>
      tool.run("ses_1", { action: "land", rifts: [...names] }).pipe(
        Effect.map((answer) => answer.text),
        Effect.catch((failure) => Effect.succeed(`${Match.value(Predicate.isTagged(failure, "RiftFailed")).pipe(Match.when(true, () => "failed"), Match.orElse(() => "refused"))}: ${Model.explain(failure)}`)),
      ),
    )
  const run = <A, E>(body: Effect.Effect<A, E, Model.RiftTool | Scope.Scope>) =>
    Effect.runPromise(Effect.scoped(Effect.provide(body, layer)).pipe(Effect.ensuring(Effect.sync(() => rmSync(scratch, { recursive: true, force: true })))))
  const head = (path: string) => sh(path, "git", "rev-parse", "HEAD")
  return { scratch, origin, logs, integrate, x, y, receipt, marked, land, run, head, locks: ProcessLanding.lockFiles(logs) }
}

/** Holds `file` in `mode` from a fiber of this process, until the test's scope ends; answers once it holds it. */
const held = (file: string, mode: LockMode) =>
  Effect.gen(function* () {
    const holding = yield* Deferred.make<boolean>()
    yield* Effect.forkScoped(Effect.scoped(hold(file, mode).pipe(Effect.andThen(Deferred.succeed(holding, true)), Effect.andThen(Effect.never))))
    yield* Deferred.await(holding)
  })

const mainSubjects = (origin: string) => sh(origin, "git", "log", "--format=%s", "main").split("\n")

describe("a land by receipts, on real Git", () => {
  test("two Rifts with receipts land with only the merge check run, in the integration Rift; their receipts and the check are recorded under the pushed head", () => {
    const made = bench()
    return made.run(
      Effect.gen(function* () {
        yield* made.receipt(made.x)
        yield* made.receipt(made.y)
        const [x, y] = [made.head(made.x), made.head(made.y)]
        const started = performance.now()
        const answer = yield* made.land(["feat-x", "feat-y"])
        const seconds = (performance.now() - started) / 1000
        expect(answer.split("\n")[0]).toMatch(/^Landed 2 Rift\(s\) as one push: \w+ Merge feat\/y to main \(merged feat\/x, feat\/y; by their receipts, no full gate\)\.$/)
        expect(made.marked()).toEqual([`merge-check ${made.integrate}`])
        expect(mainSubjects(made.origin).sort()).toEqual(["Merge feat/y", "change x.txt", "change y.txt", "init"])
        const pushed = sh(made.origin, "git", "rev-parse", "main")
        const record = Schema.decodeUnknownSync(LandRecordJson)(readFileSync(join(made.logs, "receipts", `${pushed}.land.json`), "utf8"))
        expect(record.units.map((unit) => [unit.branch, unit.by, unit.receipt.head])).toEqual([
          ["feat/x", "held", x],
          ["feat/y", "held", y],
        ])
        expect(Option.map(record.merge, (receipt) => [receipt.kind, receipt.head, receipt.checks.map((check) => check.code)])).toEqual(Option.some(["merge", pushed, [0]]))
        expect(readdirSync(join(made.logs, "receipts")).sort()).toEqual([`${pushed}.land.json`, `${pushed}.merge.json`, `${x}.round.json`, `${y}.round.json`].sort())
        // The whole land of two receipted Rifts, Git included, on this host: the Done line's bound.
        expect(seconds).toBeLessThan(60)
      }),
    )
  })

  test("a Rift whose head moved after its receipt runs its focused gate in its own Rift, on the files it changed, and only that; the other's receipt is taken", () => {
    const made = bench()
    return made.run(
      Effect.gen(function* () {
        yield* made.receipt(made.x)
        commit(made.x, "x2.txt", "x2\n")
        yield* made.receipt(made.y)
        const answer = yield* made.land(["feat-x", "feat-y"])
        expect(answer).toContain("  feat/x: its head moved since its receipt, so its focused gate ran in the land")
        expect(answer).toContain("  feat/y: its receipt:")
        // `{paths}`: every file the Rift changed since it left main, absolute and quoted; `{threads}`: a quarter of the cores.
        expect(made.marked()).toEqual([
          `focus ${made.x} ${Math.max(1, Math.floor(availableParallelism() / 4))} ${join(made.x, "x.txt")} ${join(made.x, "x2.txt")}`,
          `merge-check ${made.integrate}`,
        ])
      }),
    )
  })

  test("a Rift's receipt stands current for its head and tracked files as they were; a tracked file edited on disk, a new head, a red run or none says so", () => {
    const made = bench()
    const kit = ProcessLanding.receipts(made.logs, ENV)
    return made.run(
      Effect.gen(function* () {
        const standing = Effect.map(
          Effect.flatMap(kit.newest(made.x), (newest) => Effect.map(kit.snapshot(made.x), (now) => standingOf(newest, now))),
          (now) => now._tag,
        )
        expect(yield* standing).toBe("Missing")
        yield* made.receipt(made.x)
        expect(yield* standing).toBe("Current")
        // The scratch index the snapshot reads through is gone, and the Rift's own index untouched.
        expect(readdirSync(join(made.x, ".git")).some((file) => file.endsWith(".rift-receipt"))).toBe(false)
        expect(sh(made.x, "git", "status", "--porcelain")).toBe("")
        writeFileSync(join(made.x, "x.txt"), "x, edited\n")
        expect(yield* standing).toBe("Moved")
        expect(sh(made.x, "git", "status", "--porcelain")).toBe("M x.txt")
        writeFileSync(join(made.x, "x.txt"), "x\n")
        expect(yield* standing).toBe("Current")
        // An untracked file is no part of the tree a receipt names.
        writeFileSync(join(made.x, "scratch.log"), "noise\n")
        expect(yield* standing).toBe("Current")
        commit(made.x, "x3.txt", "x3\n")
        expect(yield* standing).toBe("Moved")
        const at = yield* kit.snapshot(made.x)
        yield* kit.write(yield* kit.made(made.x, at, "round", [{ command: "bun test", code: 1, seconds: 2 }]))
        expect(yield* standing).toBe("Red")
      }),
    )
  })

  test("a red focused gate stops the land before any merge: main does not move", () => {
    const focusRed = bench({ focus: 3 })
    return focusRed.run(
      Effect.gen(function* () {
        const answer = yield* focusRed.land(["feat-x"])
        expect(answer).toStartWith(`refused: The focused gate of ${focusRed.x} failed (it held no current receipt, so the land ran it); nothing was pushed.`)
        expect(answer).toContain("exit 3 in")
        expect(mainSubjects(focusRed.origin)).toEqual(["init"])
        expect(focusRed.marked().map((line) => line.split(" ")[0])).toEqual(["focus"])
      }),
    )
  })

  test("a red merge check stops the push: main does not move, and every Rift stays", () => {
    const mergeRed = bench({ merge: 4 })
    return mergeRed.run(
      Effect.gen(function* () {
        yield* mergeRed.receipt(mergeRed.x)
        yield* mergeRed.receipt(mergeRed.y)
        const answer = yield* mergeRed.land(["feat-x", "feat-y"])
        expect(answer).toStartWith(`refused: The merge check failed on the merged batch in ${mergeRed.integrate}; nothing was pushed.`)
        expect(answer).toContain("exit 4 in")
        expect(mainSubjects(mergeRed.origin)).toEqual(["init"])
        expect(existsSync(mergeRed.x) && existsSync(mergeRed.y)).toBe(true)
        expect(readdirSync(join(mergeRed.logs, "receipts")).some((file) => file.endsWith(".land.json"))).toBe(false)
      }),
    )
  })

  test("scripts/receipt.ts receipts any round's proof in the checkout it runs in: commands it runs, or a proof attested; a land takes it", () => {
    const made = bench()
    const script = Bun.fileURLToPath(new URL("../../../scripts/receipt.ts", import.meta.url))
    const receipt = (...args: ReadonlyArray<string>) =>
      Bun.spawnSync([process.execPath, script, ...args], { cwd: made.x, env: { ...process.env, ...ENV, XDG_CACHE_HOME: join(made.scratch, "cache") }, stdout: "pipe", stderr: "pipe" })
    const kit = ProcessLanding.receipts(join(made.scratch, "cache", "rift-land"), ENV)
    return made.run(
      Effect.gen(function* () {
        expect(receipt().exitCode).toBe(2)
        const red = receipt("--", "true", "exit 3")
        expect(red.exitCode).toBe(1)
        expect(red.stderr.toString()).toContain("receipt: RED (1 of 2 failed)")
        const newest = yield* kit.newest(made.x)
        expect(Option.map(newest, (kept) => kept.checks.map((check) => [check.command, check.code]))).toEqual(Option.some([["true", 0], ["exit 3", 3]]))
        expect(receipt("--attest", "verifier batch-7 r1: accepted /run/batch-7-findings.md").exitCode).toBe(0)
        expect(Option.map(yield* kit.newest(made.x), (kept) => [kept.head, kept.checks[0]?.command])).toEqual(
          Option.some([made.head(made.x), "attested: verifier batch-7 r1: accepted /run/batch-7-findings.md"]),
        )
        // The land reads the receipt from the Rift itself: it lands on it, running nothing of the Rift's.
        yield* made.receipt(made.y)
        const answer = yield* made.land(["feat-x", "feat-y"])
        expect(answer).toContain("  feat/x: its receipt: 1 check(s) green at")
        expect(made.marked()).toEqual([`merge-check ${made.integrate}`])
      }),
    )
  })

  test("a land while a full gate holds the checks lock, an accept check or a post-land step's fork tests the accept lock, and a waiting gate the wanted lock, does not wait for any of them", () => {
    const made = bench()
    return made.run(
      Effect.gen(function* () {
        yield* made.receipt(made.x)
        yield* made.receipt(made.y)
        yield* held(made.locks.checks, "exclusive")
        yield* held(made.locks.accept, "exclusive")
        yield* held(made.locks.wanted, "exclusive")
        const answer = yield* made.land(["feat-x", "feat-y"]).pipe(Effect.timeoutOption("30 seconds"))
        expect(Option.map(answer, (text) => text.split("\n")[0]?.startsWith("Landed 2 Rift(s) as one push"))).toEqual(Option.some(true))
      }),
    )
  })

  test("a land's own checks wait only for a fork move: one holding the fork lock holds the merge check until it lets go", () => {
    const made = bench()
    return made.run(
      Effect.gen(function* () {
        yield* made.receipt(made.x)
        yield* made.receipt(made.y)
        const release = yield* Deferred.make<boolean>()
        const holding = yield* Deferred.make<boolean>()
        yield* Effect.forkScoped(Effect.scoped(hold(made.locks.fork, "exclusive").pipe(Effect.andThen(Deferred.succeed(holding, true)), Effect.andThen(Deferred.await(release)))))
        yield* Deferred.await(holding)
        const landing = yield* Effect.forkChild(made.land(["feat-x", "feat-y"]))
        const early = yield* Fiber.join(landing).pipe(Effect.timeoutOption("1500 millis"))
        expect(Option.isNone(early)).toBe(true)
        expect(made.marked()).toEqual([])
        yield* Deferred.succeed(release, true)
        expect((yield* Fiber.join(landing)).split("\n")[0]).toStartWith("Landed 2 Rift(s) as one push")
        expect(made.marked()).toEqual([`merge-check ${made.integrate}`])
      }),
    )
  })
})
