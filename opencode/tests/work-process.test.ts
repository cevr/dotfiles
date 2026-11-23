// @reads all
// @reads-reason subprocess reads at mods/work/process/command.ts: try: () => Bun.spawn([...argv], { cwd, env: { ...base, ...extra }, stdin: "ignore", stdout: "pi
// accept: deep (415.2 s alone on a quiet host: 1-minute load 22–35 on 12 cores, none quieter to be had; its 33 cases make, commit in, land and remove real workspaces with the real work binary)
// accept: one at a time (it bounds a dead clone's create under 20 s).
// The process Rifts over Ergo's real `work` binary and Git, in a scratch HOME (so the list of bases is the test's
// own) holding a base `code/app` with a bare origin. The provider's environment carries a WORK_BASE that names no
// base, so a call that does not name its own base reads the wrong registry and fails.
//
// The binary is WORK_BIN, else `work` on PATH. It is required: with neither, every case fails `no work binary
// given`, never skips. The cases that need no binary stay beside the code (mods/work/process/work.test.ts).
import { describe, expect, test } from "bun:test"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schedule, Schema } from "effect"
import { gitClone, gitInit, withProcessEnv } from "./git-repo.ts"
import { scratch } from "./scratch.ts"
import { check, riftsLaws, savedWorkCase } from "../mods/work/laws.ts"
import * as MemoryRifts from "../mods/work/memory/rifts.ts"
import { Landing, RiftFailed, Rifts } from "../mods/work/service.ts"
import { removal, type Workspace } from "../mods/work/workspace.ts"
import { commands, lines } from "../mods/work/process/command.ts"
import * as ProcessLanding from "../mods/work/process/landing.ts"
import * as ProcessWork from "../mods/work/process/work.ts"

const PROCESS = withProcessEnv({})
/** The `work` binary the cases run: WORK_BIN, else `work` on PATH; "" when there is neither. */
const WORK_BIN = PROCESS["WORK_BIN"] || Bun.which("work") || ""
const TIMEOUT = 60_000

/** What the tests read of `work --json list` and `work --json new`. */
const RECORDS = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.Struct({ _tag: Schema.String }) })))
const CREATED = Schema.fromJsonString(Schema.Struct({ path: Schema.String }))

/** What a bench is made with: whether the base's `.git/info/exclude` names work.toml, workrift's use, and stub commands put first on PATH. */
interface Setup {
  readonly exclude: boolean
  readonly workrift: boolean
  readonly stubs: ReadonlyArray<readonly [string, string]>
  /** How long a create waits for a workspace of its name being made; the provider's default when absent. */
  readonly makingWaitMs?: number
}

const PLAIN: Setup = { exclude: true, workrift: false, stubs: [] }

