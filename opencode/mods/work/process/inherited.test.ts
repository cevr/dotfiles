// A model of a workspace copied with its base's uncommitted work, against real Git in a scratch directory. Each
// seeded case generates the base's HEAD and dirty set (tracked files modified, staged, deleted or only made
// executable, an untracked file), copies the base into a workspace as work does (`<dir>/.work/app/<name>`
// beside `<dir>/app`), made fresh (its create's first step, `settle`) or made before that step existed; then
// the base's HEAD may move on, the workspace commits (an edit, a file of its own) and changes its working copy
// (an edit, a deletion, a mode change, a revert to HEAD, main's text put back over its own commit, a new
// file); a round receipt; and what happens before the land: the base rewrites or drops files, the owner
// restores the inherited copies by hand, the workspace edits again. A reference model says, from contents
// and modes alone, what the create restores, which changes are the workspace's own (what a land refuses, what
// a removal and the lost-lane list count) and whether the receipt still stands; the real `settle`,
// `Landing.ownChanges` and `Landing.standing` must say the same. The property beside the model: a change of the
// workspace is never left out of its own unless the base's status lists that path with the same content and mode.
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs"
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

/** A file as the model holds it: `-|<text>`, or `x|<text>` when executable; MISSING when there is no file. */
const MISSING = "(missing)"
const plain = (text: string): string => `-|${text}`

/** The tracked files, one in a folder and two whose names a pathspec would read as patterns. */
const TRACKED: ReadonlyArray<string> = ["a.txt", "dir/b.txt", "c d.txt", "e*.txt"]
const UNTRACKED = "notes/u.txt"
const ADDED = "added.txt"
const NEW = "mine.txt"
const ALL: ReadonlyArray<string> = [...TRACKED, UNTRACKED, ADDED, NEW]
const mainOf = (file: string): string => plain(`head ${file}\n`)

/** `value` with its executable bit flipped; MISSING stays missing. */
const flipped = (value: string): string => {
  if (value === MISSING) return MISSING
  if (value.startsWith("x|")) return `-|${value.slice(2)}`
  return `x|${value.slice(2)}`
}

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

type BaseDirt = "clean" | "modified" | "staged" | "deleted" | "chmod"
type LaneEdit = "none" | "edit" | "revert" | "chmod" | "delete" | "main" | "asBase" | "unstage"

/** One generated case. */
interface Case {
  readonly seed: number
  readonly fresh: boolean
  readonly base: ReadonlyMap<string, BaseDirt>
  readonly untracked: boolean
  /** After the copy: a file the base commits anew (its HEAD moves), a file the lane commits, whether it commits a file of its own. */
  readonly baseMoves: Option.Option<string>
  readonly laneCommits: Option.Option<string>
  readonly laneAdds: boolean
  readonly edits: ReadonlyMap<string, LaneEdit>
  readonly dropAdded: boolean
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
    base: new Map(TRACKED.map((file) => [file, g.pick<BaseDirt>(["clean", "modified", "modified", "staged", "deleted", "chmod"])])),
    untracked: g.chance(0.7),
    baseMoves: Option.liftPredicate(g.pick(TRACKED), () => g.chance(0.3)),
    laneCommits: Option.liftPredicate(g.pick(TRACKED), () => g.chance(0.6)),
    laneAdds: g.chance(0.3),
    edits: new Map(TRACKED.map((file) => [file, g.pick<LaneEdit>(["none", "none", "edit", "revert", "chmod", "delete", "main", "asBase", "asBase", "unstage"])])),
    dropAdded: g.chance(0.5),
    added: g.chance(0.3),
    drift: TRACKED.filter(() => g.chance(0.2)),
    dropUntracked: g.chance(0.15),
    handRestore: g.chance(0.5),
    late: Option.liftPredicate(g.pick(TRACKED), () => g.chance(0.2)),
  }
}

// ── The reference model: contents and modes only ──

/** One checkout: each known file at HEAD, in the index and on disk. */
interface Side {
  readonly head: Map<string, string>
  readonly index: Map<string, string>
  readonly disk: Map<string, string>
}

interface Model {
  readonly base: Side
  readonly lane: Side
}

const emptySide = (): Side => ({ head: new Map(), index: new Map(), disk: new Map() })
const emptyModel = (): Model => ({ base: emptySide(), lane: emptySide() })

