// The process Rifts over Ergo's real `work` binary (WORK_BIN) and Git, in a scratch HOME (so the list of
// bases is the test's own) holding a base `code/app` with a bare origin. The provider's environment
// carries a WORK_BASE that names no base, so a call that does not name its own base reads the wrong
// registry and fails. Without WORK_BIN these do not run: `work` is not on this host's PATH yet.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer, Option, Schedule, Schema } from "effect"
import { gitClone, gitInit, withProcessEnv } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import { check, riftsLaws } from "../laws.ts"
import * as MemoryRifts from "../memory/rifts.ts"
import { Landing, RiftFailed, Rifts } from "../service.ts"
import type { Workspace } from "../workspace.ts"
import { commands } from "./command.ts"
import * as ProcessLanding from "./landing.ts"
import * as ProcessWork from "./work.ts"

const PROCESS = withProcessEnv({})
const WORK_BIN = PROCESS["WORK_BIN"] ?? ""
const runnable = WORK_BIN !== ""
const TIMEOUT = 60_000

/** What the tests read of `work --json list` and `work --json new`. */
const RECORDS = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.Struct({ _tag: Schema.String }) })))
const CREATED = Schema.fromJsonString(Schema.Struct({ path: Schema.String }))

/** What a bench is made with: whether the base's `.git/info/exclude` names work.toml, workrift's use, and stub commands put first on PATH. */
interface Setup {
  readonly exclude: boolean
  readonly workrift: boolean
  readonly stubs: ReadonlyArray<readonly [string, string]>
}

const PLAIN: Setup = { exclude: true, workrift: false, stubs: [] }

/** Writes `text` to `path`, its folder made first. */
const writer = (run: ReturnType<typeof commands>["run"]) => (path: string, text: string) =>
  run(["sh", "-c", 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', "write", text, path], "/").pipe(Effect.orDie, Effect.asVoid)

const setup = Effect.fn("work.bench")(function* (dir: string, made: Setup) {
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
    layer: ProcessWork.layer({ work: WORK_BIN, workrift: made.workrift, env }),
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

/** A `cp` that, for the copy-on-write clone (`cp -c`), says it started and waits for the test's go before it copies. */
const SLOW_CP = `#!/bin/sh
if [ "$1" = "-c" ]; then
  : > "$HOME/clone.started"
  while [ ! -e "$HOME/clone.go" ]; do sleep 0.05; done
fi
exec /bin/cp "$@"
`

/** A `workrift` that logs how it was called and answers the workspace path the test gave it. */
const LOGGING_WORKRIFT = `#!/bin/sh
echo "$* source=$WORKRIFT_SOURCE" >> "$HOME/workrift.log"
if [ "$1" = "create" ]; then cat "$HOME/workrift.answer"; fi
`

test("a failed work call says its tag and JSON (status 1) or that it was a usage error (status 2), never a parse error", () => {
  expect(ProcessWork.failureOf({ code: 1, stdout: '{"_tag":"NameTaken","name":"twice"}\n', stderr: "work: failed; the JSON on standard output says why\n" })).toBe(
    'NameTaken: {"_tag":"NameTaken","name":"twice"}',
  )
  expect(ProcessWork.failureOf({ code: 2, stdout: "", stderr: 'work: unknown command "bogus"\n' })).toBe('usage (exit 2): work: unknown command "bogus"')
  expect(ProcessWork.failureOf({ code: 1, stdout: "not json", stderr: "boom\n" })).toBe("exit 1: boom")
})

test("a path under .work/<name>/ or .rifts/<name>/ tries the base beside it first", () => {
  const bases = ["/a/x", "/b/dotfiles", "/b/opencode"]
  expect(ProcessWork.searchOrder(bases, "/b/.work/dotfiles/feat/src")).toEqual(["/b/dotfiles", "/a/x", "/b/opencode"])
  expect(ProcessWork.searchOrder(bases, "/b/.rifts/opencode/prime-look/.rifts/prime-look/x")).toEqual(["/b/opencode", "/a/x", "/b/dotfiles"])
  expect(ProcessWork.searchOrder(bases, "/c/.work/gone/w")).toEqual(bases)
})

if (runnable) {
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
            // work's own check refuses it (NotHeld): the tool's rule has judged it, so the provider abandons.
            expect(yield* made.workRan("rm", "pushed")).toMatchObject({ code: 1, stdout: expect.stringContaining("NotHeld") })
            yield* rifts.remove(pushed)
            expect(yield* rifts.list(made.base)).toEqual([])

            // Removed by someone else since its inspect: the removal names the id it saw, and answers that it is gone.
            const elsewhere = yield* rifts.create({ source: made.base, from: made.base, name: "elsewhere", branch: "elsewhere" })
            const kept = yield* rifts.create({ source: made.base, from: made.base, name: "kept", branch: "kept" })
            yield* rifts.inspect(elsewhere)
            yield* made.work("rm", "-abandon", "elsewhere").pipe(Effect.orDie)
            yield* rifts.remove(elsewhere)
            expect(yield* rifts.list(made.base)).toEqual([kept])
            // A trashed name is not given out again before a gc, so no workspace can replace one under its name.
            expect(yield* made.workRan("new", "elsewhere")).toMatchObject({ code: 1, stdout: expect.stringContaining("NameTaken") })
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
      "work.toml is one untracked file where the base's .git/info/exclude does not name it: the tool does not hide it",
      () =>
        check(bench({ ...PLAIN, exclude: false }), (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            const path = yield* rifts.create({ source: made.base, from: made.base, name: "seen", branch: "seen" })
            expect((yield* rifts.inspect(path)).uncommitted).toEqual(["?? work.toml"])
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
      "with workrift: true create and remove go through workrift, named the source; source, list and inspect ask work",
      () =>
        check(bench({ ...PLAIN, workrift: true, stubs: [["workrift", LOGGING_WORKRIFT]] }), (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            const created = yield* made.work("new", "-branch", "feat/x", "feat-x").pipe(Effect.flatMap(Schema.decodeUnknownEffect(CREATED)), Effect.orDie)
            yield* made.write(`${made.env.HOME}/workrift.answer`, `${created.path}\n`)
            expect(yield* rifts.create({ source: made.base, from: made.inside, name: "feat-x", branch: "feat/x" })).toBe(created.path)
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
} else test.skip("the process Rifts on work need WORK_BIN, a work binary", () => {})
