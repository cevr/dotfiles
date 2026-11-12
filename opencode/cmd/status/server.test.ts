// The plugin seam: the composition root on a stand-in host. On memory layers it
// checks the status RPC's answer and its errors; on the live adapters it
// checks how they read a real call log file and real runs in a git
// repository through a status script. tests/status.test.ts runs it, with the
// TUI, in OpenCode.
import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { AgentCalled, AgentReturned } from "@dotfiles/opencode-status/agent-calls"
import * as CallLog from "@dotfiles/opencode-status/memory/call-log"
import * as RunTables from "@dotfiles/opencode-status/memory/run-tables"
import { Snapshot, STATUS } from "@dotfiles/opencode-status/status"
import Status, { live, make, Options } from "./server.ts"

type Host = Parameters<(typeof Status)["effect"]>[0]
type Handler = (input: unknown) => Effect.Effect<unknown>

const REPO = "/repo"

/** What the memory layers hold: the call log's events and the runs by directory, and a failure for either. */
interface World {
  readonly log: CallLog.MemoryLog
  readonly runs: RunTables.MemoryRuns
}

const world = (): World => ({ log: { events: [] }, runs: { tables: new Map() } })

/** The outside systems as memory layers over `state`. */
const testLayers = (state: World) => () => Layer.merge(CallLog.layer(state.log), RunTables.layer(state.runs))

const line = (row: Record<string, unknown>) => `${JSON.stringify(row)}\n`

/**
 * The plugin started on a stand-in host in `directory`, and its status RPC.
 * `externals` picks the adapters: the memory layers over `state` by default.
 */
const start = (
  options: Record<string, unknown> = {},
  state: World = world(),
  externals: Parameters<typeof make>[0] | "test" = "test",
  directory = REPO,
) =>
  Effect.gen(function* () {
    const rpc: Record<string, Record<string, Handler>> = {}
    const host = {
      options,
      location: { directory },
      rpc: {
        register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
          Effect.sync(() => {
            rpc[definition.id] = handlers
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make(externals === "test" ? testLayers(state) : externals).effect(host)
    const handlers = rpc[STATUS.id]
    const method = handlers?.status
    if (method === undefined) return yield* Effect.die(new Error(`not registered: ${STATUS.id}`))
    return { status: method({}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)), Effect.orDie) }
  })

const scenario = <A, E>(body: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("the options", () => {
  test("take their defaults when absent or undefined", () => {
    const decode = Schema.decodeUnknownSync(Options)
    const defaults = {
      log: join(homedir(), ".cache/orchestrate/opencode-agents.jsonl"),
      statusScript: join(homedir(), ".claude/skills/orchestrate/scripts/status.ts"),
    }
    expect(decode({})).toEqual(defaults)
    expect(decode({ log: undefined, statusScript: undefined })).toEqual(defaults)
    expect(decode({ log: "/x.jsonl", statusScript: "/s.ts" })).toEqual({ log: "/x.jsonl", statusScript: "/s.ts" })
  })

  test("a malformed option stops the plugin and says which", async () => {
    for (const [options, path] of [
      [{ log: 7 }, '["log"]'],
      [{ statusScript: false }, '["statusScript"]'],
    ] as const) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start(options))))
      expect(exit._tag).toBe("Failure")
      const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined
      expect(reason?._tag).toBe("Die")
      const message = reason?._tag === "Die" && reason.defect instanceof Error ? reason.defect.message : ""
      expect(message).toStartWith("dotfiles-opencode.status: invalid options: ")
      expect(message).toContain(`at ${path}`)
    }
  })
})