const valueIn = (files: ReadonlyMap<string, string>, file: string): string => Option.getOrElse(Option.fromUndefinedOr(files.get(file)), () => MISSING)

/** `file` put back at HEAD, in the index and on disk (a checkout or restore of it). */
const atHead = (side: Side, file: string) => {
  side.index.set(file, valueIn(side.head, file))
  side.disk.set(file, valueIn(side.head, file))
}

/** Whether a checkout's `git status` lists `file`: staged unlike HEAD, or on disk unlike the index (an untracked file: there at all). */
const listed = (side: Side, file: string): boolean => valueIn(side.disk, file) !== valueIn(side.index, file) || valueIn(side.index, file) !== valueIn(side.head, file)

/** The rule: the base lists the file too, and it is alike in both at HEAD, in the index and on disk. */
const inheritedIn = (model: Model, file: string): boolean =>
  listed(model.base, file) && (["head", "index", "disk"] satisfies ReadonlyArray<keyof Side>).every((at) => valueIn(model.lane[at], file) === valueIn(model.base[at], file))

const isOwn = (model: Model, file: string): boolean => listed(model.lane, file) && !inheritedIn(model, file)

const ownOf = (model: Model): ReadonlyArray<string> => ALL.filter((file) => isOwn(model, file)).sort()

/** The tree a receipt names: each file of the lane's HEAD as on disk when it is the lane's own change, else at HEAD. */
const treeOf = (model: Model): string =>
  JSON.stringify(
    ALL.flatMap((file) =>
      [Option.getOrElse(Option.liftPredicate(valueIn(model.lane.disk, file), () => isOwn(model, file)), () => valueIn(model.lane.head, file))].filter(() => valueIn(model.lane.head, file) !== MISSING),
    ),
  )

// ── The real world ──

/** Writes `value` to `file` under `root` (its folder made, its mode set), or removes it for MISSING; the model's disk follows. */
const put = (root: string, side: Side, file: string, value: string) => {
  side.disk.set(file, value)
  const at = join(root, file)
  if (value === MISSING) {
    Option.map(Option.liftPredicate(at, (path) => Option.isSome(readText(path))), unlinkSync)
    return
  }
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, value.slice(2))
  chmodSync(at, Option.getOrElse(Option.liftPredicate(0o755, () => value.startsWith("x|")), () => 0o644))
}

const readText = Option.liftThrowable((path: string) => readFileSync(path, "utf8"))
const execOf = Option.liftThrowable((path: string) => (statSync(path).mode & 0o100) !== 0)

/** `file` under `root` as the model writes it. */
const read = (root: string, file: string): string =>
  Option.getOrElse(
    Option.map(readText(join(root, file)), (text) => `${Option.getOrElse(Option.liftPredicate("x", () => Option.getOrElse(execOf(join(root, file)), () => false)), () => "-")}|${text}`),
    () => MISSING,
  )

/** Commits `file` alone in `root` (staged first when Git does not know it); the model's HEAD takes its disk value. */
const commitOne = (root: string, side: Side, file: string) => {
  sh(root, "git", "add", "--", file)
  sh(root, "git", "commit", "-q", "-m", `commit ${file}`, "--", file)
  side.head.set(file, valueIn(side.disk, file))
  side.index.set(file, valueIn(side.disk, file))
}

/** The paths of one case: the base, its lane and the land logs, under `root`. */
const pathsOf = (root: string) => ({ base: join(root, "app"), lane: join(root, ".work", "app", "lane"), logs: join(root, "logs") })
type Paths = ReturnType<typeof pathsOf>

/** The base, committed at main, then dirtied as the case says; the model's base follows. */
const dirtyBase = (paths: Paths, each: Case, model: Model) => {
  gitInit(paths.base, ["-q", "-b", "main"])
  for (const file of TRACKED) {
    put(paths.base, model.base, file, mainOf(file))
    model.base.head.set(file, mainOf(file))
    model.base.index.set(file, mainOf(file))
  }
  sh(paths.base, "git", "add", "-A")
  sh(paths.base, "git", "commit", "-q", "-m", "init")
  for (const file of TRACKED) {
    const dirt = valueIn(new Map(each.base), file)
    if (dirt === "modified" || dirt === "staged") put(paths.base, model.base, file, plain(`base ${file}\n`))
    if (dirt === "staged") {
      sh(paths.base, "git", "add", "--", file)
      model.base.index.set(file, valueIn(model.base.disk, file))
    }
    if (dirt === "deleted") put(paths.base, model.base, file, MISSING)
    if (dirt === "chmod") put(paths.base, model.base, file, flipped(mainOf(file)))
  }
  if (each.untracked) put(paths.base, model.base, UNTRACKED, plain("base notes\n"))
}