/** Writes `text` to `path`, its folder made first. */
const writer = (run: ReturnType<typeof commands>["run"]) => (path: string, text: string) =>
  run(["sh", "-c", 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', "write", text, path], "/").pipe(Effect.orDie, Effect.asVoid)

const setup = Effect.fn("work.bench")(function* (dir: string, made: Setup) {
  if (WORK_BIN === "") return yield* Effect.die("no work binary given: set WORK_BIN to a work binary, or put work on PATH")
  const root = (yield* commands().run(["pwd", "-P"], dir).pipe(Effect.orDie)).trim()
  const env = {
    HOME: `${root}/home`,
    XDG_DATA_HOME: `${root}/home/.local/share`,
    PATH: `${root}/bin:${PROCESS["PATH"] ?? ""}`,
    GIT_AUTHOR_NAME: "Work Test",
    GIT_AUTHOR_EMAIL: "work@example.invalid",
    GIT_COMMITTER_NAME: "Work Test",
    GIT_COMMITTER_EMAIL: "work@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    WORK_BASE: `${root}/plain`,
  }
  const { run, spawn } = commands(env)
  const sh = (cwd: string, ...argv: ReadonlyArray<string>) => run(argv, cwd).pipe(Effect.orDie)
  const write = writer(run)
  const base = `${root}/code/app`
  const origin = `${root}/origin.git`
  yield* sh(root, "mkdir", "-p", env.HOME, `${root}/bin`, `${root}/plain`, `${base}/src`)
  for (const [name, text] of made.stubs) {
    yield* write(`${root}/bin/${name}`, text)
    yield* sh(root, "chmod", "755", `${root}/bin/${name}`)
  }
  yield* Effect.sync(() => {
    gitInit(origin, ["-q", "--bare", "-b", "main"], withProcessEnv(env))
    gitInit(base, ["-q", "-b", "main"], withProcessEnv(env))
  })
  yield* write(`${base}/README.md`, "app\n")
  yield* write(`${base}/src/index.ts`, "export {}\n")
  yield* sh(base, "git", "add", "README.md", "src/index.ts")
  yield* sh(base, "git", "commit", "-q", "-m", "init")
  yield* sh(base, "git", "remote", "add", "origin", origin)
  yield* sh(base, "git", "push", "-q", "-u", "origin", "main")
  yield* sh(base, "git", "remote", "set-head", "origin", "--auto")
  if (made.exclude) yield* sh(base, "sh", "-c", "echo work.toml >> .git/info/exclude")
  /** `work --json <args>` on the base, as the owner would run it. */
  const work = (...args: ReadonlyArray<string>) => run([WORK_BIN, "--json", ...args], base, { WORK_BASE: base })
  /** The same, its exit and both streams answered as they are. */
  const workRan = (...args: ReadonlyArray<string>) => spawn([WORK_BIN, "--json", ...args], base, { WORK_BASE: base }).pipe(Effect.orDie)
  yield* work("init").pipe(Effect.orDie)
  return {
    root,
    env,
    base,
    origin,
    sh,
    write,
    work,
    workRan,
    layer: ProcessWork.layer({ work: WORK_BIN, workrift: made.workrift, env, ...Option.toArray(Option.fromUndefinedOr(made.makingWaitMs)).map((makingWaitMs) => ({ makingWaitMs }))[0] }),
    source: base,
    inside: `${base}/src`,
    plain: `${root}/plain`,
    commit: (path: string) => sh(path, "git", "commit", "-q", "--allow-empty", "-m", "only here").pipe(Effect.asVoid),
    dirty: (path: string) => write(`${path}/scratch.txt`, "unsaved\n"),
    stash: (path: string) => write(`${path}/README.md`, `stashed in ${path}\n`).pipe(Effect.andThen(sh(path, "git", "stash", "push", "-q", "-m", "wip")), Effect.asVoid),
    switchTo: (path: string, branch: string) => sh(path, "git", "switch", "-q", "-c", branch).pipe(Effect.asVoid),
    head: sh(base, "git", "rev-parse", "HEAD").pipe(Effect.map((out) => out.trim())),
    missing: "0123456789abcdef0123456789abcdef01234567",
  }
})

/** A fresh scratch folder and a bench in it, removed when the case ends. */
const bench = (made: Setup) => () =>
  Effect.acquireRelease(
    Effect.sync(() => scratch("work-process-")),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ).pipe(Effect.flatMap((held) => setup(held.path, made)))

const plain = bench(PLAIN)

/** The trimmed output of `argv` in `cwd`, run by `made`'s shell. */
const out = (made: { readonly sh: (cwd: string, ...argv: ReadonlyArray<string>) => Effect.Effect<string> }, cwd: string, ...argv: ReadonlyArray<string>) =>
  made.sh(cwd, ...argv).pipe(Effect.map((text) => text.trim()))

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/** What the model test compares of one workspace: names, not paths, and commits by subject. */
interface View {
  readonly branch: string
  readonly children: ReadonlyArray<string>
  readonly uncommitted: ReadonlyArray<string>
  readonly unpushed: ReadonlyArray<string>
  readonly stashes: number
}

const viewOf = (workspace: Workspace): View => ({
  branch: workspace.branch ?? "(detached)",
  children: workspace.children.map(nameOf).sort(),
  uncommitted: [...workspace.uncommitted].sort(),
  unpushed: workspace.unpushed.map((line) => line.slice(line.indexOf(" ") + 1)).sort(),
  stashes: workspace.stashes,
})

/** Every workspace under `source`, by name, read through `rifts`' list and inspect, children and theirs included. */
const viewAll = (rifts: typeof Rifts.Service, source: string) =>
  Effect.gen(function* () {
    const seen = new Map<string, View>()
    const walk = (paths: ReadonlyArray<string>): Effect.Effect<void, RiftFailed> =>
      Effect.forEach(
        paths,
        (path) =>
          rifts.inspect(path).pipe(
            Effect.tap((workspace) => Effect.sync(() => seen.set(nameOf(path), viewOf(workspace)))),
            Effect.flatMap((workspace) => walk(workspace.children)),
          ),
        { discard: true },
      )
    yield* walk(yield* rifts.list(source))
    return new Map([...seen].sort(([a], [b]) => Number(a > b) - Number(a < b)))
  })

/** A seeded generator of numbers in [0, 1). */
const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const KINDS = ["create", "createOn", "commit", "dirty", "stash", "remove", "removeTree"] as const
type Kind = (typeof KINDS)[number]

/** One workspace the model test made: its path under work and in the memory reference, and its parent's name (none: the base). */
interface Made {
  readonly work: string
  readonly memory: string
  readonly parent: Option.Option<string>
}

const MEMORY_SOURCE = "/m/code/app"

type Bench = Effect.Success<ReturnType<typeof setup>>

/** The model test's two worlds and what it made in them. */
interface Model {
  readonly made: Bench
  readonly work: typeof Rifts.Service
  readonly memory: typeof Rifts.Service
  readonly state: MemoryRifts.World
  readonly live: Map<string, Made>
}

/** One step's target and the names a step that makes one gives it. */
interface Step {
  readonly target: Made
  readonly targetName: string
  readonly n: number
}

const childrenOf = (model: Model, name: string): ReadonlyArray<string> =>
  [...model.live].flatMap(([child, each]) => [child].filter(() => Option.contains(each.parent, name)))

const drop = (model: Model, name: string): void => {
  for (const child of childrenOf(model, name)) drop(model, child)
  model.live.delete(name)
}

const removeStep = (withChildren: boolean) => (model: Model, step: Step) =>
  Effect.gen(function* () {
    const left = yield* Effect.exit(model.work.remove(step.target.work, { withChildren }))
    const right = yield* Effect.exit(model.memory.remove(step.target.memory, { withChildren }))
    expect({ step: step.n, removed: Exit.isSuccess(left) }).toEqual({ step: step.n, removed: Exit.isSuccess(right) })
    if (Exit.isFailure(right)) return
    yield* Option.match(step.target.parent, {
      onNone: () => Effect.void,
      onSome: (parent) =>
        Effect.sync(() =>
          MemoryRifts.change(model.state, model.live.get(parent)?.memory ?? "", (workspace) => ({
            ...workspace,
            children: workspace.children.filter((child) => child !== step.target.memory),
          })),
        ),
    })
    drop(model, step.targetName)
  })

/** What each kind of step does in both worlds. */
type Steps = { readonly [K in Kind]: (model: Model, step: Step) => Effect.Effect<void, RiftFailed> }

const STEPS = {
  create: (model, step) =>
    Effect.gen(function* () {
      const request = { name: `w${step.n}`, branch: `b/${step.n}` }
      const path = yield* model.work.create({ ...request, source: model.made.base, from: model.made.base })
      const mirrored = yield* model.memory.create({ ...request, source: MEMORY_SOURCE, from: MEMORY_SOURCE })
      model.live.set(request.name, { work: path, memory: mirrored, parent: Option.none() })
    }),
  createOn: (model, step) =>
    Effect.gen(function* () {
      const request = { name: `w${step.n}`, branch: `b/${step.n}` }
      const path = yield* model.work.create({ ...request, source: step.target.work, from: model.made.base })
      const mirrored = `/m/children/${request.name}`
      const from = yield* model.memory.inspect(step.target.memory)
      model.state.rifts.set(mirrored, { ...MemoryRifts.clean(mirrored, request.branch), uncommitted: [...from.uncommitted], unpushed: [...from.unpushed] })
      model.state.stashed.set(mirrored, [])
      MemoryRifts.change(model.state, step.target.memory, (workspace) => ({ ...workspace, children: [...workspace.children, mirrored] }))
      model.live.set(request.name, { work: path, memory: mirrored, parent: Option.some(step.targetName) })
    }),
  commit: (model, step) =>
    model.made.sh(step.target.work, "git", "commit", "-q", "--allow-empty", "-m", `only here ${step.n}`).pipe(
      Effect.andThen(
        Effect.sync(() => MemoryRifts.change(model.state, step.target.memory, (workspace) => ({ ...workspace, unpushed: [`0000000 only here ${step.n}`, ...workspace.unpushed] }))),
      ),
    ),
  dirty: (model, step) =>
    model.made.write(`${step.target.work}/dirty-${step.n}.txt`, `${step.n}\n`).pipe(
      Effect.andThen(
        Effect.sync(() => MemoryRifts.change(model.state, step.target.memory, (workspace) => ({ ...workspace, uncommitted: [...workspace.uncommitted, `?? dirty-${step.n}.txt`] }))),
      ),
    ),
  stash: (model, step) =>
    model.made.write(`${step.target.work}/README.md`, `stash ${step.n}\n`).pipe(
      Effect.andThen(model.made.sh(step.target.work, "git", "stash", "push", "-q", "-m", `stash ${step.n}`)),
      Effect.andThen(Effect.sync(() => MemoryRifts.stash(model.state, step.target.memory, `stash-${step.n}`))),
    ),
  remove: removeStep(false),
  removeTree: removeStep(true),
} satisfies Steps

/**
 * `steps` random steps over the real binary and the memory provider, compared after each: the memory
 * provider makes the base's workspaces; a workspace made on another is laid out in memory by hand, as
 * memory/rifts.ts makes only a source's, carrying what a clone of its parent carries (its uncommitted
 * files and its commits, none of its stash as its own).
 */
const model = (seed: number, steps: number) =>
  check(plain, (made) =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = MemoryRifts.world([MEMORY_SOURCE])
        const memory = Context.get(yield* Layer.build(MemoryRifts.layer(state)), Rifts)
        const world: Model = { made, work: yield* Rifts, memory, state, live: new Map() }
        const random = seeded(seed)
        const history: Array<string> = []
        for (let n = 0; n < steps; n++) {
          const names = [...world.live.keys()]
          const targetName = names[Math.floor(random() * names.length)] ?? ""
          const drawn = KINDS[Math.floor(random() * KINDS.length)] ?? "create"
          const kind = [drawn].filter(() => names.length > 0)[0] ?? "create"
          history.push(`${n}: ${kind} ${targetName}`)
          const target = world.live.get(targetName) ?? { work: "", memory: "", parent: Option.none() }
          yield* STEPS[kind](world, { target, targetName, n })
          expect({ history, workspaces: yield* viewAll(world.work, made.base) }).toEqual({ history, workspaces: yield* viewAll(memory, MEMORY_SOURCE) })
        }
      }),
    ),
  )