describe("the status RPC", () => {
  test("answers the live calls and the runs of the plugin's directory", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.log.events.push(
          AgentCalled.make({ sessionID: "ses_1", callID: "a", agent: "worker", description: "implementor pane r1" }),
          AgentReturned.make({ sessionID: "ses_1", callID: "a", child: "ses_a", status: "running" }),
          AgentCalled.make({ sessionID: "ses_1", callID: "b", agent: "worker" }),
          // The run port's steps: an older one from ses_old, the latest (returned, in the suffix form) from ses_orch, which owns the run.
          AgentCalled.make({ sessionID: "ses_old", callID: "c", agent: "planner", description: "planner wake r1" }),
          AgentCalled.make({ sessionID: "ses_orch", callID: "d", agent: "verifier", description: "wake r1 verifier (Opus)" }),
          AgentReturned.make({ sessionID: "ses_orch", callID: "d", status: "completed" }),
          AgentReturned.make({ sessionID: "ses_old", callID: "c", status: "completed" }),
          AgentReturned.make({ sessionID: "ses_1", callID: "b", status: "completed" }),
        )
        state.runs.tables.set(REPO, [
          { name: "port", table: "| Unit | State | Round | Since |\n| --- | --- | --- | --- |\n| wake | implement | 1 | 2026-11-04T15:00Z |\n" },
          { name: "empty", table: "| Unit | State | Round | Since |\n" },
        ])
        state.runs.tables.set("/elsewhere", [{ name: "other", table: "| x | y | 1 | z |" }])
        const plugin = yield* start({}, state)
        expect(yield* plugin.status).toEqual({
          agents: [{ sessionID: "ses_1", callID: "a", agent: "worker", description: "implementor pane r1", child: "ses_a", status: "running" }],
          runs: [
            { name: "port", session: "ses_orch", units: [{ unit: "wake", state: "implement", round: "1", since: "2026-11-04T15:00Z" }] },
            { name: "empty", units: [] },
          ],
          errors: [],
        })
      }),
    ))

  test("reads afresh on every call", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start({}, state)
        expect(yield* plugin.status).toEqual({ agents: [], runs: [], errors: [] })
        state.log.events.push(AgentCalled.make({ sessionID: "ses_1", callID: "a", agent: "worker" }))
        expect((yield* plugin.status).agents).toEqual([{ sessionID: "ses_1", callID: "a", agent: "worker" }])
      }),
    ))

  test("a half that cannot be read is empty, and the errors say why", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.log.events.push(AgentCalled.make({ sessionID: "ses_1", callID: "a", agent: "worker" }))
        state.runs.tables.set(REPO, [{ name: "port", table: "| wake | plan | 1 | t |" }])
        const plugin = yield* start({}, state)
        state.log.failure = "EACCES: permission denied"
        expect(yield* plugin.status).toEqual({
          agents: [],
          runs: [{ name: "port", units: [{ unit: "wake", state: "plan", round: "1", since: "t" }] }],
          errors: ["Agents: EACCES: permission denied"],
        })
        state.log.failure = undefined
        state.runs.failure = "bun failed: no such run"
        expect(yield* plugin.status).toEqual({
          agents: [{ sessionID: "ses_1", callID: "a", agent: "worker" }],
          runs: [],
          errors: ["Runs: bun failed: no such run"],
        })
        state.log.failure = "EISDIR"
        expect((yield* plugin.status).errors).toEqual(["Agents: EISDIR", "Runs: bun failed: no such run"])
      }),
    ))
})

/** A scratch directory for one live test, removed after it. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "status-plugin-")))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.promise(() => Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited).pipe(
    Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.die(new Error(`git ${args.join(" ")} failed`)))),
  )

/** A git repository at `dir` with one commit. */
const repository = (dir: string) =>
  Effect.gen(function* () {
    yield* git(dir, "init", "-q")
    writeFileSync(join(dir, "README"), "x")
    yield* git(dir, "add", "README")
    yield* git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  })

/**
 * A stand-in for the orchestrate skill's status script: a table with one row
 * per unit directory, its state from the unit's `state` file. A run holding
 * `broken` fails with a message on stderr.
 */
const STATUS_SCRIPT = `
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.argv[2]
if (existsSync(join(dir, "broken"))) { console.error("cannot read " + dir); process.exit(1) }
console.log("| Unit | State | Round | Since |")
console.log("| --- | --- | --- | --- |")
for (const unit of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
  console.log("| " + unit + " | " + readFileSync(join(dir, unit, "state"), "utf8").trim() + " | 1 | 2026-11-04T15:00Z |")
`