/** The copy: everything the base holds, its index and uncommitted work too. */
const copied = (paths: Paths, model: Model) => {
  mkdirSync(dirname(paths.lane), { recursive: true })
  cpSync(paths.base, paths.lane, { recursive: true })
  for (const [file, value] of model.base.head) model.lane.head.set(file, value)
  for (const [file, value] of model.base.disk) model.lane.disk.set(file, value)
  for (const [file, value] of model.base.index) model.lane.index.set(file, value)
}

/** Every known file of `root` as the model says it is. */
const expectDisk = (root: string, side: Side) => expect(ALL.map((file) => [file, read(root, file)])).toEqual(ALL.map((file) => [file, valueIn(side.disk, file)]))

/** The fresh lane's create step: it restores exactly the tracked files the base has dirty, keeps the untracked one, and leaves the base as it was. */
const settled = (paths: Paths, model: Model) =>
  Effect.gen(function* () {
    const restored = yield* inheritance(ENV).settle(paths.lane, paths.base)
    const expected = TRACKED.filter((file) => listed(model.lane, file))
    expect([...restored].sort()).toEqual([...expected].sort())
    for (const file of expected) atHead(model.lane, file)
    expect(sh(paths.lane, "git", "config", "--local", "--get", COPIED_FROM).trim()).toBe(paths.base)
    expect(sh(paths.lane, "git", "status", "--porcelain", "--untracked-files=no")).toBe("")
    expectDisk(paths.lane, model.lane)
    expectDisk(paths.base, model.base)
  })

/** After the copy: the base's HEAD moves on, the lane commits. */
const commits = (paths: Paths, each: Case, model: Model) => {
  for (const file of Option.toArray(each.baseMoves)) {
    put(paths.base, model.base, file, plain(`moved ${file}\n`))
    commitOne(paths.base, model.base, file)
  }
  for (const file of Option.toArray(each.laneCommits)) {
    put(paths.lane, model.lane, file, plain(`lane committed ${file}\n`))
    commitOne(paths.lane, model.lane, file)
  }
  if (each.laneAdds) {
    put(paths.lane, model.lane, ADDED, plain("added by the lane\n"))
    commitOne(paths.lane, model.lane, ADDED)
  }
}

/** The lane's working changes. */
const laneWork = (paths: Paths, each: Case, model: Model) => {
  for (const file of TRACKED) {
    const edit = valueIn(new Map(each.edits), file)
    if (edit === "edit") put(paths.lane, model.lane, file, plain(`lane ${file}\n`))
    if (edit === "chmod") put(paths.lane, model.lane, file, flipped(valueIn(model.lane.disk, file)))
    if (edit === "delete") put(paths.lane, model.lane, file, MISSING)
    if (edit === "main") put(paths.lane, model.lane, file, mainOf(file))
    // The same bytes and mode the base holds on disk now: inherited only while the lane has not committed the file.
    if (edit === "asBase") put(paths.lane, model.lane, file, valueIn(model.base.disk, file))
    if (edit === "unstage") {
      sh(paths.lane, "git", "reset", "-q", "--", file)
      model.lane.index.set(file, valueIn(model.lane.head, file))
    }
    if (edit === "revert") {
      sh(paths.lane, "git", "checkout", "-q", "HEAD", "--", file)
      atHead(model.lane, file)
    }
  }
  if (each.laneAdds && each.dropAdded) put(paths.lane, model.lane, ADDED, MISSING)
  if (each.added) put(paths.lane, model.lane, NEW, plain("mine\n"))
}

/** After the receipt: the base moves on, the owner restores the inherited copies by hand, the lane edits again. */
const beforeLand = (paths: Paths, each: Case, model: Model) => {
  for (const file of each.drift) put(paths.base, model.base, file, plain(`base again ${file}\n`))
  if (each.dropUntracked) put(paths.base, model.base, UNTRACKED, MISSING)
  const inherited = TRACKED.filter((file) => each.handRestore && listed(model.lane, file) && inheritedIn(model, file))
  if (inherited.length > 0) sh(paths.lane, "git", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...inherited.map((file) => `:(literal)${file}`))
  for (const file of inherited) atHead(model.lane, file)
  for (const file of Option.toArray(each.late)) put(paths.lane, model.lane, file, plain(`late ${file}\n`))
}

