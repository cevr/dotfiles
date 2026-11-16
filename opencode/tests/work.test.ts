// accept: deep (8.2 s alone on a quiet host: 1-minute load 7.8 on 12 cores; it boots real OpenCode three times on the real work binary)
// The work tool in real OpenCode (the fork, through its SDK) on the scripted model and the real `work` binary
// (WORK_BIN, else `work` on PATH), in a scratch HOME: tests/work/run.ts, once per task. The model makes a workspace for a branch
// with `work` (under `.work/<base>/`), commits in it, lists it, is refused removing it while the commit is found
// nowhere else, and removes it with force; neither request offers OpenCode's worktree tools. In a second run it
// commits in a workspace and lands it: one push to the bare origin's main from an integration workspace work
// made, the workspace trashed, and the accept check's wake after the turn. A third run lists through the alias
// `rift`. The plugin on its own is tested beside its code in cmd/work. Without a work binary (WORK_BIN, or
// `work` on PATH as the install puts it) and OPENCODE_DEV these do not run.
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, test } from "bun:test"
import { Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect"
import { expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { withProcessEnv } from "./git-repo.ts"
import { ALIAS, BRANCH, COMMIT_SUBJECT, DONE, FLOW, LAND, LAND_SUBJECT, Result } from "./work/sim.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()
const PROCESS = withProcessEnv({})
const WORK_BIN = PROCESS["WORK_BIN"] || Bun.which("work") || ""
const FORK = PROCESS["OPENCODE_DEV"] ?? ""
const runnable = WORK_BIN !== "" && FORK !== ""
/** How long one real run may take before it is stopped. */
const LIMIT = "2 minutes"
const RUN_MS = 150_000

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** One run of real OpenCode in a scratch home on `task`, waiting for `wake` after the turn; a failed run fails with its output. */
const boot = (task: string, wake: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "work-e2e-" })
    const home = path.join(base, "home")
    const temp = path.join(base, "tmp")
    yield* fs.makeDirectory(home)
    yield* fs.makeDirectory(temp)
    const command = ChildProcess.make(process.execPath, [path.join(ROOT, "tests/work/run.ts")], {
      cwd: ROOT,
      env: {
        PATH: PROCESS["PATH"] ?? "",
        HOME: home,
        TMPDIR: temp,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        WORK_E2E_BASE: base,
        WORK_E2E_FORK: path.resolve(FORK),
        WORK_E2E_PLUGIN: path.join(ROOT, "cmd/work"),
        WORK_E2E_BIN: path.resolve(WORK_BIN),
        WORK_E2E_TASK: task,
        ...Option.match(wake, { onNone: () => ({}), onSome: (said) => ({ WORK_E2E_WAKE: said }) }),
      },
      extendEnv: false,
      stdin: "ignore",
      forceKillAfter: "3 seconds",
    })
    // The child runs in a process group of its own; the scope's end stops the group.
    const child = yield* spawner.spawn(command)
    const output = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 }).pipe(Effect.forkScoped)
    const code = yield* child.exitCode.pipe(Effect.timeoutOption(LIMIT))
    const result = path.join(base, "result.json")
    if (Option.isSome(code) && code.value === 0 && (yield* fs.exists(result)))
      return yield* fs.readFileString(result).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Result))))
    const said = Option.getOrElse(yield* Fiber.join(output).pipe(Effect.timeoutOption("5 seconds")), () => ["", ""])
    return yield* Effect.die(`the ${task} run failed (exit ${Option.getOrElse(code, () => "none: it ran past its time")}):\n${said.join("\n")}`)
  }).pipe(Effect.scoped)

if (runnable)
  describe("the work tool in real OpenCode, on the scripted model and the real work binary", () => {
    it.live.layer(BunServices.layer)(
      "an agent makes, lists and removes a workspace under .work/<base>/ through the work tool, and has no worktree tools",
      () =>
        Effect.gen(function* () {
          const result = yield* boot(FLOW, Option.none())
          expect(result.workspace).toContain("/.work/work/")
          const offered = result.seen.filter((item) => item.task.endsWith(FLOW))
          expect(offered.length).toBeGreaterThan(0)
          for (const request of offered) {
            expect(request.tools).toContain("work")
            expect(request.tools).toContain("rift")
            // session_move, offered beside them, is still in the request: they are gone, not merely unlisted.
            expect(request.named).toEqual(["session_move"])
          }
          const [create, commit, list, refused, forced, ...rest] = result.calls
          expect(rest).toEqual([])
          expect([create?.name, create?.status]).toEqual(["work", "completed"])
          expect(create?.said).toContain(`Created the workspace ${result.workspace} from ${result.source}, on branch ${BRANCH}.`)
          expect(create?.said).toContain(`session_move tool (directory: "${result.workspace}")`)
          expect(commit?.status).toBe("completed")
          expect(list?.said).toContain(`Workspaces of ${result.source}:`)
          expect(list?.said).toContain(`- ${result.workspace} · branch ${BRANCH} · 1 unpushed`)
          expect(refused?.status).toBe("error")
          expect(refused?.said).toContain(`${result.workspace} holds work found nowhere else:`)
          expect(refused?.said).toContain(COMMIT_SUBJECT)
          expect(forced?.status).toBe("completed")
          expect(forced?.said).toContain(`Moved the workspace ${result.workspace} (branch ${BRANCH}) to the trash; it held 1 unpushed.`)
          expect(result.workspaceThere).toBe(false)
          expect(result.transcript).toContain(DONE)
        }),
      RUN_MS,
    )

    it.live.layer(BunServices.layer)(
      "an agent lands a workspace: one push to main from the integration workspace work made, the workspace trashed, then the accept check's wake",
      () =>
        Effect.gen(function* () {
          const result = yield* boot(LAND, Option.some("rift land: the accept check for"))
          const [create, commit, land, ...rest] = result.calls
          expect(rest).toEqual([])
          expect([create?.status, commit?.status, land?.status]).toEqual(["completed", "completed", "completed"])
          expect(result.integration).toContain("/.work/work/")
          expect(land?.said).toContain("Landed 1 workspace(s) as one push: ")
          expect(land?.said).toContain(`${LAND_SUBJECT} to main (merged ${BRANCH}; the gate passed in `)
          expect(land?.said).toContain(`To the trash: ${result.workspace}.`)
          expect(land?.said).toContain(`The accept check runs in the background in ${result.integration} on the batch since `)
          // The branch's commit is origin's main; the workspace went, the integration workspace stays for the next batch.
          expect(result.originMain).toBe(LAND_SUBJECT)
          expect([result.workspaceThere, result.integrationThere]).toEqual([false, true])
          expect(result.transcript).toMatch(/rift land: the accept check for feat\/x passed in \d+s\./)
          expect(result.transcript).toContain(DONE)
        }),
      RUN_MS,
    )

    it.live.layer(BunServices.layer)(
      "an agent lists through the alias rift and gets the work tool's list",
      () =>
        Effect.gen(function* () {
          const result = yield* boot(ALIAS, Option.none())
          const [list, ...rest] = result.calls
          expect(rest).toEqual([])
          expect([list?.name, list?.status]).toEqual(["rift", "completed"])
          expect(list?.said).toBe(`The base ${result.source} has no workspaces.`)
          expect(result.transcript).toContain(DONE)
        }),
      RUN_MS,
    )
  })
else test.skip("the work tool in real OpenCode needs a work binary (WORK_BIN, or work on PATH) and OPENCODE_DEV, the fork", () => {})
