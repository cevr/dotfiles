// A model of a workspace copied with its base's uncommitted work, against real Git in a scratch directory. Each
// seeded case generates the base's dirty set (tracked files modified, staged or deleted, an untracked file),
// copies the base into a workspace as work does (`<dir>/.work/app/<name>` beside `<dir>/app`), made fresh (its
// create's first step, `settle`) or made before that step existed; then the workspace's own edits, a round
// receipt, and what happens before the land: the base rewrites or drops files, the owner restores the inherited
// copies by hand, the workspace edits again. A reference model says, from contents alone, what the create
// restores, which changes are the workspace's own (what a land refuses, what a removal and the lost-lane list
// count) and whether the receipt still stands; the real `settle`, `Landing.ownChanges` and `Landing.standing`
// must say the same.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import { Landing } from "../service.ts"
import { COPIED_FROM, inheritance } from "./inherited.ts"
import * as ProcessLanding from "./landing.ts"

const ENV = {
  GIT_AUTHOR_NAME: "Rift Test",
  GIT_AUTHOR_EMAIL: "rift@example.invalid",
  GIT_COMMITTER_NAME: "Rift Test",
  GIT_COMMITTER_EMAIL: "rift@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

/** Runs `argv` in `cwd`, which must exit 0; answers its output. */
const sh = (cwd: string, ...argv: ReadonlyArray<string>): string => {
  const ran = Bun.spawnSync([...argv], { cwd, env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" })
  expect({ argv, code: ran.exitCode, stderr: ran.stderr.toString() }).toMatchObject({ code: 0 })
  return ran.stdout.toString()
}

/** A file's content; MISSING when there is no file. */
const MISSING = "(missing)"

/** The tracked files, one in a folder and two whose names a pathspec would read as patterns. */
const TRACKED: ReadonlyArray<string> = ["a.txt", "dir/b.txt", "c d.txt", "e*.txt"]
const UNTRACKED = "notes/u.txt"
const NEW = "mine.txt"
const ALL: ReadonlyArray<string> = [...TRACKED, UNTRACKED, NEW]
const headOf = (file: string): string => `head ${file}\n`

/** A small seeded generator (mulberry32): one case's choices, the same on every run. */
const generator = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { pick: <A>(choices: ReadonlyArray<A>): A => choices[Math.floor(next() * choices.length)]!, chance: (p: number) => next() < p }
}

type BaseDirt = "clean" | "modified" | "staged" | "deleted"
type LaneEdit = "none" | "edit" | "revert"

/** One generated case. */
interface Case {
  readonly seed: number
  readonly fresh: boolean
  readonly base: ReadonlyMap<string, BaseDirt>
  readonly untracked: boolean
  readonly edits: ReadonlyMap<string, LaneEdit>
  readonly added: boolean
  /** After the receipt: files the base rewrites, whether it drops its untracked file, a hand restore, a late edit. */
  readonly drift: ReadonlyArray<string>
  readonly dropUntracked: boolean
  readonly handRestore: boolean
  readonly late: Option.Option<string>
}

const caseOf = (seed: number): Case => {
  const g = generator(seed)
  return {
    seed,
    fresh: g.chance(0.5),
    base: new Map(TRACKED.map((file) => [file, g.pick<BaseDirt>(["clean", "modified", "modified", "staged", "deleted"])])),
    untracked: g.chance(0.7),
    edits: new Map(TRACKED.map((file) => [file, g.pick<LaneEdit>(["none", "none", "edit", "revert"])])),
    added: g.chance(0.3),
    drift: TRACKED.filter(() => g.chance(0.2)),
    dropUntracked: g.chance(0.15),
    handRestore: g.chance(0.5),
    late: Option.liftPredicate(g.pick(TRACKED), () => g.chance(0.2)),
  }
}

// ── The reference model: contents only ──

/** Each known file's content in the base and in the lane. */
interface Model {
  readonly base: Map<string, string>
  readonly lane: Map<string, string>
}

const contentIn = (files: ReadonlyMap<string, string>, file: string): string => Option.getOrElse(Option.fromUndefinedOr(files.get(file)), () => MISSING)

/** Whether `file` is a status entry of the lane: a tracked file unlike HEAD, or an untracked file there. */
const changed = (model: Model, file: string): boolean => {
  if (TRACKED.includes(file)) return contentIn(model.lane, file) !== headOf(file)
  return contentIn(model.lane, file) !== MISSING
}

/** A status entry of the lane whose file does not read the same in the base now: the lane's own. */
const isOwn = (model: Model, file: string): boolean => changed(model, file) && contentIn(model.lane, file) !== contentIn(model.base, file)

const ownOf = (model: Model): ReadonlyArray<string> => ALL.filter((file) => isOwn(model, file)).sort()

/** The tree a receipt names: each tracked file as on disk when it is the lane's own, else at HEAD. */
const treeOf = (model: Model): string => JSON.stringify(TRACKED.map((file) => Option.getOrElse(Option.liftPredicate(contentIn(model.lane, file), () => isOwn(model, file)), () => headOf(file))))

// ── The real world ──

/** Writes `content` to `file` under `root` (its folder made), or removes it for MISSING; the model follows. */
const put = (root: string, files: Map<string, string>, file: string, content: string) => {
  files.set(file, content)
  const at = join(root, file)
  if (content === MISSING) {
    if (existsSync(at)) unlinkSync(at)
    return
  }
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, content)
}

const read = (root: string, file: string): string => Option.getOrElse(Option.liftPredicate(join(root, file), existsSync).pipe(Option.map((at) => readFileSync(at, "utf8"))), () => MISSING)

/** The paths of one case: the base, its lane and the land logs, under `root`. */
const pathsOf = (root: string) => ({ base: join(root, "app"), lane: join(root, ".work", "app", "lane"), logs: join(root, "logs") })
type Paths = ReturnType<typeof pathsOf>

/** The base, committed at HEAD, then dirtied as the case says; the model's base follows. */
const dirtyBase = (paths: Paths, each: Case, model: Model) => {
  gitInit(paths.base, ["-q", "-b", "main"])
  for (const file of ALL) put(paths.base, model.base, file, MISSING)
  for (const file of TRACKED) put(paths.base, model.base, file, headOf(file))
  sh(paths.base, "git", "add", "-A")
  sh(paths.base, "git", "commit", "-q", "-m", "init")
  for (const file of TRACKED) {
    const dirt = contentIn(new Map(each.base), file)
    if (dirt === "clean") continue
    put(paths.base, model.base, file, `base ${file}\n`)
    if (dirt === "deleted") put(paths.base, model.base, file, MISSING)
    if (dirt === "staged") sh(paths.base, "git", "add", "--", file)
  }
  if (each.untracked) put(paths.base, model.base, UNTRACKED, "base notes\n")
}

/** The fresh lane's create step: it restores exactly the tracked files unlike HEAD, keeps the untracked one, and leaves the base as it was. */
const settled = (paths: Paths, model: Model) =>
  Effect.gen(function* () {
    const restored = yield* inheritance(ENV).settle(paths.lane, paths.base)
    const expected = TRACKED.filter((file) => contentIn(model.lane, file) !== headOf(file))
    expect([...restored].sort()).toEqual([...expected].sort())
    for (const file of expected) model.lane.set(file, headOf(file))
    expect(sh(paths.lane, "git", "config", "--local", "--get", COPIED_FROM).trim()).toBe(paths.base)
    expect(sh(paths.lane, "git", "status", "--porcelain", "--untracked-files=no")).toBe("")
    expect(ALL.map((file) => read(paths.lane, file))).toEqual(ALL.map((file) => contentIn(model.lane, file)))
    expect(ALL.map((file) => read(paths.base, file))).toEqual(ALL.map((file) => contentIn(model.base, file)))
  })

/** The lane's own work: edits, reverts to HEAD and a new file. */
const laneWork = (paths: Paths, each: Case, model: Model) => {
  for (const file of TRACKED) {
    const edit = contentIn(new Map(each.edits), file)
    if (edit === "edit") put(paths.lane, model.lane, file, `lane ${file}\n`)
    if (edit === "revert") {
      sh(paths.lane, "git", "checkout", "-q", "HEAD", "--", file)
      model.lane.set(file, headOf(file))
    }
  }
  if (each.added) put(paths.lane, model.lane, NEW, "mine\n")
}

/** After the receipt: the base moves on, the owner restores the inherited copies by hand, the lane edits again. */
const beforeLand = (paths: Paths, each: Case, model: Model) => {
  for (const file of each.drift) put(paths.base, model.base, file, `base again ${file}\n`)
  if (each.dropUntracked) put(paths.base, model.base, UNTRACKED, MISSING)
  const inherited = TRACKED.filter((file) => each.handRestore && changed(model, file) && !isOwn(model, file))
  if (inherited.length > 0) sh(paths.lane, "git", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...inherited.map((file) => `:(literal)${file}`))
  for (const file of inherited) model.lane.set(file, headOf(file))
  for (const file of Option.toArray(each.late)) put(paths.lane, model.lane, file, `late ${file}\n`)
}

/** `body` in a fresh scratch folder (by its real path), removed when it ends. */
const inScratch = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("rift-inherited-")),
    (held) => body(realpathSync(held.path)),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  )