/** The lane's own changes and its receipt's standing, as the land reads them; from a folder inside it as well. */
const asLandReads = (paths: Paths) =>
  Effect.gen(function* () {
    const kit = ProcessLanding.receipts(paths.logs, ENV)
    const inside = join(paths.lane, "deep", "er")
    mkdirSync(inside, { recursive: true })
    expect((yield* kit.snapshot(inside)).tree).toBe((yield* kit.snapshot(paths.lane)).tree)
    const landing = yield* Landing
    const own = yield* landing.ownChanges(paths.lane, paths.base)
    expect(yield* landing.ownChanges(inside, paths.base)).toEqual(own)
    return { own: own.map((line) => line.slice(3)).sort(), standing: (yield* landing.standing(paths.lane))._tag }
  })

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
      const model = emptyModel()
      dirtyBase(paths, each, model)
      copied(paths, model)
      if (each.fresh) yield* settled(paths, model)
      commits(paths, each, model)
      laneWork(paths, each, model)
      const kit = ProcessLanding.receipts(paths.logs, ENV)
      yield* Effect.flatMap(kit.snapshot(paths.lane), (at) => Effect.flatMap(kit.made(paths.lane, at, "round", [{ command: "bun test", code: 0, seconds: 1 }]), kit.write))
      const atReceipt = treeOf(model)
      beforeLand(paths, each, model)
      expectDisk(paths.lane, model.lane)
      expectDisk(paths.base, model.base)
      const seen = yield* asLandReads(paths)
      // The property: a change of the lane left out of its own is listed by the base with the same content and mode.
      const left = ALL.filter((file) => listed(model.lane, file) && !seen.own.includes(file))
      expect({ seed: each.seed, left: left.filter((file) => !(listed(model.base, file) && valueIn(model.lane.disk, file) === valueIn(model.base.disk, file))) }).toEqual({ seed: each.seed, left: [] })
      // The model: what the land refuses (and a removal and the lost-lane list count) is the lane's own work, and only that.
      expect({ seed: each.seed, own: seen.own }).toEqual({ seed: each.seed, own: [...ownOf(model)] })
      // The receipt stands while the lane's own tree is as it was.
      const stands = treeOf(model) === atReceipt
      expect({ seed: each.seed, current: seen.standing === "Current", moved: seen.standing === "Moved" }).toEqual({ seed: each.seed, current: stands, moved: !stands })
    }).pipe(Effect.provide(ProcessLanding.layer({ logs: pathsOf(root).logs, env: ENV }))),
  )

/** A case with nothing generated: the base's dirty set below, nothing after the copy but what a test names. */
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
  baseMoves: Option.none(),
  laneCommits: Option.none(),
  laneAdds: false,
  edits: new Map(TRACKED.map((file) => [file, "none"])),
  dropAdded: false,
  added: false,
  drift: [],
  dropUntracked: false,
  handRestore: true,
  late: Option.none(),
}

/** The lane's own changes as the land reads them, after `work` on a lane copied from a clean base: `expected`. */
const probe = (work: (lane: string) => void, expected: ReadonlyArray<string>) =>
  inScratch((root) =>
    Effect.gen(function* () {
      const paths = pathsOf(root)
      const model = emptyModel()
      dirtyBase(paths, { ...QUIET, base: new Map(), untracked: false }, model)
      copied(paths, model)
      work(paths.lane)
      expect(yield* Effect.flatMap(Landing, (landing) => landing.ownChanges(paths.lane, paths.base))).toEqual(expected)
    }).pipe(Effect.provide(ProcessLanding.layer({ logs: pathsOf(root).logs, env: ENV }))),
  )