/** A `cp` that, for the copy-on-write clone (`cp -c`), says it started, waits for the test's go before it copies, and says when it is done. */
const SLOW_CP = `#!/bin/sh
if [ "$1" = "-c" ]; then
  : > "$HOME/clone.started"
  while [ ! -e "$HOME/clone.go" ]; do sleep 0.05; done
  /bin/cp "$@"
  copied=$?
  : > "$HOME/clone.done"
  exit $copied
fi
exec /bin/cp "$@"
`

/** A `cp` whose copy-on-write clone says it started and fails 3 s later: its `work new` gives the name up. */
const FAILING_CP = `#!/bin/sh
if [ "$1" = "-c" ]; then
  : > "$HOME/clone.started"
  sleep 3
  echo "cp: the clone failed" >&2
  exit 1
fi
exec /bin/cp "$@"
`

/** A `perl` whose first run (the maker probe) says it started and waits for the test's go before it probes. */
const HELD_PERL = `#!/bin/sh
if [ ! -e "$HOME/probe.go" ]; then
  : > "$HOME/probe.started"
  while [ ! -e "$HOME/probe.go" ]; do sleep 0.05; done
fi
exec /usr/bin/perl "$@"
`

/** The words of a failed create, or "made" when it was made. */
const failureWords = <R>(effect: Effect.Effect<string, RiftFailed, R>) =>
  effect.pipe(
    Effect.map(() => "made"),
    Effect.catchTag("RiftFailed", (error) => Effect.succeed(error.message)),
  )

/** A `workrift` that logs how it was called and answers the workspace path the test gave it. */
const LOGGING_WORKRIFT = `#!/bin/sh
echo "$* source=$WORKRIFT_SOURCE" >> "$HOME/workrift.log"
if [ "$1" = "create" ]; then cat "$HOME/workrift.answer"; fi
`

// A clean start. A create resets the workspace its `work new` made to its HEAD (tracked files and index); after
// that, every uncommitted change is the workspace's own. The property draws a dirty base (unstaged, staged, MM,
// MD, mode, delete, staged delete, rename, staged addition, untracked) and then changes of the lane's own of
// every kind (edit, staged only, staged with the base's text left on disk, mode, delete, staged delete, rename,
// untracked, the base's own copy put back, main's text back over a commit, a committed file deleted).

/** The files of HEAD the clean-start cases change: six texts and a script. */
const CLEAN_FILES = ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt", "run.sh"] as const

const BASE_DIRT = ["edit", "stage", "MM", "MD", "mode", "delete", "stagedDelete", "rename", "add", "untracked"] as const
const LANE_CHANGES = ["edit", "stagedOnly", "stageKeepBase", "mode", "delete", "stagedDelete", "rename", "untracked", "baseCopy", "commitThenRevert", "commitThenDelete"] as const

/** The entries of `git status --porcelain=v1 -z`: `XY path`, a rename's old path dropped. */
const zEntries = (output: string): ReadonlyArray<{ readonly line: string; readonly file: string }> => {
  const fields = output.split("\0").filter((field) => field !== "")
  const entries: Array<{ line: string; file: string }> = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? ""
    entries.push({ line: field, file: field.slice(3) })
    if (field[0] === "R" || field[0] === "C") index++
  }
  return entries
}