/** Runs one case on real Git and in the model, comparing them at each step. */
const check = (each: Case) =>
  inScratch((root) =>
    Effect.gen(function* () {
        const paths = pathsOf(root)
        const model: Model = { base: new Map(), lane: new Map() }
        dirtyBase(paths, each, model)
        // The copy: everything the base holds, its index and uncommitted work too.
        mkdirSync(dirname(paths.lane), { recursive: true })
        cpSync(paths.base, paths.lane, { recursive: true })
        for (const file of ALL) model.lane.set(file, contentIn(model.base, file))
        if (each.fresh) yield* settled(paths, model)
        laneWork(paths, each, model)
        const kit = ProcessLanding.receipts(paths.logs, ENV)
        yield* Effect.flatMap(kit.snapshot(paths.lane), (at) => Effect.flatMap(kit.made(paths.lane, at, "round", [{ command: "bun test", code: 0, seconds: 1 }]), kit.write))
        const atReceipt = treeOf(model)
        beforeLand(paths, each, model)
        expect(ALL.map((file) => read(paths.lane, file))).toEqual(ALL.map((file) => contentIn(model.lane, file)))
        const landing = yield* Landing
        const own = yield* landing.ownChanges(paths.lane, paths.base)
        const standing = yield* landing.standing(paths.lane)
        // What the land refuses (and a removal and the lost-lane list count) is the lane's own work, and only that.
        expect({ seed: each.seed, own: own.map((line) => line.slice(3)).sort() }).toEqual({ seed: each.seed, own: [...ownOf(model)] })
        // The receipt stands while the lane's own tree is as it was.
        const stands = treeOf(model) === atReceipt
        expect({ seed: each.seed, current: standing._tag === "Current", moved: standing._tag === "Moved" }).toEqual({ seed: each.seed, current: stands, moved: !stands })
      }).pipe(Effect.provide(ProcessLanding.layer({ logs: pathsOf(root).logs, env: ENV }))),
  )