describe("a workspace copied with its base's uncommitted work", () => {
  // Generated base HEADs and dirty sets × lane commits and working changes, one seed each.
  for (const seed of Array.from({ length: 80 }, (_, index) => index + 1))
    test(`seed ${seed}: the create restores the copies; the land and the receipt agree on what is the lane's own; no change of the lane is left out that the base does not hold`, () =>
      Effect.runPromise(check(caseOf(seed))))

  test("a workspace made before its create restored anything lands, and its receipt stands, through a restore by hand; a change of its own still refuses", () =>
    Effect.runPromise(
      Effect.forEach([{ ...QUIET, edits: new Map<string, LaneEdit>([...QUIET.edits, ["e*.txt", "edit"]]) }, { ...QUIET, late: Option.some("a.txt") }], check, { discard: true }),
    ))

  // The verifier's probes (round 1, V1-V3): each change reads the same as the base's clean main, and is the lane's own.
  test("a mode-only change of the lane is its own", () => Effect.runPromise(probe((lane) => chmodSync(join(lane, "a.txt"), 0o755), [" M a.txt"])))

  test("deleting a file the lane itself committed is its own", () =>
    Effect.runPromise(
      probe(
        (lane) => {
          writeFileSync(join(lane, ADDED), "added by the lane\n")
          sh(lane, "git", "add", "--", ADDED)
          sh(lane, "git", "commit", "-q", "-m", "add")
          unlinkSync(join(lane, ADDED))
        },
        [` D ${ADDED}`],
      ),
    ))

  test("main's text put back on disk over the lane's own commit is its own", () =>
    Effect.runPromise(
      probe(
        (lane) => {
          writeFileSync(join(lane, "a.txt"), "the lane's edit\n")
          sh(lane, "git", "commit", "-q", "-am", "edit")
          writeFileSync(join(lane, "a.txt"), "head a.txt\n")
        },
        [" M a.txt"],
      ),
    ))

  test("an un-ignored .rift file is listed like any other", () => Effect.runPromise(probe((lane) => writeFileSync(join(lane, ".rift"), "{}\n"), ["?? .rift"])))

  test("a base that cannot be read, or a lane that names none, leaves every change the lane's own", () =>
    Effect.runPromise(
      inScratch((root) =>
        Effect.gen(function* () {
          const paths = pathsOf(root)
          const model = emptyModel()
          dirtyBase(paths, QUIET, model)
          copied(paths, model)
          const tools = inheritance(ENV)
          const all = (yield* tools.status(paths.lane)).map((entry) => entry.line).sort()
          expect(all.length).toBeGreaterThan(0)
          // The base's .git is gone: it is no checkout.
          sh(root, "mv", join(paths.base, ".git"), join(root, "away"))
          expect([...(yield* tools.ownLines(paths.lane, paths.base))].sort()).toEqual(all)
          sh(root, "mv", join(root, "away"), join(paths.base, ".git"))
          // The base's .git is there, but Git cannot read it: its status fails.
          const head = readFileSync(join(paths.base, ".git", "HEAD"), "utf8")
          writeFileSync(join(paths.base, ".git", "HEAD"), "not a ref\n")
          expect([...(yield* tools.ownLines(paths.lane, paths.base))].sort()).toEqual(all)
          writeFileSync(join(paths.base, ".git", "HEAD"), head)
          expect((yield* tools.ownLines(paths.lane, paths.base)).length).toBeLessThan(all.length)
          // A lane outside work's layout with no recorded source and none given.
          const elsewhere = join(root, "elsewhere")
          sh(root, "mv", paths.lane, elsewhere)
          expect([...(yield* tools.ownLines(elsewhere))].sort()).toEqual(all)
        }),
      ),
    ))

  test("a base is never settled: its uncommitted work stays, it records no source, and every change in it is its own", () =>
    Effect.runPromise(
      inScratch((root) =>
        Effect.gen(function* () {
          const base = join(root, "app")
          gitInit(base, ["-q", "-b", "main"])
          const side = emptySide()
          put(base, side, "a.txt", plain("head\n"))
          sh(base, "git", "add", "-A")
          sh(base, "git", "commit", "-q", "-m", "init")
          put(base, side, "a.txt", plain("dirty\n"))
          const tools = inheritance(ENV)
          expect(yield* tools.settle(base, base)).toEqual([])
          expect(yield* tools.settle(`${base}/.`, base)).toEqual([])
          expect(read(base, "a.txt")).toBe(plain("dirty\n"))
          expect(Bun.spawnSync(["git", "-C", base, "config", "--local", "--get", COPIED_FROM]).exitCode).toBe(1)
          expect(yield* tools.ownLines(base, base)).toEqual([" M a.txt"])
        }),
      ),
    ))
})