/** One clean-start case's tools over a bench. */
const cleanTools = (made: Bench) => {
  const { spawn } = commands(made.env)
  const code = (cwd: string, ...argv: ReadonlyArray<string>) => spawn(argv, cwd).pipe(Effect.orDie, Effect.map((ran) => ran.code))
  const status = (path: string) => made.sh(path, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all")
  /** Whether `file` reads the same in both checkouts: missing in both, or the same bytes (f957c17e's land rule, `same`). */
  const sameIn = (left: string, right: string, file: string) =>
    code("/", "sh", "-c", 'if [ -e "$1" ] || [ -e "$2" ]; then cmp -s "$1" "$2"; else exit 0; fi', "same", `${left}/${file}`, `${right}/${file}`).pipe(Effect.map((exit) => exit === 0))
  /**
   * Where the base's `file` on disk is HEAD's (bytes and mode), `text` written to `lane`'s; else the base's copy put
   * there, mode and bytes, or removed where the base has none.
   */
  const baseCopyOr = (lane: string, file: string, text: string) =>
    made
      .sh(
        "/",
        "sh",
        "-c",
        'if git -C "$1" diff --quiet HEAD -- "$3"; then printf "%s" "$4" > "$2/$3"; elif [ -e "$1/$3" ]; then cp -p "$1/$3" "$2/$3"; else rm -f "$2/$3"; fi',
        "copy",
        made.base,
        lane,
        file,
        text,
      )
      .pipe(Effect.asVoid)
  /** `file` under `root` made executable when it is not, and not when it is. */
  const toggleMode = (root: string, file: string) => made.sh(root, "sh", "-c", 'if [ -x "$1" ]; then chmod 644 "$1"; else chmod 755 "$1"; fi', "toggle", file).pipe(Effect.asVoid)
  return { code, status, sameIn, baseCopyOr, toggleMode }
}

/** Lays out the clean-start files in the base's HEAD: six texts and an executable script. */
const cleanFiles = (made: Bench) =>
  Effect.gen(function* () {
    for (const file of CLEAN_FILES) yield* made.write(`${made.base}/${file}`, `${file} at HEAD\n`)
    yield* made.sh(made.base, "chmod", "755", "run.sh")
    yield* made.sh(made.base, "git", "add", ...CLEAN_FILES)
    yield* made.sh(made.base, "git", "commit", "-q", "-m", "clean-start files")
  })

/** One kind of the base's uncommitted work on `file`, case `n`. */
const dirtBase = (made: Bench, tools: ReturnType<typeof cleanTools>, kind: (typeof BASE_DIRT)[number], file: string, n: number) => {
  const at = (name: string) => `${made.base}/${name}`
  const git = (...args: ReadonlyArray<string>) => made.sh(made.base, "git", ...args)
  switch (kind) {
    case "edit":
      return made.write(at(file), `base ${n} edit\n`)
    case "stage":
      return made.write(at(file), `base ${n} staged\n`).pipe(Effect.andThen(git("add", file)))
    case "MM":
      return made.write(at(file), `base ${n} staged\n`).pipe(Effect.andThen(git("add", file)), Effect.andThen(made.write(at(file), `base ${n} on disk\n`)))
    case "MD":
      return made.write(at(file), `base ${n} staged\n`).pipe(Effect.andThen(git("add", file)), Effect.andThen(made.sh(made.base, "rm", file)))
    case "mode":
      return tools.toggleMode(made.base, file)
    case "delete":
      return made.sh(made.base, "rm", file)
    case "stagedDelete":
      return git("rm", "-q", file)
    case "rename":
      return git("mv", file, `${file}.moved`)
    case "add":
      return made.write(at(`added-${n}.txt`), `base ${n} added\n`).pipe(Effect.andThen(git("add", `added-${n}.txt`)))
    case "untracked":
      return made.write(at(`notes/u-${n}.md`), `base ${n} notes\n`)
  }
}

/** One kind of the lane's own change on `file`, case `n`. */
const changeLane = (made: Bench, tools: ReturnType<typeof cleanTools>, lane: string, kind: (typeof LANE_CHANGES)[number], file: string, n: number) => {
  const at = (name: string) => `${lane}/${name}`
  const git = (...args: ReadonlyArray<string>) => made.sh(lane, "git", ...args)
  const own = `lane ${n} ${file}\n`
  switch (kind) {
    case "edit":
      return made.write(at(file), own)
    case "stagedOnly":
      return made.write(at(file), own).pipe(Effect.andThen(git("add", file)))
    case "stageKeepBase":
      // The base's copy back on disk; HEAD's text where the base holds HEAD's (the lane's change then lives in its index alone).
      return made.write(at(file), own).pipe(Effect.andThen(git("add", file)), Effect.andThen(tools.baseCopyOr(lane, file, `${file} at HEAD\n`)))
    case "mode":
      return tools.toggleMode(lane, file)
    case "delete":
      return made.sh(lane, "rm", file)
    case "stagedDelete":
      return git("rm", "-q", file)
    case "rename":
      return git("mv", file, `${file}.lane`)
    case "untracked":
      return made.write(at(`lane-${n}/new.txt`), own)
    case "baseCopy":
      // The base's copy put back: the change the earlier rule took for the base's. Where the base holds HEAD's, an edit.
      return tools.baseCopyOr(lane, file, own)
    case "commitThenRevert":
      return made.write(at(file), own).pipe(
        Effect.andThen(git("commit", "-q", "-m", `lane ${n}`, "--", file)),
        Effect.andThen(made.write(at(file), `${file} at HEAD\n`)),
      )
    case "commitThenDelete":
      return made.write(at(`committed-${n}.txt`), own).pipe(
        Effect.andThen(git("add", `committed-${n}.txt`)),
        Effect.andThen(git("commit", "-q", "-m", `lane ${n} adds`, "--", `committed-${n}.txt`)),
        Effect.andThen(made.sh(lane, "rm", `committed-${n}.txt`)),
      )
  }
}

/** `count` of `pool`'s items, drawn without repeats. */
const drawSome = <A>(random: () => number, pool: ReadonlyArray<A>, count: number): ReadonlyArray<A> => {
  const left = [...pool]
  return Array.from({ length: Math.min(count, left.length) }, () => left.splice(Math.floor(random() * left.length), 1)).flat()
}

/**
 * The clean-start property, `cases` cases from `seed` on one bench: each puts the base back at its HEAD, dirties it,
 * makes a lane and checks it starts clean for its tracked files and its index, its untracked copies kept and the base
 * untouched; then changes the lane and checks no change is hidden: inspect lists exactly `git status`, a removal
 * refuses, and the land's refusal (`ownChanges`) reads f957c17e's rule, unchanged (see OB1 in the unit's request).
 */
const cleanStartProperty = (seed: number, cases: number) =>
  check(plain, (made) =>
    Effect.gen(function* () {
      const rifts = yield* Rifts
      const landing = Context.get(yield* Effect.scoped(Layer.build(ProcessLanding.layer({ logs: `${made.root}/logs`, env: made.env }))), Landing)
      const tools = cleanTools(made)
      const random = seeded(seed)
      yield* cleanFiles(made)
      const drawn = new Set<string>()
      for (let n = 0; n < cases; n++) {
        // The base back at its HEAD, then dirtied.
        yield* made.sh(made.base, "git", "reset", "-q", "--hard", "HEAD")
        yield* made.sh(made.base, "git", "clean", "-q", "-fd")
        const dirt = drawSome(random, CLEAN_FILES, 1 + Math.floor(random() * 4)).map((file) => ({ file, kind: BASE_DIRT[Math.floor(random() * BASE_DIRT.length)] ?? "edit" }))
        for (const each of dirt) yield* dirtBase(made, tools, each.kind, each.file, n)
        const before = yield* tools.status(made.base)
        const lane = yield* rifts.create({ source: made.base, from: made.base, name: `p${seed}-${n}`, branch: `p/${seed}-${n}` })
        const label = { seed, n, dirt }
        // A fresh lane: tracked files and index at HEAD; the base's untracked files kept, the same bytes; the base untouched.
        expect({ ...label, base: yield* tools.status(made.base) }).toEqual({ ...label, base: before })
        const fresh = zEntries(yield* tools.status(lane))
        const theirs = zEntries(before).filter((entry) => entry.line.startsWith("?? ")).map((entry) => entry.line)
        expect({ ...label, tracked: fresh.filter((entry) => !entry.line.startsWith("?? ")).map((entry) => entry.line) }).toEqual({ ...label, tracked: [] })
        expect({ ...label, index: yield* tools.code(lane, "git", "diff", "--cached", "--quiet", "HEAD") }).toEqual({ ...label, index: 0 })
        for (const entry of fresh) {
          expect({ ...label, untracked: entry.line, theirs: theirs.includes(entry.line) }).toEqual({ ...label, untracked: entry.line, theirs: true })
          expect({ ...label, untracked: entry.file, same: yield* tools.sameIn(lane, made.base, entry.file) }).toEqual({ ...label, untracked: entry.file, same: true })
        }
        const freshLines = (yield* rifts.inspect(lane)).uncommitted
        // The lane's own changes, on files the base's dirt may also name.
        const changes = drawSome(random, CLEAN_FILES, 1 + Math.floor(random() * 3)).map((file) => ({ file, kind: LANE_CHANGES[Math.floor(random() * LANE_CHANGES.length)] ?? "edit" }))
        for (const each of changes) yield* changeLane(made, tools, lane, each.kind, each.file, n)
        const told = { ...label, changes }
        const workspace = yield* rifts.inspect(lane)
        const plainStatus = lines(yield* made.sh(lane, "git", "status", "--porcelain"))
        // Every change shows in git status, and inspect hides none of it.
        expect({ ...told, changed: [...plainStatus].sort().join("\n") !== [...freshLines].sort().join("\n") }).toEqual({ ...told, changed: true })
        expect({ ...told, uncommitted: workspace.uncommitted }).toEqual({ ...told, uncommitted: plainStatus })
        const refused = yield* Effect.flip(removal(workspace, { force: false, sessionDirectory: made.root }))
        expect({ ...told, refused: refused._tag }).toEqual({ ...told, refused: "WorkUnsaved" })
        // The land's refusal: each entry whose file reads otherwise than the base's (f957c17e's rule, OB1 unchanged).
        const differ: Array<string> = []
        for (const entry of zEntries(yield* tools.status(lane))) if (!(yield* tools.sameIn(lane, made.base, entry.file))) differ.push(entry.line)
        expect({ ...told, own: [...(yield* landing.ownChanges(lane, made.base))].sort() }).toEqual({ ...told, own: differ.sort() })
        for (const each of dirt) drawn.add(`base ${each.kind}`)
        for (const each of changes) drawn.add(`lane ${each.kind}`)
      }
      // The seed reaches every kind of the base's dirt and of the lane's change.
      expect([...drawn].sort()).toEqual([...BASE_DIRT.map((kind) => `base ${kind}`), ...LANE_CHANGES.map((kind) => `lane ${kind}`)].sort())
    }),
  )

riftsLaws("process Rifts on work", plain, TIMEOUT)

describe("process Rifts on work", () => {
  for (const seed of [7, 1_000_003])
    test(
      `model (seed ${seed}): random creates (on the base and on a workspace), commits, edits, stashes and removals agree with the memory provider after every step`,
      () => model(seed, 12),
      TIMEOUT,
    )

  test(
    "source answers the base for a directory in the base, in a workspace, in an adopted copy elsewhere and in a workspace made on either; one in no base fails naming work init",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const workspace = yield* rifts.create({ source: made.base, from: made.base, name: "ws", branch: "ws" })
          const adopted = `${made.root}/elsewhere/copy`
          yield* Effect.sync(() => gitClone(made.base, adopted, ["-q"], withProcessEnv(made.env)))
          yield* made.work("adopt", adopted).pipe(Effect.orDie)
          const stacked = yield* rifts.create({ source: workspace, from: workspace, name: "stacked", branch: "stacked" })
          const onAdopted = yield* rifts.create({ source: adopted, from: adopted, name: "on-adopted", branch: "on-adopted" })
          expect(yield* rifts.list(made.base)).toEqual([adopted, workspace].sort())
          expect((yield* rifts.inspect(workspace)).children).toEqual([stacked])
          expect(yield* rifts.inspect(adopted)).toMatchObject({ source: false, children: [onAdopted], uncommitted: [], unpushed: [] })
          for (const at of [made.base, workspace, adopted, stacked, onAdopted]) {
            for (const below of ["", "/src", "/src/deep/er"]) {
              yield* made.sh(made.root, "mkdir", "-p", `${at}${below}`)
              expect({ at: `${at}${below}`, source: yield* rifts.source(`${at}${below}`) }).toEqual({ at: `${at}${below}`, source: made.base })
            }
          }
          const nowhere = yield* Effect.flip(rifts.source(made.plain))
          expect(nowhere).toBeInstanceOf(RiftFailed)
          expect(nowhere.message).toContain("work init")
        }),
      ),
    TIMEOUT,
  )

  test(
    "create checks out the base's local branch, else origin's branch tracking it, else a new branch at the base's head; at detaches, fetching a commit only origin has; a commit nowhere leaves no live record",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const head = yield* out(made, made.base, "git", "rev-parse", "HEAD")
          yield* made.sh(made.base, "git", "switch", "-q", "-c", "local")
          yield* made.sh(made.base, "git", "commit", "-q", "--allow-empty", "-m", "local only")
          const local = yield* out(made, made.base, "git", "rev-parse", "HEAD")
          yield* made.sh(made.base, "git", "switch", "-q", "main")
          const other = `${made.root}/other`
          yield* Effect.sync(() => gitClone(made.origin, other, ["-q"], withProcessEnv(made.env)))
          yield* made.sh(other, "git", "switch", "-q", "-c", "remote-only")
          yield* made.sh(other, "git", "commit", "-q", "--allow-empty", "-m", "remote only")
          yield* made.sh(other, "git", "push", "-q", "origin", "remote-only")
          const remote = yield* out(made, other, "git", "rev-parse", "HEAD")
          yield* made.sh(made.base, "git", "fetch", "-q", "origin")
          yield* made.sh(other, "git", "switch", "-q", "-c", "later")
          yield* made.sh(other, "git", "commit", "-q", "--allow-empty", "-m", "later")
          yield* made.sh(other, "git", "push", "-q", "origin", "later")
          const later = yield* out(made, other, "git", "rev-parse", "HEAD")

          const onLocal = yield* rifts.create({ source: made.base, from: made.base, name: "on-local", branch: "local" })
          expect(yield* out(made, onLocal, "git", "rev-parse", "HEAD")).toBe(local)
          expect((yield* rifts.inspect(onLocal)).branch).toBe("local")
          const onRemote = yield* rifts.create({ source: made.base, from: made.base, name: "on-remote", branch: "remote-only" })
          expect(yield* out(made, onRemote, "git", "rev-parse", "HEAD")).toBe(remote)
          expect(yield* out(made, onRemote, "git", "rev-parse", "--abbrev-ref", "remote-only@{upstream}")).toBe("origin/remote-only")
          expect(yield* rifts.inspect(onRemote)).toMatchObject({ branch: "remote-only", uncommitted: [], unpushed: [] })
          const fresh = yield* rifts.create({ source: made.base, from: made.base, name: "fresh", branch: "fresh/x" })
          expect(yield* out(made, fresh, "git", "rev-parse", "HEAD")).toBe(head)
          expect((yield* rifts.inspect(fresh)).branch).toBe("fresh/x")
          expect((yield* made.sh(fresh, "git", "rev-parse", "--abbrev-ref", "fresh/x@{upstream}").pipe(Effect.exit))._tag).toBe("Failure")

          const fetched = yield* rifts.create({ source: made.base, from: made.base, name: "fetched", branch: "fetched", at: later })
          expect(yield* out(made, fetched, "git", "rev-parse", "HEAD")).toBe(later)
          expect((yield* rifts.inspect(fetched)).branch).toBeUndefined()
          const failed = yield* Effect.flip(rifts.create({ source: made.base, from: made.base, name: "nowhere", branch: "nowhere", at: made.missing }))
          expect(failed.message).toContain("was removed")
          const records = yield* made.work("list").pipe(Effect.flatMap(Schema.decodeUnknownEffect(RECORDS)), Effect.orDie)
          expect(records.flatMap((record) => [record.state._tag].filter(() => record.name === "nowhere"))).toEqual(["Trashed"])
          expect(yield* rifts.list(made.base)).not.toContain(`${made.root}/code/.work/app/nowhere`)
        }),
      ),
    TIMEOUT,
  )

  for (const seed of [11, 4_242])
    test(
      `clean start (seed ${seed}): over a base dirtied every way, a fresh lane is at HEAD in its files and index with the base's untracked files kept and the base untouched; then no change of the lane's own is hidden from inspect or a removal, and the land reads f957c17e's rule`,
      () => cleanStartProperty(seed, 40),
      240_000,
    )

  test(
    "create resets the workspace its work new made to HEAD: the base's unstaged, staged, MM and MD edits leave its files and its index, its untracked files stay; the base keeps all of it",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          yield* made.write(`${made.base}/README.md`, "staged by a tool in the base\n")
          yield* made.sh(made.base, "git", "add", "README.md")
          yield* made.write(`${made.base}/README.md`, "rewritten on disk by a tool in the base\n")
          yield* made.write(`${made.base}/src/index.ts`, "export const staged = 1\n")
          yield* made.sh(made.base, "git", "add", "src/index.ts")
          yield* made.sh(made.base, "rm", "src/index.ts")
          yield* made.write(`${made.base}/notes/untracked.md`, "the base's notes\n")
          const before = yield* out(made, made.base, "git", "status", "--porcelain")
          expect(before.split("\n").sort()).toEqual(["?? notes/", "MD src/index.ts", "MM README.md"])
          const lane = yield* rifts.create({ source: made.base, from: made.base, name: "clean-start", branch: "clean-start" })
          expect(yield* out(made, lane, "git", "status", "--porcelain")).toBe("?? notes/")
          expect(yield* out(made, lane, "cat", "README.md")).toBe("app")
          expect(yield* out(made, lane, "git", "show", ":src/index.ts")).toBe("export {}")
          expect(yield* out(made, lane, "cat", "notes/untracked.md")).toBe("the base's notes")
          expect(yield* out(made, made.base, "git", "status", "--porcelain")).toBe(before)
          expect(yield* out(made, made.base, "git", "show", ":README.md")).toBe("staged by a tool in the base")
          // After the create every change is the lane's own, the base's untracked copy too, as at f957c17e.
          expect(yield* rifts.inspect(lane)).toMatchObject({ uncommitted: ["?? notes/"], unpushed: [] })
        }),
      ),
    TIMEOUT,
  )

  test(
    "a lane's own change that reads the same as its clean base is still its own (round 1's probes): a mode-only change, deleting a file it committed, main's text put back over its commit; inspect lists each and a removal refuses",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const probes = [
            { name: "mode-only", change: (lane: string) => made.sh(lane, "chmod", "+x", "README.md"), expected: [" M README.md"] },
            {
              name: "drop-added",
              change: (lane: string) =>
                made.write(`${lane}/added.ts`, "export {}\n").pipe(
                  Effect.andThen(made.sh(lane, "git", "add", "added.ts")),
                  Effect.andThen(made.sh(lane, "git", "commit", "-q", "-m", "add")),
                  Effect.andThen(made.sh(lane, "rm", "added.ts")),
                ),
              expected: [" D added.ts"],
            },
            {
              name: "back-to-main",
              change: (lane: string) =>
                made.write(`${lane}/README.md`, "the lane's edit\n").pipe(
                  Effect.andThen(made.sh(lane, "git", "commit", "-q", "-am", "edit")),
                  Effect.andThen(made.write(`${lane}/README.md`, "app\n")),
                ),
              expected: [" M README.md"],
            },
          ]
          for (const probe of probes) {
            const lane = yield* rifts.create({ source: made.base, from: made.base, name: probe.name, branch: probe.name })
            yield* probe.change(lane)
            const workspace = yield* rifts.inspect(lane)
            expect({ probe: probe.name, uncommitted: workspace.uncommitted }).toEqual({ probe: probe.name, uncommitted: probe.expected })
            const refused = yield* Effect.flip(removal(workspace, { force: false, sessionDirectory: made.root }))
            expect(refused._tag).toBe("WorkUnsaved")
          }
        }),
      ),
    TIMEOUT,
  )

  test(
    "a lane's own staged work behind the base's MM or MD entry, the base's text left on disk (round 2's k1 and k2), is listed by inspect and refuses a removal",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const probes = [
            { name: "k1", disk: (lane: string) => made.write(`${lane}/README.md`, "C\n"), base: () => made.write(`${made.base}/README.md`, "C\n"), expected: ["MM README.md"] },
            { name: "k2", disk: (lane: string) => made.sh(lane, "rm", "README.md"), base: () => made.sh(made.base, "rm", "README.md"), expected: ["MD README.md"] },
          ]
          for (const probe of probes) {
            yield* made.sh(made.base, "git", "reset", "-q", "--hard", "HEAD")
            yield* made.write(`${made.base}/README.md`, "A\n")
            yield* made.sh(made.base, "git", "add", "README.md")
            yield* probe.base()
            const lane = yield* rifts.create({ source: made.base, from: made.base, name: probe.name, branch: probe.name })
            yield* made.write(`${lane}/README.md`, "the lane's own staged work\n")
            yield* made.sh(lane, "git", "add", "README.md")
            yield* probe.disk(lane)
            const workspace = yield* rifts.inspect(lane)
            expect({ probe: probe.name, uncommitted: workspace.uncommitted }).toEqual({ probe: probe.name, uncommitted: probe.expected })
            const refused = yield* Effect.flip(removal(workspace, { force: false, sessionDirectory: made.root }))
            expect({ probe: probe.name, refused: refused._tag }).toEqual({ probe: probe.name, refused: "WorkUnsaved" })
          }
        }),
      ),
    TIMEOUT,
  )

  test(
    "a lane made on a lane is reset to its own HEAD; the parent keeps its own changes",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const parent = yield* rifts.create({ source: made.base, from: made.base, name: "parent", branch: "parent" })
          yield* made.write(`${parent}/README.md`, "the parent's own edit\n")
          yield* made.write(`${parent}/src/index.ts`, "export const staged = 1\n")
          yield* made.sh(parent, "git", "add", "src/index.ts")
          const before = lines(yield* made.sh(parent, "git", "status", "--porcelain"))
          expect(before).toEqual([" M README.md", "M  src/index.ts"])
          const child = yield* rifts.create({ source: parent, from: parent, name: "child", branch: "child" })
          expect(yield* out(made, child, "git", "status", "--porcelain")).toBe("")
          expect(lines(yield* made.sh(parent, "git", "status", "--porcelain"))).toEqual(before)
          expect((yield* rifts.inspect(parent)).uncommitted).toEqual(before)
        }),
      ),
    TIMEOUT,
  )

  test(
    "a create resets nothing it did not make: a folder already at the workspace's path keeps its changes",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const taken = `${made.root}/code/.work/app/taken`
          yield* Effect.sync(() => gitClone(made.base, taken, ["-q"], withProcessEnv(made.env)))
          yield* made.write(`${taken}/README.md`, "work in a folder no create made\n")
          yield* made.write(`${taken}/src/index.ts`, "export const staged = 1\n")
          yield* made.sh(taken, "git", "add", "src/index.ts")
          const before = yield* out(made, taken, "git", "status", "--porcelain")
          // work new refuses a folder that exists (work.Exists), so the create never reaches the reset.
          expect(yield* failureWords(rifts.create({ source: made.base, from: made.base, name: "taken", branch: "taken" }))).toContain("Exists")
          expect(yield* out(made, taken, "git", "status", "--porcelain")).toBe(before)
          expect(yield* out(made, taken, "cat", "README.md")).toBe("work in a folder no create made")
        }),
      ),
    TIMEOUT,
  )

  test(
    "remove trashes the workspace into .work-trash and a retry answers; withChildren takes the children; a branch only origin holds is no bar; one removed elsewhere since its inspect answers as gone; a commit made after the inspect is in the trash",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const gone = yield* rifts.create({ source: made.base, from: made.base, name: "gone", branch: "gone" })
          yield* rifts.inspect(gone)
          yield* rifts.remove(gone)
          expect(yield* rifts.list(made.base)).toEqual([])
          expect(yield* out(made, made.root, "ls", `${made.root}/code/.work/app/.work-trash`)).toStartWith("gone.")
          yield* rifts.remove(gone)

          const parent = yield* rifts.create({ source: made.base, from: made.base, name: "parent", branch: "parent" })
          const child = yield* rifts.create({ source: parent, from: parent, name: "child", branch: "child" })
          expect(yield* Effect.flip(rifts.remove(parent))).toBeInstanceOf(RiftFailed)
          expect((yield* rifts.inspect(parent)).children).toEqual([child])
          yield* rifts.remove(parent, { withChildren: true })
          expect(yield* rifts.list(made.base)).toEqual([])

          const pushed = yield* rifts.create({ source: made.base, from: made.base, name: "pushed", branch: "pushed" })
          yield* made.sh(pushed, "git", "commit", "-q", "--allow-empty", "-m", "on origin only")
          yield* made.sh(pushed, "git", "push", "-q", made.origin, "HEAD:refs/heads/pushed")
          yield* made.sh(pushed, "git", "fetch", "-q", "origin")
          expect((yield* rifts.inspect(pushed)).unpushed).toEqual([])
          // The tool's rule has judged it, so the provider abandons; work's own check (4c2b2571 on) holds it too.
          yield* rifts.remove(pushed)
          expect(yield* rifts.list(made.base)).toEqual([])

          // Removed by someone else since its inspect: the removal names the id it saw, and answers that it is gone.
          const elsewhere = yield* rifts.create({ source: made.base, from: made.base, name: "elsewhere", branch: "elsewhere" })
          const kept = yield* rifts.create({ source: made.base, from: made.base, name: "kept", branch: "kept" })
          yield* rifts.inspect(elsewhere)
          yield* made.work("rm", "-abandon", "elsewhere").pipe(Effect.orDie)
          yield* rifts.remove(elsewhere)
          expect(yield* rifts.list(made.base)).toEqual([kept])
          // work (4c2b2571 on) gives a trashed name out again: the new workspace has an id of its own, which a removal
          // that names the old id (`-expect`) never reaches.
          expect(yield* made.workRan("new", "elsewhere")).toMatchObject({ code: 0 })
          yield* rifts.remove(kept)

          const late = yield* rifts.create({ source: made.base, from: made.base, name: "late", branch: "late" })
          expect((yield* rifts.inspect(late)).unpushed).toEqual([])
          yield* made.sh(late, "git", "commit", "-q", "--allow-empty", "-m", "after the inspect")
          yield* rifts.remove(late)
          const trashed = (yield* out(made, made.root, "ls", `${made.root}/code/.work/app/.work-trash`)).split("\n").filter((entry) => entry.startsWith("late."))
          expect(yield* out(made, `${made.root}/code/.work/app/.work-trash/${trashed[0] ?? ""}`, "git", "log", "-1", "--format=%s")).toBe("after the inspect")
        }),
      ),
    TIMEOUT,
  )

  test(
    "inspect: a commit a land put on origin's main from elsewhere, or a clean merge of pushed parents, is not unpushed; a commit behind such a merge is",
    () => check(plain, (made) => savedWorkCase({ source: made.base, origin: made.origin, scratch: made.root, git: (cwd, ...args) => made.sh(cwd, "git", ...args) })),
    TIMEOUT,
  )

  test(
    "a land pushes from workspaces work made, whose push URL refuses every push: push moves origin's main, pushBranch origin's branch",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const landing = Context.get(yield* Effect.scoped(Layer.build(ProcessLanding.layer({ logs: `${made.root}/logs`, env: made.env }))), Landing)
          const integration = yield* rifts.create({ source: made.base, from: made.base, name: "integrate", branch: "integrate" })
          const unit = yield* rifts.create({ source: made.base, from: made.base, name: "unit", branch: "feat/unit" })
          for (const path of [integration, unit]) expect(yield* out(made, path, "git", "remote", "get-url", "--push", "origin")).toBe("no-push:workspaces-never-push-origin")
          yield* made.write(`${unit}/unit.txt`, "unit\n")
          yield* made.sh(unit, "git", "add", "unit.txt")
          yield* made.sh(unit, "git", "commit", "-q", "-m", "add unit")
          expect(yield* landing.pushBranch({ path: unit, branch: "feat/unit" })).toEndWith(" add unit")
          expect(yield* out(made, made.origin, "git", "rev-parse", "feat/unit")).toBe(yield* out(made, unit, "git", "rev-parse", "HEAD"))
          const settings = yield* landing.config(made.base)
          yield* landing.start(integration, "main")
          yield* landing.merge(integration, { path: unit, branch: "feat/unit" }, settings)
          expect(yield* landing.push(integration, "main")).toEndWith(" add unit")
          expect(yield* out(made, made.origin, "git", "rev-parse", "main")).toBe(yield* out(made, integration, "git", "rev-parse", "HEAD"))
        }),
      ),
    TIMEOUT,
  )

  test(
    "work.toml is no unsaved work where the base's .git/info/exclude names it",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const path = yield* rifts.create({ source: made.base, from: made.base, name: "excluded", branch: "excluded" })
          expect((yield* rifts.inspect(path)).uncommitted).toEqual([])
        }),
      ),
    TIMEOUT,
  )

  test(
    "work.toml is no untracked file of a workspace, even where the base's .git/info/exclude does not name it: work (4c2b2571 on) hides it",
    () =>
      check(bench({ ...PLAIN, exclude: false }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const path = yield* rifts.create({ source: made.base, from: made.base, name: "seen", branch: "seen" })
          expect((yield* rifts.inspect(path)).uncommitted).toEqual([])
        }),
      ),
    TIMEOUT,
  )

  test(
    "a new workspace of a base with several packs and a multi-pack index reads every object",
    () =>
      check(plain, (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          for (const n of [1, 2, 3, 4]) {
            yield* made.write(`${made.base}/file-${n}.txt`, `${n}\n`)
            yield* made.sh(made.base, "git", "add", `file-${n}.txt`)
            yield* made.sh(made.base, "git", "commit", "-q", "-m", `commit ${n}`)
            yield* made.sh(made.base, "git", "repack", "-q")
          }
          yield* made.sh(made.base, "git", "multi-pack-index", "write", "--no-progress")
          const packs = (yield* out(made, made.base, "ls", ".git/objects/pack")).split("\n").filter((file) => file.endsWith(".pack"))
          expect(packs.length).toBeGreaterThan(3)
          const path = yield* rifts.create({ source: made.base, from: made.base, name: "packed", branch: "packed" })
          yield* made.sh(path, "git", "multi-pack-index", "verify", "--no-progress")
          yield* made.sh(path, "git", "fsck", "--connectivity-only", "--no-progress")
          expect((yield* out(made, path, "git", "log", "--format=%s")).split("\n")).toEqual(["commit 4", "commit 3", "commit 2", "commit 1", "init"])
        }),
      ),
    TIMEOUT,
  )

  test(
    "list answers while a clone is in progress, and shows that workspace once it is made",
    () =>
      check(bench({ ...PLAIN, stubs: [["cp", SLOW_CP]] }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const making = yield* Effect.forkChild(rifts.create({ source: made.base, from: made.base, name: "slow", branch: "slow" }))
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          expect(yield* rifts.list(made.base)).toEqual([])
          yield* made.sh(made.root, "touch", `${made.env.HOME}/clone.go`)
          const path = yield* Fiber.join(making)
          expect(yield* rifts.list(made.base)).toEqual([path])
        }),
      ),
    TIMEOUT,
  )

  test(
    "a create interrupted mid-clone leaves its work new to finish (the record ends active, not creating), and the next create of that name waits for it and answers it",
    () =>
      check(bench({ ...PLAIN, stubs: [["cp", SLOW_CP]] }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const request = { source: made.base, from: made.base, name: "cut", branch: "cut" }
          const making = yield* Effect.forkChild(rifts.create(request))
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          // The plugin's scope closing under the call, as a reload does.
          yield* Fiber.interrupt(making)
          const again = yield* Effect.forkChild(rifts.create(request))
          yield* made.sh(made.root, "touch", `${made.env.HOME}/clone.go`)
          const path = yield* Fiber.join(again)
          expect(nameOf(path)).toBe("cut")
          const records = yield* made.work("list").pipe(Effect.flatMap(Schema.decodeUnknownEffect(RECORDS)), Effect.orDie)
          expect(records.map((record) => [record.name, record.state._tag])).toEqual([["cut", "Active"]])
          expect((yield* rifts.inspect(path)).branch).toBe("cut")
          expect(yield* rifts.list(made.base)).toEqual([path])
        }),
      ),
    TIMEOUT,
  )

  test(
    "a create that adopts a workspace an interrupted create left (madeMeanwhile) resets nothing: the copies of the base's edits stay",
    () =>
      check(bench({ ...PLAIN, stubs: [["cp", SLOW_CP]] }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          yield* made.write(`${made.base}/README.md`, "the base's edit\n")
          yield* made.write(`${made.base}/src/index.ts`, "export const staged = 1\n")
          yield* made.sh(made.base, "git", "add", "src/index.ts")
          const before = lines(yield* made.sh(made.base, "git", "status", "--porcelain"))
          expect(before).toEqual([" M README.md", "M  src/index.ts"])
          const request = { source: made.base, from: made.base, name: "cut", branch: "cut" }
          const making = yield* Effect.forkChild(rifts.create(request))
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          yield* Fiber.interrupt(making)
          const again = yield* Effect.forkChild(rifts.create(request))
          yield* made.sh(made.root, "touch", `${made.env.HOME}/clone.go`)
          const path = yield* Fiber.join(again)
          expect(lines(yield* made.sh(path, "git", "status", "--porcelain"))).toEqual(before)
          expect((yield* rifts.inspect(path)).uncommitted).toEqual(before)
        }),
      ),
    TIMEOUT,
  )

  test(
    "a create of a name whose work new was killed mid-clone (a reboot, a crash) fails at once naming `work rm <name>`, and keeps the folder; once it is removed, the name is made",
    () =>
      check(bench({ ...PLAIN, stubs: [["cp", SLOW_CP]], makingWaitMs: 50_000 }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          // A `work new` this test starts and holds the pid of, as the maker a reboot would end.
          const pid = yield* out(made, made.base, "sh", "-c", `WORK_BASE="$1" "$0" --json new -branch dead dead >/dev/null 2>&1 & echo $!`, WORK_BIN, made.base)
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          yield* made.sh(made.root, "kill", "-9", pid)
          // Its cp goes on to its end; the record stays creating, its lock free.
          yield* made.sh(made.root, "touch", `${made.env.HOME}/clone.go`)
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.done`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          const request = { source: made.base, from: made.base, name: "dead", branch: "dead" }
          const [took, said] = yield* Effect.timed(failureWords(rifts.create(request)))
          expect(Duration.toMillis(took)).toBeLessThan(20_000)
          expect(said).toContain("was left being made by a `work new` that is gone")
          expect(said).toContain("`work rm dead`")
          const records = yield* made.work("list").pipe(Effect.flatMap(Schema.decodeUnknownEffect(RECORDS)), Effect.orDie)
          expect(records.map((record) => [record.name, record.state._tag])).toEqual([["dead", "Creating"]])
          yield* made.work("rm", "dead").pipe(Effect.orDie)
          expect(nameOf(yield* rifts.create(request))).toBe("dead")
        }),
      ),
    TIMEOUT,
  )

  test(
    "a create whose maker probe runs just after the work new it waits on finished (its lock file gone) answers the made workspace, not a dead maker",
    () =>
      check(bench({ ...PLAIN, stubs: [["cp", SLOW_CP], ["perl", HELD_PERL]], makingWaitMs: 50_000 }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const request = { source: made.base, from: made.base, name: "race", branch: "race" }
          const making = yield* Effect.forkChild(failureWords(rifts.create(request)))
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          // The second create has read the record as creating and is about to probe its maker's lock.
          const waiting = yield* Effect.forkChild(rifts.create(request))
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/probe.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          // The maker finishes meanwhile, removing its lock file; then the probe runs.
          yield* made.sh(made.root, "touch", `${made.env.HOME}/clone.go`)
          expect(yield* Fiber.join(making)).toBe("made")
          yield* made.sh(made.root, "touch", `${made.env.HOME}/probe.go`)
          const answered = yield* Fiber.join(waiting)
          expect(nameOf(answered)).toBe("race")
          const records = yield* made.work("list").pipe(Effect.flatMap(Schema.decodeUnknownEffect(RECORDS)), Effect.orDie)
          expect(records.map((record) => [record.name, record.state._tag])).toEqual([["race", "Active"]])
        }),
      ),
    TIMEOUT,
  )

  test(
    "a create waiting on a live work new that outlasts the wait fails naming `work rm <name>`, and the work new still makes it",
    () =>
      check(bench({ ...PLAIN, stubs: [["cp", SLOW_CP]], makingWaitMs: 2_000 }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const request = { source: made.base, from: made.base, name: "slow", branch: "slow" }
          const making = yield* Effect.forkChild(failureWords(rifts.create(request)))
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          const waited = yield* failureWords(rifts.create(request))
          expect(waited).toContain("is still being made after 2 s")
          expect(waited).toContain("`work rm slow`")
          yield* made.sh(made.root, "touch", `${made.env.HOME}/clone.go`)
          expect(yield* Fiber.join(making)).toBe("made")
        }),
      ),
    TIMEOUT,
  )

  test(
    "a create waiting on a work new that fails says the name was given up, and the next create makes it",
    () =>
      check(bench({ ...PLAIN, stubs: [["cp", FAILING_CP]], makingWaitMs: 50_000 }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          const request = { source: made.base, from: made.base, name: "slow", branch: "slow" }
          const making = yield* Effect.forkChild(failureWords(rifts.create(request)))
          yield* made.sh(made.root, "test", "-e", `${made.env.HOME}/clone.started`).pipe(Effect.sandbox, Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }))
          // This create waits while the clone fails (FAILING_CP, 3 s after it started): its work new gives the name up.
          expect(yield* failureWords(rifts.create(request))).toContain("was given up while this create waited for it")
          expect(yield* Fiber.join(making)).not.toBe("made")
          yield* made.sh(made.root, "rm", "-f", `${made.root}/bin/cp`)
          expect(nameOf(yield* rifts.create(request))).toBe("slow")
        }),
      ),
    TIMEOUT,
  )

  test(
    "with workrift: true create and remove go through workrift, named the source, and the create resets nothing; source, list and inspect ask work",
    () =>
      check(bench({ ...PLAIN, workrift: true, stubs: [["workrift", LOGGING_WORKRIFT]] }), (made) =>
        Effect.gen(function* () {
          const rifts = yield* Rifts
          yield* made.write(`${made.base}/README.md`, "the base's edit\n")
          const created = yield* made.work("new", "-branch", "feat/x", "feat-x").pipe(Effect.flatMap(Schema.decodeUnknownEffect(CREATED)), Effect.orDie)
          yield* made.write(`${made.env.HOME}/workrift.answer`, `${created.path}\n`)
          expect(yield* rifts.create({ source: made.base, from: made.inside, name: "feat-x", branch: "feat/x" })).toBe(created.path)
          expect(yield* out(made, created.path, "git", "status", "--porcelain")).toBe("M README.md")
          expect(yield* rifts.source(created.path)).toBe(made.base)
          expect(yield* rifts.list(made.base)).toEqual([created.path])
          expect((yield* rifts.inspect(created.path)).branch).toBe("feat/x")
          yield* rifts.remove(created.path, { withChildren: true })
          expect((yield* out(made, made.root, "cat", `${made.env.HOME}/workrift.log`)).split("\n")).toEqual([
            `create feat/x source=${made.base}`,
            `remove --with-children ${created.path} source=`,
          ])
        }),
      ),
    TIMEOUT,
  )
})