/** A case with nothing generated: the base's dirty set below, nothing after the receipt. */
const QUIET: Case = {
  seed: 0,
  fresh: false,
  base: new Map<string, BaseDirt>([
    ["a.txt", "modified"],
    ["dir/b.txt", "deleted"],
    ["c d.txt", "staged"],
    ["e*.txt", "clean"],
  ]),
  untracked: true,
  edits: new Map(TRACKED.map((file) => [file, "none"])),
  added: false,
  drift: [],
  dropUntracked: false,
  handRestore: true,
  late: Option.none(),
}

describe("a workspace copied with its base's uncommitted work", () => {
  test("generated base dirty sets × workspace edits: the create restores the copies, and the land and the receipt agree on what is the workspace's own", () =>
    Effect.runPromise(Effect.forEach(Array.from({ length: 40 }, (_, index) => caseOf(index + 1)), check, { discard: true })), 120_000)

  test("a workspace made before its create restored anything lands, and its receipt stands, through a restore by hand; a change of its own still refuses", () =>
    Effect.runPromise(
      Effect.forEach(
        [
          { ...QUIET, edits: new Map<string, LaneEdit>([...QUIET.edits, ["e*.txt", "edit"]]) },
          { ...QUIET, late: Option.some("a.txt") },
        ],
        check,
        { discard: true },
      ),
    ))

  test("a base is never settled: its uncommitted work stays, it records no source, and every change in it is its own", () =>
    Effect.runPromise(
      inScratch((root) =>
        Effect.gen(function* () {
          const base = join(root, "app")
          gitInit(base, ["-q", "-b", "main"])
          const files = new Map<string, string>()
          put(base, files, "a.txt", "head\n")
          sh(base, "git", "add", "-A")
          sh(base, "git", "commit", "-q", "-m", "init")
          put(base, files, "a.txt", "dirty\n")
          const tools = inheritance(ENV)
          expect(yield* tools.settle(base, base)).toEqual([])
          expect(yield* tools.settle(`${base}/.`, base)).toEqual([])
          expect(read(base, "a.txt")).toBe("dirty\n")
          expect(Bun.spawnSync(["git", "-C", base, "config", "--local", "--get", COPIED_FROM]).exitCode).toBe(1)
          expect(yield* tools.ownLines(base, base)).toEqual([" M a.txt"])
        }),
      ),
    ))
})