describe("the live adapters", () => {
  test("read the call log file: no file yet, whole lines, and a partial last line", () =>
    scenario(
      Effect.gen(function* () {
        const dir = yield* scratch
        const log = join(dir, "agents.jsonl")
        const plugin = yield* start({ log, statusScript: join(dir, "status.ts") }, world(), live, dir)
        expect(yield* plugin.status).toEqual({ agents: [], runs: [], errors: [] })
        writeFileSync(
          log,
          [
            line({ kind: "call", sessionID: "ses_1", callID: "a", agent: "worker", description: 7, child: "ses_a" }),
            "not json\n",
            line({ kind: "call", sessionID: "ses_1", callID: "b" }),
            line({ kind: "call", callID: "c", agent: "worker" }),
            line({ kind: "tool", sessionID: "ses_1", callID: "a" }),
            "null\n",
          ].join(""),
        )
        appendFileSync(log, '{"kind":"done","sessionID":"ses_1","callID":"a","status":"compl')
        expect((yield* plugin.status).agents).toEqual([{ sessionID: "ses_1", callID: "a", agent: "worker", child: "ses_a" }])
        appendFileSync(log, 'eted"}\n')
        expect((yield* plugin.status).agents).toEqual([])
      }),
    ))

  test("a call log that cannot be read is an error, not a crash", () =>
    scenario(
      Effect.gen(function* () {
        const dir = yield* scratch
        const plugin = yield* start({ log: dir, statusScript: join(dir, "status.ts") }, world(), live, dir)
        const answer = yield* plugin.status
        expect(answer.agents).toEqual([])
        expect(answer.errors).toHaveLength(1)
        expect(answer.errors[0]).toStartWith("Agents: EISDIR")
      }),
    ))

  test("outside a repository, or with no runs directory, there are no runs", () =>
    scenario(
      Effect.gen(function* () {
        const dir = yield* scratch
        const options = { log: join(dir, "agents.jsonl"), statusScript: join(dir, "status.ts") }
        expect(yield* (yield* start(options, world(), live, dir)).status).toEqual({ agents: [], runs: [], errors: [] })
        yield* repository(dir)
        expect(yield* (yield* start(options, world(), live, dir)).status).toEqual({ agents: [], runs: [], errors: [] })
      }),
    ))

  test("read each run through the status script, from a worktree too", () =>
    scenario(
      Effect.gen(function* () {
        const dir = yield* scratch
        const repo = join(dir, "repo")
        mkdirSync(repo)
        yield* repository(repo)
        const script = join(dir, "status.ts")
        writeFileSync(script, STATUS_SCRIPT)
        for (const [run, unit, state] of [
          ["port", "wake", "implement"],
          ["port", "closed", "merged abcdef1"],
          ["fresh", "plan", "plan"],
        ] as const) {
          mkdirSync(join(repo, "tmp/orchestrate", run, unit), { recursive: true })
          writeFileSync(join(repo, "tmp/orchestrate", run, unit, "state"), state)
        }
        writeFileSync(join(repo, "tmp/orchestrate/notes.md"), "not a run")
        const tree = join(dir, "tree")
        yield* git(repo, "worktree", "add", "-q", tree)
        const options = { log: join(dir, "agents.jsonl"), statusScript: script }
        // Each run also carries its directory, checked on its own below.
        const byName = (runs: Snapshot["runs"]) =>
          [...runs].sort((left, right) => left.name.localeCompare(right.name)).map(({ dir: _dir, ...run }) => run)
        const expected = [
          { name: "fresh", units: [{ unit: "plan", state: "plan", round: "1", since: "2026-11-04T15:00Z" }] },
          {
            name: "port",
            units: [
              { unit: "closed", state: "merged abcdef1", round: "1", since: "2026-11-04T15:00Z" },
              { unit: "wake", state: "implement", round: "1", since: "2026-11-04T15:00Z" },
            ],
          },
        ]
        const fromRepo = yield* (yield* start(options, world(), live, repo)).status
        expect(byName(fromRepo.runs)).toEqual(expected)
        expect(fromRepo.runs.map((run) => run.dir).sort()).toEqual(["fresh", "port"].map((run) => join(repo, "tmp/orchestrate", run)))
        expect(fromRepo.errors).toEqual([])
        expect(byName((yield* (yield* start(options, world(), live, tree)).status).runs)).toEqual(expected)

        writeFileSync(join(repo, "tmp/orchestrate/fresh/broken"), "")
        const broken = yield* (yield* start(options, world(), live, repo)).status
        expect(broken.runs).toEqual([])
        expect(broken.errors).toEqual([`Runs: ${process.execPath} failed: cannot read ${join(repo, "tmp/orchestrate/fresh")}`])
      }),
    ))
})
