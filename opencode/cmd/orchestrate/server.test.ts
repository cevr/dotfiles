// The plugin seam: the composition root on a stand-in host, with every
// outside system a test layer. It checks what OpenCode sees: the rewritten
// subagent input, the refusals' words, a latched call's answer and its
// opening, the call log's lines, the compaction prompt and the agents'
// windows. tests/orchestrate.test.ts and tests/prime-latch.test.ts run it in
// OpenCode.
import { spawnSync } from "bun"
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { RESTART_NOTICE } from "@dotfiles/opencode-orchestrate/restart-hold"
import { type Latch, type LatchAsk, Opened } from "@dotfiles/opencode-wake/latch"
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { KEEP } from "@dotfiles/opencode-orchestrate/compaction"
import * as CallLogTest from "@dotfiles/opencode-orchestrate/memory/call-log"
import * as CodexAdmissionTest from "@dotfiles/opencode-orchestrate/memory/codex-admission"
import * as ModelsTest from "@dotfiles/opencode-orchestrate/memory/models"
import * as PoolPaceTest from "@dotfiles/opencode-orchestrate/memory/pool-pace"
import * as SessionsTest from "@dotfiles/opencode-orchestrate/memory/sessions"
import * as SkillTest from "@dotfiles/opencode-orchestrate/memory/skill"
import { DRIFT_MARK, RECONCILE } from "@dotfiles/opencode-orchestrate/skill-drift"
import * as FileUnitLogs from "@dotfiles/opencode-orchestrate/filestore/unit-logs"
import * as OpenCodeLatches from "@dotfiles/opencode-orchestrate/opencode/latches"
import { type Holds, MARK, NO_HOLDS, type Run } from "@dotfiles/opencode-orchestrate/idle"
import * as StepLogTest from "@dotfiles/opencode-orchestrate/memory/step-log"
import * as FleetTest from "@dotfiles/opencode-orchestrate/memory/fleet"
import { FLEET_DESCRIPTION, FleetOutcome } from "@dotfiles/opencode-orchestrate/fleet"
import { RECHECK_MS } from "@dotfiles/opencode-orchestrate/model"
import * as OpenCodePoolPace from "@dotfiles/opencode-orchestrate/opencode/pool-pace"
import * as OpenCodeRuns from "@dotfiles/opencode-orchestrate/opencode/runs"
import * as OpenCodeSteer from "@dotfiles/opencode-orchestrate/opencode/steer"
import type { Pace } from "@dotfiles/opencode-orchestrate/pace"
import { NO_INFLIGHT, poolPace } from "@dotfiles/opencode-pool/pace"
import type { AccountStatus } from "@dotfiles/opencode-pool/status"
import { definitions } from "@dotfiles/opencode-orchestrate/role"
import { KNOWLTON, rest } from "@dotfiles/opencode-orchestrate/sabbath"
import { Branches, Findings, type FindingsRead, Liveness, type Offered, RootHolds } from "@dotfiles/opencode-orchestrate/service"
import { DEFAULT_CADENCE, RULES } from "@dotfiles/opencode-orchestrate/machine"
import * as MemoryLedger from "@dotfiles/opencode-orchestrate/memory/ledger"
import { eventuallyPasses } from "../../tests/wait.ts"
import Orchestrate, { type Background, CODEX_BUDGET, DEFAULT_LEDGER, DEFAULT_LOG, greenOf, make, Options, SKILL_DIR, type StepHostSession, stepSessionOf, UNIT_LOG } from "./server.ts"

/** The orchestrate skill's log.ts in this checkout: the units' logs are written for real, in scratch dirs. */
const LOG_SCRIPT = join(import.meta.dir, "../../../skills/orchestrate/scripts/log.ts")

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/

type Host = Parameters<(typeof Orchestrate)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void, { readonly _tag: string; readonly message: string }>

/** The outside systems' state for one test. */
interface World {
  readonly sessions?: Readonly<Record<string, SessionsTest.Session>>
  readonly pool?: Readonly<Record<string, Pace>>
  /** The pool's `pace` RPC itself, in place of `pool`'s answers: one that fails, hangs or answers no pace. */
  readonly poolAsk?: OpenCodePoolPace.Ask
  /** The providers the pool is told a new agent started on, in order. */
  readonly started?: Array<string>
  readonly codex?: (model: string, role: string) => Pace | undefined
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly variants?: ReadonlyArray<string>
  /** Other models the host offers, such as the Codex fallback's. */
  readonly others?: ReadonlyArray<Offered>
  /** The wakes' refusal of every latch (no wakes plugin, say); absent, they keep each one. */
  readonly refuse?: string
  /** The latches the wakes kept, in order. */
  readonly kept?: Array<LatchAsk & { readonly child: string }>
  /** The units each session started steps of, as the call log keeps them. */
  readonly steps?: Readonly<Record<string, ReadonlyArray<string>>>
  /** The runs the status plugin answers. */
  readonly runs?: ReadonlyArray<Run>
  /** What the other plugins hold, by session. */
  readonly holds?: Readonly<Record<string, Holds>>
  /** The host refuses every nudge with this. */
  readonly refuseNudge?: string
  /** The orchestrate skill's history; absent, no version can be read. */
  readonly skill?: SkillTest.MemorySkill
  /** Each run dir's seen skill version and departures. */
  readonly records?: SkillTest.MemoryRecords
  /** The machine's ledger lines, shared: a second plugin on the same array is the plugin after a restart. */
  readonly ledger?: Array<unknown>
  /** Which step sessions still run a turn; any other does not. */
  readonly alive?: Readonly<Record<string, boolean>>
  /** The findings each verifier report holds, by its path, read at each read (a test may add one later); a report not here does not read. */
  readonly findings?: Readonly<Record<string, ReadonlyArray<string>>>
  /** The branch checked out at each Rift path; a path not here reads none. */
  readonly branches?: Readonly<Record<string, string>>
  /** The verified targets the plugin asked to record. */
  readonly fleet?: Array<FleetTest.Asked>
  /** What recording each of them answers; `Off` (nothing said) when not named. */
  readonly fleetOutcome?: (asked: FleetTest.Asked) => FleetOutcome
  /** The drops journal log.ts writes and the plugin reads; none by default. */
  readonly drops?: string
}

/** A tool as the host's tool editor hands it out: only what the plugin touches. */
interface EditedTool {
  execute: (input: unknown, context: unknown) => Effect.Effect<{ readonly output?: unknown; readonly content?: unknown; readonly metadata?: unknown }, unknown>
  output?: unknown
}

/** What the stand-in subagent tool was run with. */
interface Ran {
  readonly input: Record<string, unknown>
  readonly context: Record<string, unknown>
}

/** A mutable agent as the host's editor hands it out: only what the plugin touches. */
interface EditedAgent {
  id: string
  mode: string
  hidden?: boolean
  description?: string
  system?: string
  permissions: Array<unknown>
  request: { settings: { compactionWindow?: number; cacheTTL?: string } }
}

/**
 * The plugin started on a stand-in host: its hooks, the agent transform it
 * registered, and the call log's lines.
 */
const start = (options: Record<string, unknown>, world: World = {}) =>
  Effect.gen(function* () {
    const lines: Array<CallLine> = []
    const hooks: Record<string, Array<Hook>> = {}
    const transforms: Array<(editor: unknown) => void> = []
    const toolTransforms: Array<(editor: unknown) => void> = []
    const rpc: Record<string, Record<string, (input: unknown) => Effect.Effect<unknown>>> = {}
    // The host's event stream, which the test publishes into.
    const published = yield* Queue.unbounded<Record<string, unknown>>()
    // Each session's messages as the host's `session.context` answers them, which the test sets.
    const contexts = new Map<string, ReadonlyArray<unknown>>()
    const register = (name: string, callback: Hook) =>
      Effect.sync(() => {
        ;(hooks[name] ??= []).push(callback)
        return { dispose: Effect.void }
      })
    const host = {
      options,
      agent: {
        transform: (callback: (editor: unknown) => void) =>
          Effect.sync(() => {
            transforms.push(callback)
            return { dispose: Effect.void }
          }),
        reload: () => Effect.void,
      },
      session: {
        hook: register,
        get: () => Effect.succeed({ location: { directory: "/work" } }),
        context: (input: { readonly sessionID: string }) => Effect.sync(() => [...(contexts.get(input.sessionID) || [])]),
      },
      location: { directory: "/work" },
      shell: { hook: register },
      event: { subscribe: () => Stream.fromQueue(published) },
      tool: {
        hook: register,
        transform: (callback: (editor: unknown) => void) =>
          Effect.sync(() => {
            toolTransforms.push(callback)
            return { dispose: Effect.void }
          }),
      },
      rpc: {
        register: (definition: { readonly id: string }, handlers: Record<string, (input: unknown) => Effect.Effect<unknown>>) =>
          Effect.sync(() => {
            rpc[definition.id] = handlers
            return { dispose: Effect.void, events: { emit: () => Effect.void } }
          }),
      },
    } as unknown as Host
    const kept = world.kept ?? []
    const keep = (ask: LatchAsk) =>
      Effect.sync(() => {
        if (world.refuse !== undefined) return { outcome: "refused", reason: world.refuse }
        const child = `ses_latched${kept.length + 1}`
        kept.push({ ...ask, child })
        return { outcome: "latched", id: `w00000${kept.length}`, child }
      })
    const ledger = world.ledger ?? []
    const briefs: Array<OpenCodeSteer.Synthetic> = []
    const externals = (start: OpenCodeLatches.Start, background: Background) => Layer.mergeAll(
      MemoryLedger.layer(DEFAULT_CADENCE, ledger),
      Layer.succeed(Findings, {
        read: (report: string) =>
          Effect.sync((): FindingsRead => {
            const found = world.findings?.[report]
            return found === undefined ? { _tag: "Unread", why: `the report ${report} does not read` } : { _tag: "Read", findings: found }
          }),
      }),
      Layer.succeed(Liveness, { alive: (sessionID: string) => Effect.succeed(world.alive?.[sessionID] === true || background(sessionID) > 0) }),
      Layer.succeed(Branches, { of: (path: string) => Effect.succeed(world.branches?.[path.replace(/\/+$/, "")]) }),
      OpenCodeSteer.remindLayer((input) => Effect.sync(() => void briefs.push(input))),
      CallLogTest.layer(lines),
      SessionsTest.layer(world.sessions ?? {}),
      ModelsTest.layer(world.model, world.variants, world.others),
      world.poolAsk === undefined
        ? PoolPaceTest.layer(world.pool ?? {}, world.started)
        : OpenCodePoolPace.layer(world.poolAsk, () => Effect.succeed({})),
      CodexAdmissionTest.layer(world.codex ?? (() => undefined)),
      OpenCodeLatches.layer(keep, start),
      FileUnitLogs.layer(LOG_SCRIPT, { journal: world.drops ?? "/nonexistent/loop-probe-x/drops.jsonl" }),
      StepLogTest.layer(world.steps ?? {}),
      OpenCodeRuns.layer(() => Effect.succeed({ agents: [], runs: world.runs ?? [], errors: [] })),
      Layer.succeed(RootHolds, { of: (sessionID: string) => Effect.succeed(world.holds?.[sessionID] ?? NO_HOLDS) }),
      OpenCodeSteer.layer((input) => (world.refuseNudge === undefined ? Effect.sync(() => void nudges.push(input)) : Effect.fail(new Error(world.refuseNudge)))),
      OpenCodeSteer.tellLayer((input) => (world.refuseNudge === undefined ? Effect.sync(() => void notes.push(input)) : Effect.fail(new Error(world.refuseNudge)))),
      SkillTest.skill(world.skill ?? { history: [] }),
      SkillTest.records(world.records ?? { seen: new Map() }),
      FleetTest.layer(world.fleet ?? [], world.fleetOutcome),
    )
    const nudges: Array<OpenCodeSteer.Synthetic> = []
    const notes: Array<OpenCodeSteer.Synthetic> = []
    yield* make((_ctx, _options, start, background) => externals(start, background)).effect(host)

    // The subagent tool, as the host's editor holds it after the plugin's transform: it records each run.
    const ran: Array<Ran> = []
    const subagent: EditedTool = {
      execute: (input, context) =>
        Effect.suspend(() => {
          ran.push({ input: input as Record<string, unknown>, context: context as Record<string, unknown> })
          const prompt = (input as { readonly prompt?: unknown }).prompt
          if (typeof prompt === "string" && prompt.includes("boom")) return Effect.fail(new Error("the child would not start"))
          return Effect.succeed({ output: { sessionID: "ses_ran", status: "running", output: "working" }, content: "working" })
        }),
    }
    for (const transform of toolTransforms) transform({ update: (id: string, edit: (tool: EditedTool) => void) => (id === "subagent" ? edit(subagent) : undefined) })
    /** The subagent tool run with the input the hooks left, in the root session's call. */
    const runTool = (input: unknown) => subagent.execute(input, { sessionID: "root", agent: "build", messageID: "msg", id: "call", progress: () => Effect.void })
    /** The wakes asking the opener to open a latch. */
    const open = (latch: unknown) => {
      const handler = rpc["dotfiles-opencode.wake.opener"]?.open
      return handler === undefined ? Effect.die(new Error("no opener")) : handler(latch)
    }

    /** One tool call through the `execute.before` hooks: the input the tool then runs with, or the refusal. */
    const call = Effect.fn("OrchestrateServerTest.call")(function* (tool: string, sessionID: string, input: unknown = {}) {
      const event: Record<string, unknown> = { tool, sessionID, agent: "build", messageID: "msg", id: "call", input }
      for (const hook of hooks["execute.before"] ?? []) {
        const exit = yield* Effect.exit(hook(event))
        if (exit._tag === "Failure") {
          const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
          return { refused: reason?._tag === "Fail" ? reason.error : undefined, input: event.input }
        }
      }
      return { refused: undefined, input: event.input }
    })
    /** A subagent call returning through the `execute.after` hooks. */
    const finish = Effect.fn("OrchestrateServerTest.finish")(function* (result: Record<string, unknown>) {
      const event = { tool: "subagent", sessionID: "root", agent: "build", messageID: "msg", id: "call", input: {}, ...result }
      for (const hook of hooks["execute.after"] ?? []) yield* hook(event)
    })
    /** The log's lines without their wall-clock times, which are checked once. */
    const logged = () => {
      for (const line of lines) expect(Number.isFinite(Date.parse(line.at))).toBe(true)
      return lines.map(({ at: _, ...line }) => JSON.stringify(line))
    }
    /** The session ends its turn with nothing pending: the host's `experimental.idle` hook, with what still runs for it. */
    const idle = Effect.fn("OrchestrateServerTest.idle")(function* (sessionID: string, background: ReadonlyArray<unknown> = []) {
      for (const hook of hooks["experimental.idle"] ?? []) yield* hook({ sessionID, background })
    })
    /** An input reaching a session's inbox: the owner's prompt, or a synthetic message with `metadata`. */
    const enqueue = (sessionID: string, item: { readonly type: "user" } | { readonly type: "synthetic"; readonly metadata?: Record<string, unknown> }) =>
      Queue.offer(published, {
        type: "session.inbox.enqueued",
        data: { sessionID, item: item.type === "user" ? { type: "user", payload: {} } : { type: "synthetic", payload: { text: "x", metadata: item.metadata } } },
      })
    /** An owner's TUI reporting a draft over the idle RPC. */
    const draft = (input: unknown) => {
      const handler = rpc["dotfiles-opencode.orchestrate.idle"]?.draft
      return handler === undefined ? Effect.die(new Error("no idle RPC")) : handler(input)
    }
    /** A session's compaction ended: the host's durable event, with its id. */
    const compacted = (sessionID: string, id: string) => Queue.offer(published, { id, type: "session.compaction.ended", data: { sessionID } })
    /** One model request of the session through the `model.request` hooks: done once every hook let it go. */
    const modelRequest = Effect.fn("OrchestrateServerTest.modelRequest")(function* (sessionID: string) {
      for (const hook of hooks["model.request"] || []) yield* hook({ sessionID, agent: "build", kind: "primary", headers: {} })
    })
    return { contexts, modelRequest, call, finish, logged, hooks, transforms, runTool, ran, open, kept, subagent, idle, enqueue, draft, nudges, notes, ledger, briefs, compacted }
  })

/** Waits for the plugin's background work, in real time, until `check` passes (tests/wait.ts); one that never does fails with its own expectation. */
const eventually = (check: () => void) => Effect.promise(() => eventuallyPasses(check))

/** Lets the plugin's background work run, for a check that nothing happened. */
const settle = Effect.sleep("100 millis")

const scenario = <A, E>(body: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("over the Sabbath", () => {
  test("no subagent starts, and a running subagent's tools are refused; the main session's are not", () =>
    scenario(
      Effect.gen(function* () {
        // No wakes plugin keeps a latch here, so a new subagent is refused.
        const friday = yield* start({ now: FRIDAY_EVENING }, { sessions: { root: {}, child: { parentID: "root" } }, refuse: "no wakes" })
        const subagent = yield* friday.call("subagent", "root", { prompt: "x" })
        expect(subagent.refused?._tag).toBe("Tool.Error")
        expect(subagent.refused?.message).toEndWith("No agent starts now. Do not retry; start it again once work resumes.")
        expect(subagent.refused?.message.replace(/ No agent starts now.*$/, "")).toMatch(SABBATH)
        const shell = yield* friday.call("shell", "child")
        expect(shell.refused?.message).toEndWith(
          "Stop now: end your turn with one line on where you stopped. Make no more tool calls.",
        )
        expect((yield* friday.call("shell", "root")).refused).toBeUndefined()
        // A follow-up is refused; a call whose input is not one the tool takes is left to the tool.
        expect((yield* friday.call("subagent", "root", { sessionID: "child", prompt: "more" })).refused?.message).toEndWith(
          "No agent starts now. Do not retry; start it again once work resumes.",
        )
        expect(yield* friday.call("subagent", "root", "x")).toEqual({ refused: undefined, input: "x" })
        const denied = friday.logged().map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(denied.map(({ why: _, ...line }) => JSON.stringify(line))).toEqual([
          '{"kind":"denied","sessionID":"root","callID":"call","tool":"subagent"}',
          '{"kind":"denied","sessionID":"child","callID":"call","tool":"shell"}',
          '{"kind":"denied","sessionID":"root","callID":"call","tool":"subagent"}',
        ])
        for (const line of denied) expect(line.why).toMatch(SABBATH)

        const wednesday = yield* start({ now: WEDNESDAY }, { sessions: { root: {}, child: { parentID: "root" } } })
        expect((yield* wednesday.call("shell", "child")).refused).toBeUndefined()
        expect(wednesday.logged()).toEqual([])
      }),
    ))
})

describe("the guard", () => {
  test("an untyped call runs as the worker, and its line says why", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY })
        const result = yield* plugin.call("subagent", "root", { prompt: "x", description: "look", background: true })
        expect(result).toEqual({
          refused: undefined,
          input: { prompt: "x", description: "look", background: true, agent: "worker" },
        })
        expect(plugin.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","agent":"worker","reason":"untyped","background":true,"description":"look"}',
        ])
      }),
    ))

  test("a new role subagent runs at the role's effort when its model offers it", () =>
    scenario(
      Effect.gen(function* () {
        const model = { providerID: "anthropic", id: "claude" }
        const offered = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"] })
        expect((yield* offered.call("subagent", "root", { agent: "orchestrate-planner", model: "" })).input).toEqual({
          agent: "planner",
          model: "anthropic/claude#medium",
        })
        expect(offered.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"orchestrate-planner","agent":"planner","reason":"renamed","model":"anthropic/claude#medium","pace":{"ok":true,"measured":false,"reason":"provider is not pooled"}}',
        ])
        // A model the call names is kept; so is the model's own effort when it has no such variant.
        expect((yield* offered.call("subagent", "root", { agent: "planner", model: "openai/gpt#low" })).input).toEqual({
          agent: "planner",
          model: "openai/gpt#low",
        })
        const plain = yield* start({ now: WEDNESDAY }, { model })
        expect((yield* plain.call("subagent", "root", { agent: "planner" })).input).toEqual({ agent: "planner" })
      }),
    ))

  test("a new role start naming the role's own model, at any variant or none, runs at the role's effort; its line says model-dropped", () =>
    scenario(
      Effect.gen(function* () {
        const model = { providerID: "anthropic", id: "claude-opus-5-5" }
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium", "high"], sessions: { child: { parentID: "root", agent: "verifier" } } })
        for (const named of ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5#max", "claude-opus-5-5"])
          expect((yield* plugin.call("subagent", "root", { agent: "verifier", model: named })).input).toEqual({ agent: "verifier", model: "anthropic/claude-opus-5-5#medium" })
        // A described role too; the worker, with no effort of its own, runs on its own model with the name dropped.
        const described = { agent: "general", model: "anthropic/claude-opus-5-5", description: "pkg-lower implementor r2" }
        expect((yield* plugin.call("subagent", "root", described)).input).toEqual({ ...described, agent: "implementor", model: "anthropic/claude-opus-5-5#medium" })
        expect((yield* plugin.call("subagent", "root", { agent: "worker", model: "anthropic/claude-opus-5-5#low" })).input).toEqual({ agent: "worker" })
        expect(plugin.logged().map((line) => (JSON.parse(line) as { reason: string }).reason)).toEqual(Array(5).fill("model-dropped"))
        // A different model, a non-role agent and a follow-up keep the model they name.
        expect((yield* plugin.call("subagent", "root", { agent: "verifier", model: "anthropic/claude-sonnet" })).input).toEqual({ agent: "verifier", model: "anthropic/claude-sonnet" })
        expect((yield* plugin.call("subagent", "root", { agent: "explore", model: "anthropic/claude-opus-5-5" })).input).toEqual({ agent: "explore", model: "anthropic/claude-opus-5-5" })
        expect((yield* plugin.call("subagent", "root", { sessionID: "child", model: "anthropic/claude-opus-5-5" })).input).toEqual({
          sessionID: "child",
          model: "anthropic/claude-opus-5-5",
          agent: "verifier",
        })
        expect(plugin.logged().slice(5).map((line) => (JSON.parse(line) as { reason: string }).reason)).toEqual(["kept", "kept", "continued"])
      }),
    ))

  test("role work asked of a general agent runs as its described role, at the role's effort, and its line says why", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { model: { providerID: "anthropic", id: "claude" }, variants: ["medium"] })
        const input = { agent: "general", description: "closure-flake verifier r1 (Opus)", prompt: "x", background: true }
        expect((yield* plugin.call("subagent", "root", input)).input).toEqual({ ...input, agent: "verifier", model: "anthropic/claude#medium" })
        expect(plugin.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"general","agent":"verifier","reason":"described","model":"anthropic/claude#medium","background":true,"description":"closure-flake verifier r1 (Opus)","pace":{"ok":true,"measured":false,"reason":"provider is not pooled"}}',
        ])
      }),
    ))

  test("a follow-up naming no agent keeps its child's, and is not paced", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(
          { now: WEDNESDAY },
          {
            sessions: { child: { parentID: "root", agent: "verifier" } },
            model: { providerID: "anthropic", id: "claude" },
            pool: { anthropic: { ok: false, measured: true, reason: "held" } },
          },
        )
        expect((yield* plugin.call("subagent", "root", { sessionID: "child", prompt: "go on" })).input).toEqual({
          sessionID: "child",
          prompt: "go on",
          agent: "verifier",
        })
        expect(plugin.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","agent":"verifier","reason":"continued","child":"child"}',
        ])
      }),
    ))

  test("a worker at max, asked or inherited, runs at its model's default, logged and told to the parent; a mechanical one runs at max", () =>
    scenario(
      Effect.gen(function* () {
        const NOTE =
          "orchestrate: this worker runs on anthropic/claude-opus at the model's default effort, not max: a worker runs at max only when its description ends `(mechanical)`. Bulk model work (a critique of many images, a sweep) is a script, not a worker at max."
        // The root session runs at max, so a worker that names no model inherits it.
        const plugin = yield* start({ now: WEDNESDAY }, { model: { providerID: "anthropic", id: "claude-opus", variant: "max" }, variants: ["high", "max"] })
        const inherited = yield* plugin.call("subagent", "root", { agent: "general", description: "Critique the stills", prompt: "x" })
        expect(inherited.input).toEqual({ agent: "worker", description: "Critique the stills", prompt: "x", model: "anthropic/claude-opus" })
        const answer = yield* plugin.runTool(inherited.input)
        expect(answer.content).toBe(`${NOTE}\nworking`)
        const asked = yield* plugin.call("subagent", "root", { agent: "worker", description: "Check the export", prompt: "x", model: "anthropic/claude-opus#max" })
        expect((asked.input as { model?: string }).model).toBe("anthropic/claude-opus")
        const mechanical = yield* plugin.call("subagent", "root", { description: "Rename the rows (mechanical)", prompt: "x" })
        expect((mechanical.input as { model?: string }).model).toBeUndefined()
        expect(plugin.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"general","agent":"worker","reason":"general","model":"anthropic/claude-opus","description":"Critique the stills","lowered":"max","pace":{"ok":true,"measured":false,"reason":"provider is not pooled"}}',
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"worker","agent":"worker","reason":"model-dropped","model":"anthropic/claude-opus","description":"Check the export","lowered":"max","pace":{"ok":true,"measured":false,"reason":"provider is not pooled"}}',
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","agent":"worker","reason":"untyped","description":"Rename the rows (mechanical)","pace":{"ok":true,"measured":false,"reason":"provider is not pooled"}}',
        ])
      }),
    ))

  test("with the full-agent escape, a general call runs as asked", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY, fullAgent: true })
        expect((yield* plugin.call("subagent", "root", { agent: "general" })).input).toEqual({ agent: "general" })
      }),
    ))

  test("a call whose input is not an object is left to the tool", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY })
        expect(yield* plugin.call("subagent", "root", "x")).toEqual({ refused: undefined, input: "x" })
        expect(plugin.logged()).toEqual([])
      }),
    ))

  test("a finished call is logged with its child and how it ended", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY })
        yield* plugin.finish({ status: "completed", result: { metadata: { sessionID: "kid", status: "running" } } })
        yield* plugin.finish({ status: "completed", result: { metadata: { sessionID: "kid" } } })
        yield* plugin.finish({ status: "error", error: { message: "boom" } })
        yield* plugin.finish({ tool: "shell", status: "completed", result: {} })
        expect(plugin.logged()).toEqual([
          '{"kind":"done","sessionID":"root","callID":"call","child":"kid","status":"running"}',
          '{"kind":"done","sessionID":"root","callID":"call","child":"kid","status":"completed"}',
          '{"kind":"done","sessionID":"root","callID":"call","status":"error"}',
        ])
      }),
    ))
})

describe("the pace", () => {
  const now = Date.parse(WEDNESDAY)

  test("the pool's hold refuses a new agent when no latch can be kept, with the time it opens", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(
          { now: WEDNESDAY },
          {
            model: { providerID: "anthropic", id: "claude" },
            pool: { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 300_000.5 } },
            refuse: "no wakes",
          },
        )
        const held = yield* plugin.call("subagent", "root", { agent: "explore" })
        expect(held.refused?.message).toBe(
          `orchestrate: the pool's pace holds this agent. all pool accounts are held. It opens about ${new Date(now + 300_000).toISOString()} (Wed 10:05 America/Toronto); no latch could be kept for it, so start it again after then. Do not poll.`,
        )
        expect(plugin.logged()).toEqual([
          '{"kind":"denied","sessionID":"root","callID":"call","tool":"subagent","why":"all pool accounts are held"}',
        ])
      }),
    ))

  test("a Codex provider's agent asks the Codex account, with its role", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const codex = (model: string, role: string): Pace => {
          asked.push(`${model} ${role}`)
          return { ok: false, measured: true, reason: "weekly pace" }
        }
        const plugin = yield* start({ now: WEDNESDAY }, { codex, refuse: "no wakes" })
        const held = yield* plugin.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5#high" })
        expect(held.refused?.message).toStartWith(
          `orchestrate: the Codex account's pace holds this agent. weekly pace. It opens about ${new Date(now + 60_000).toISOString()} (`,
        )
        expect((yield* plugin.call("subagent", "root", { agent: "explore", model: "openai/gpt-5" })).refused).toBeDefined()
        expect(asked).toEqual(["gpt-5 verifier", "gpt-5 none"])
        // With `codex: false` the pool answers for every provider; it has no hold here.
        const pooled = yield* start({ now: WEDNESDAY, codex: false }, { codex })
        expect((yield* pooled.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5" })).refused).toBeUndefined()
        expect(asked).toHaveLength(2)
      }),
    ))

  test("with `codex.pool`, a Codex provider's agent takes the pool's pace when the pool measures the account, and the script is not asked", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const codex = (model: string, role: string): Pace => {
          asked.push(`${model} ${role}`)
          return { ok: true, measured: true, reason: "room" }
        }
        const reason = "the pool's weekly pace is over (80.0% spent across 1 accounts)"
        const held = yield* start(
          { now: WEDNESDAY, codex: { pool: true } },
          { codex, pool: { openai: { ok: false, measured: true, reason, retryAt: now + 120_000 } }, refuse: "no wakes" },
        )
        const refused = (yield* held.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5#high" })).refused
        expect(refused?.message).toStartWith(
          `orchestrate: the Codex account's pace holds this agent. ${reason}. It opens about ${new Date(now + 120_000).toISOString()} (`,
        )
        // A pool that has no measure of it (no ChatGPT login read) leaves it to the script.
        const unmeasured = yield* start({ now: WEDNESDAY, codex: { pool: true } }, { codex, pool: { openai: { ok: true, measured: false, reason: "no pooled account readings" } } })
        expect((yield* unmeasured.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5" })).refused).toBeUndefined()
        const open = yield* start({ now: WEDNESDAY, codex: { pool: true } }, { codex, pool: { openai: { ok: true, measured: true, reason: "within" } } })
        expect((yield* open.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5" })).refused).toBeUndefined()
        expect(asked).toEqual(["gpt-5 verifier"])
        // Without `codex.pool` the script alone answers: the pool's hold is not asked.
        const scripted = yield* start({ now: WEDNESDAY }, { codex, pool: { openai: { ok: false, measured: true, reason, retryAt: now + 120_000 } } })
        expect((yield* scripted.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5" })).refused).toBeUndefined()
        expect(asked).toEqual(["gpt-5 verifier", "gpt-5 verifier"])
      }),
    ))

  test("each new agent that starts is told to the pool by its provider; a latched one or a follow-up is not", () =>
    scenario(
      Effect.gen(function* () {
        const started: Array<string> = []
        const plugin = yield* start(
          { now: WEDNESDAY },
          {
            started,
            model: { providerID: "anthropic", id: "claude" },
            sessions: { child: { parentID: "root", agent: "worker" } },
            pool: { sim: { ok: false, measured: true, reason: "held", retryAt: now + 60_000 } },
          },
        )
        expect((yield* plugin.call("subagent", "root", { agent: "explore" })).refused).toBeUndefined()
        expect((yield* plugin.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5" })).refused).toBeUndefined()
        const held = yield* plugin.call("subagent", "root", { agent: "explore", model: "sim/model" })
        expect(held.refused).toBeUndefined()
        expect(held.input).toMatchObject({ sessionID: "ses_latched1" })
        expect((yield* plugin.call("subagent", "root", { sessionID: "child", prompt: "more" })).refused).toBeUndefined()
        expect(started).toEqual(["anthropic", "openai"])
        const friday = yield* start({ now: FRIDAY_EVENING }, { started })
        yield* friday.call("subagent", "root", { agent: "explore" })
        expect(started).toEqual(["anthropic", "openai"])
      }),
    ))
})

describe("the call line's admission", () => {
  const model = { providerID: "anthropic", id: "claude" }
  /** The admission fields of the log's one line. */
  const admission = (logged: ReadonlyArray<string>) => {
    expect(logged).toHaveLength(1)
    const { pace, codex, fallbackPace, fallbackCodex } = JSON.parse(logged[0]!) as Record<string, unknown>
    return Object.fromEntries(Object.entries({ pace, codex, fallbackPace, fallbackCodex }).filter(([, value]) => value !== undefined))
  }

  test("a start a measured pace admitted says so", () =>
    scenario(
      Effect.gen(function* () {
        const reason = "weekly pace: 20.0% spent, 57.0% allowed"
        const plugin = yield* start({ now: WEDNESDAY }, { model, pool: { anthropic: { ok: true, measured: true, reason } } })
        expect((yield* plugin.call("subagent", "root", { agent: "explore", description: "look" })).refused).toBeUndefined()
        expect(plugin.logged()).toEqual([
          `{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"explore","agent":"explore","reason":"kept","description":"look","pace":{"ok":true,"measured":true,"reason":"${reason}"}}`,
        ])
      }),
    ))

  test("each way the pool's pace fails open starts the agent, and the line names the cause", () =>
    scenario(
      Effect.gen(function* () {
        const causes: ReadonlyArray<readonly [OpenCodePoolPace.Ask, string]> = [
          [() => Effect.fail({ type: "rpc.unavailable", message: "nothing answers" }), "no pool: rpc.unavailable (nothing answers)"],
          [() => Effect.fail({ type: "rpc.internal", message: "logins cannot be read" }), "error: rpc.internal: logins cannot be read"],
          [() => Effect.die(new Error("socket closed")), "defect: socket closed"],
          [() => Effect.succeed({ ok: "yes" }), 'undecodable: {"ok":"yes"}'],
        ]
        for (const [poolAsk, why] of causes) {
          const plugin = yield* start({ now: WEDNESDAY }, { model, poolAsk })
          expect((yield* plugin.call("subagent", "root", { agent: "explore" })).refused).toBeUndefined()
          expect(admission(plugin.logged())).toEqual({ pace: { failOpen: why } })
        }
      }),
    ))

  test("the Codex admission is recorded when asked: failed open, and after an unmeasured pool", () =>
    scenario(
      Effect.gen(function* () {
        const silent = yield* start({ now: WEDNESDAY }, {})
        expect((yield* silent.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5" })).refused).toBeUndefined()
        expect(admission(silent.logged())).toEqual({ codex: { failOpen: "no admission line (exit 2)" } })
        const unmeasured = yield* start(
          { now: WEDNESDAY, codex: { pool: true } },
          { pool: { openai: { ok: true, measured: false, reason: "no pooled account readings" } }, codex: () => ({ ok: true, measured: true, reason: "room for 3" }) },
        )
        expect((yield* unmeasured.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5" })).refused).toBeUndefined()
        expect(admission(unmeasured.logged())).toEqual({
          pace: { ok: true, measured: false, reason: "no pooled account readings" },
          codex: { ok: true, measured: true, reason: "room for 3" },
        })
      }),
    ))

  test("a follow-up, and a start over the Sabbath, ask no pace and record none", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { model, sessions: { child: { parentID: "root", agent: "worker" } } })
        yield* plugin.call("subagent", "root", { sessionID: "child", prompt: "more" })
        expect(admission(plugin.logged())).toEqual({})
        const friday = yield* start({ now: FRIDAY_EVENING }, { model })
        yield* friday.call("subagent", "root", { agent: "explore", prompt: "x" })
        expect(admission(friday.logged())).toEqual({})
      }),
    ))
})

describe("a latch", () => {
  const now = Date.parse(WEDNESDAY)
  const held = { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 600_000 } }
  const model = { providerID: "anthropic", id: "claude" }
  /** The latch the wakes keep for an ask, as they hand it to the opener. */
  const latchOf = (ask: LatchAsk & { readonly child: string }, id = "w000001"): Latch => {
    const { child, ...rest } = ask
    return { kind: "latch", id, directory: "/work", setAt: now, child, ...rest }
  }
  /**
   * Run `body`, and the window of the system's clock it ran in, as offsets
   * from the fixed clock: the wakes keep the system's time, so a latch's
   * times reach them moved on by how far the system's clock is ahead.
   */
  const timed = <A, E>(body: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const before = Date.now() - now
      const value = yield* body
      return { value, ahead: { min: before, max: Date.now() - now } }
    })
  const onWall = (value: number, fixed: number, ahead: { readonly min: number; readonly max: number }) => {
    expect(value).toBeGreaterThanOrEqual(fixed + ahead.min)
    expect(value).toBeLessThanOrEqual(fixed + ahead.max)
  }

  test("a held start latches: the call names its child, and the tool answers at once that it waits, why and until when", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { model, pool: held })
        const { value: call, ahead } = yield* timed(plugin.call("subagent", "root", { agent: "explore", description: "look", prompt: "find it" }))
        expect(call).toEqual({
          refused: undefined,
          input: { agent: "explore", description: "look", prompt: "find it", model: "anthropic/claude", sessionID: "ses_latched1" },
        })
        expect(plugin.kept).toEqual([
          {
            sessionID: "root",
            subagent: { agent: "explore", description: "look", prompt: "find it", model: "anthropic/claude", from: "build", messageID: "msg", callID: "call" },
            hold: "pace",
            reason: "all pool accounts are held",
            opensAt: expect.any(Number),
            recheckAt: expect.any(Number),
            context: { reason: "kept" },
            child: "ses_latched1",
          },
        ])
        // The wakes get the system's time; the answer and the log keep the fixed clock's.
        onWall(plugin.kept[0]!.opensAt, now + 600_000, ahead)
        expect(plugin.kept[0]!.opensAt - plugin.kept[0]!.recheckAt).toBe(480_000)
        const answer = yield* plugin.runTool(call.input)
        expect(plugin.ran).toEqual([])
        expect(answer.output).toMatchObject({
          sessionID: "ses_latched1",
          status: "latched",
          latch: { id: "w000001", hold: "pace", reason: "all pool accounts are held", opensAt: now + 600_000, opens: new Date(now + 600_000).toISOString() },
        })
        expect(answer.content).toBe(
          [
            "The subagent is latched (sessionID: ses_latched1, latch w000001). the pool's pace holds this agent: all pool accounts are held.",
            `It starts by itself in the background when the latch opens, about ${new Date(now + 600_000).toISOString()} (${(answer.output as { latch: { local: string } }).latch.local} ${KNOWLTON.timeZone}), or sooner: it is decided again at ${new Date(now + 120_000).toISOString()}. You will be woken with its result, as for a background subagent.`,
            "Go on with other work, or end your turn. Do not start it again, poll or wait for it. wake_list shows the latch; wake_cancel cancels it.",
          ].join("\n"),
        )
        // The answer is given once: the same child run again goes to the tool.
        yield* plugin.runTool(call.input)
        expect(plugin.ran).toHaveLength(1)
        // The call returns latched.
        yield* plugin.finish({ status: "completed", result: answer })
        expect(plugin.logged()).toEqual([
          '{"kind":"latched","sessionID":"root","callID":"call","from":"build","asked":"explore","agent":"explore","reason":"kept","model":"anthropic/claude","child":"ses_latched1","description":"look","pace":{"ok":false,"measured":true,"reason":"all pool accounts are held"},"hold":"pace","why":"all pool accounts are held","opens":"' +
            new Date(now + 600_000).toISOString() +
            '"}',
          '{"kind":"done","sessionID":"root","callID":"call","child":"ses_latched1","status":"latched"}',
        ])
      }),
    ))

  test("over the Sabbath a new subagent latches until work resumes", () =>
    scenario(
      Effect.gen(function* () {
        const friday = yield* start({ now: FRIDAY_EVENING }, { model })
        const call = yield* friday.call("subagent", "root", { agent: "explore", prompt: "x" })
        expect(call.refused).toBeUndefined()
        const kept = friday.kept[0]!
        expect(kept).toMatchObject({ hold: "sabbath", subagent: { description: "explore" } })
        expect(kept.reason).toMatch(SABBATH)
        expect(kept.recheckAt).toBe(kept.opensAt)
        const answer = yield* friday.runTool(call.input)
        expect(String(answer.content)).toStartWith(`The subagent is latched (sessionID: ses_latched1, latch w000001). ${kept.reason}\nIt starts by itself`)
        // Opened while it is still the Sabbath, it latches again, until the same resumption on the system's clock as it reads then.
        const reopened = Schema.decodeUnknownSync(Opened)(yield* friday.open(latchOf(kept)))
        expect(reopened).toMatchObject({ outcome: "held", hold: "sabbath", reason: kept.reason })
        if (reopened.outcome !== "held") throw new Error("not held")
        expect(reopened.recheckAt).toBe(reopened.opensAt)
        expect(reopened.opensAt).toBeGreaterThanOrEqual(kept.opensAt)
        expect(reopened.opensAt - kept.opensAt).toBeLessThan(1_000)
        expect(friday.ran).toEqual([])
      }),
    ))

  test("opened while still held, it latches again with the hold's new time", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { model, pool: held })
        yield* plugin.call("subagent", "root", { agent: "explore", description: "look", prompt: "find it" })
        const { value: answer, ahead } = yield* timed(plugin.open(latchOf(plugin.kept[0]!)))
        const reopened = Schema.decodeUnknownSync(Opened)(answer)
        expect(reopened).toEqual({ outcome: "held", hold: "pace", reason: "all pool accounts are held", opensAt: expect.any(Number), recheckAt: expect.any(Number) })
        if (reopened.outcome !== "held") throw new Error("not held")
        onWall(reopened.opensAt, now + 600_000, ahead)
        onWall(reopened.recheckAt, now + 120_000, ahead)
        expect(plugin.ran).toEqual([])
      }),
    ))

  test("opened when admitted, it starts in the background on its child through the subagent tool, as the parent's call", () =>
    scenario(
      Effect.gen(function* () {
        const kept: Array<LatchAsk & { readonly child: string }> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, pool: held, kept })
        yield* plugin.call("subagent", "root", { agent: "explore", description: "look", prompt: "find it" })
        const started: Array<string> = []
        const later = yield* start({ now: WEDNESDAY }, { model, started })
        expect(yield* later.open(latchOf(kept[0]!))).toEqual({ outcome: "opened" })
        expect(later.ran).toEqual([
          {
            input: {
              agent: "explore",
              description: "look",
              prompt: "You are a subagent spawned by another session.\nfind it",
              model: "anthropic/claude",
              sessionID: "ses_latched1",
              background: true,
            },
            context: expect.objectContaining({ sessionID: "root", agent: "build", messageID: "msg", id: "call" }),
          },
        ])
        expect(started).toEqual(["anthropic"])
        expect(later.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","agent":"explore","reason":"kept","model":"anthropic/claude","child":"ses_latched1","background":true,"description":"look","pace":{"ok":true,"measured":false,"reason":"provider is not pooled"}}',
          '{"kind":"done","sessionID":"root","callID":"call","child":"ses_latched1","status":"running"}',
        ])
      }),
    ))

  test("a child that already started is not started twice; one that will not start fails the latch; a malformed latch fails", () =>
    scenario(
      Effect.gen(function* () {
        const kept: Array<LatchAsk & { readonly child: string }> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, pool: held, kept })
        yield* plugin.call("subagent", "root", { agent: "explore", description: "look", prompt: "boom" })
        const ran = yield* start({ now: WEDNESDAY }, { model, sessions: { ses_latched1: { parentID: "root", started: true } } })
        expect(yield* ran.open(latchOf(kept[0]!))).toEqual({ outcome: "opened" })
        expect(ran.ran).toEqual([])
        expect(ran.logged()).toEqual([])

        const later = yield* start({ now: WEDNESDAY }, { model })
        expect(yield* later.open(latchOf(kept[0]!))).toEqual({ outcome: "failed", message: "the child would not start" })
        expect(later.logged().at(-1)).toBe('{"kind":"done","sessionID":"root","callID":"call","child":"ses_latched1","status":"error"}')
        const malformed = (yield* later.open({ kind: "alarm" })) as { readonly outcome: string; readonly message: string }
        expect(malformed.outcome).toBe("failed")
        expect(malformed.message).toStartWith("not a latch: ")
      }),
    ))

  test("a follow-up to a latched child is refused until it opens", () =>
    scenario(
      Effect.gen(function* () {
        const mark = { hold: "pace", reason: "held", opensAt: now + 60_000, at: now }
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: { kid: { parentID: "root", agent: "worker", latch: mark } } })
        const followUp = yield* plugin.call("subagent", "root", { sessionID: "kid", prompt: "more" })
        expect(followUp.refused?.message).toBe(
          `orchestrate: subagent kid is latched and has not started; it starts by itself at ${new Date(now + 60_000).toISOString()} (Wed 10:01 ${KNOWLTON.timeZone}), and its result wakes you. Send it nothing until then, or cancel its latch with wake_cancel and start a new one.`,
        )
        // A cancelled latch's child takes follow-ups again.
        const cancelled = yield* start({ now: WEDNESDAY }, { sessions: { kid: { parentID: "root", agent: "worker", latch: { ...mark, cancelledAt: now } } } })
        expect((yield* cancelled.call("subagent", "root", { sessionID: "kid", prompt: "more" })).refused).toBeUndefined()
      }),
    ))
})

describe("Opus first, Codex second", () => {
  const now = Date.parse(WEDNESDAY)
  const model = { providerID: "anthropic", id: "claude-opus" }
  const held = { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 600_000 } }
  const codexOffered: ReadonlyArray<Offered> = [
    { providerID: "openai", id: "gpt-6-sol", family: "gpt-sol", time: { released: 1 }, variants: [{ id: "medium" }, { id: "high" }] },
    { providerID: "openai", id: "gpt-6.1-sol", family: "gpt-sol", time: { released: 2 }, variants: [{ id: "medium" }, { id: "high" }] },
    { providerID: "openai", id: "gpt-6-luna", family: "gpt-luna", time: { released: 2 }, variants: [{ id: "max" }] },
  ]
  const admits = (asked: Array<string>) => (id: string, role: string): Pace => {
    asked.push(`${id} ${role}`)
    return { ok: true, measured: true, reason: "scripted room" }
  }
  const NOTE = "orchestrate: this agent runs on openai/gpt-6.1-sol#medium, the Codex fallback (anthropic/claude-opus#medium held: all pool accounts are held)."

  test("Claude's pace admits it: it runs on Opus at the role's effort, and Codex is never asked", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked) })
        expect((yield* plugin.call("subagent", "root", { agent: "verifier", prompt: "x" })).input).toEqual({ agent: "verifier", prompt: "x", model: "anthropic/claude-opus#medium" })
        expect(asked).toEqual([])
      }),
    ))

  test("held on Claude with room on Codex, it starts at once on the newest sol, logged and told to the parent", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const started: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked), pool: held, started })
        const call = yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier sso r1", prompt: "check it", background: true })
        expect(call).toEqual({
          refused: undefined,
          input: { agent: "verifier", description: "verifier sso r1", prompt: "check it", background: true, model: "openai/gpt-6.1-sol#medium" },
        })
        expect(asked).toEqual(["gpt-6.1-sol verifier"])
        expect(plugin.kept).toEqual([])
        // The pool counts it on the provider it started on.
        expect(started).toEqual(["openai"])
        expect(plugin.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"verifier","agent":"verifier","reason":"kept","model":"openai/gpt-6.1-sol#medium","background":true,"description":"verifier sso r1","fallback":"anthropic/claude-opus#medium held: all pool accounts are held","pace":{"ok":false,"measured":true,"reason":"all pool accounts are held"},"fallbackCodex":{"ok":true,"measured":true,"reason":"scripted room"}}',
        ])
        // The parent reads where it ran and why first, once.
        const answer = yield* plugin.runTool(call.input)
        expect(plugin.ran).toHaveLength(1)
        expect(answer.content).toBe(`${NOTE}\nworking`)
        expect(answer.output).toEqual({ sessionID: "ses_ran", status: "running", output: `${NOTE}\nworking` })
        expect((yield* plugin.runTool(call.input)).content).toBe("working")
      }),
    ))

  test("Codex never implements: a held implementor latches on Opus, mechanical or not, and Codex is never asked", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked), pool: held })
        const call = yield* plugin.call("subagent", "root", { agent: "implementor", description: "pkg-lower implementor (mechanical)", prompt: "x" })
        expect(call.input).toMatchObject({ model: "anthropic/claude-opus#medium", sessionID: "ses_latched1" })
        expect(asked).toEqual([])
      }),
    ))

  test("Codex never implements: an implementor naming a Codex model runs on its role's model, its line says model-dropped", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked) })
        const call = yield* plugin.call("subagent", "root", { agent: "implementor", model: "openai/gpt-6.1-sol", prompt: "x" })
        expect(call.input).toEqual({ agent: "implementor", prompt: "x", model: "anthropic/claude-opus#medium" })
        expect(asked).toEqual([])
        expect(plugin.logged()[0]).toContain('"reason":"model-dropped"')
      }),
    ))

  test("Codex never implements, whatever the codex option says: over fallback on, off or on other providers, a new or continued implementor naming any Codex model runs off it", () =>
    scenario(
      Effect.gen(function* () {
        // no-codex-impl r1 M1 (batch c): with `codex: false` the prohibition read an empty provider list.
        const codexOptions: ReadonlyArray<Record<string, unknown>> = [{}, { codex: false }, { codex: { providers: ["azure"] } }, { codex: { providers: ["openai", "azure"] } }]
        const named = ["openai/gpt-6.1-sol", "openai/gpt-6.1-sol#high", "openai/gpt-6.1-luna#max", "azure/gpt-6.1-sol", "openrouter/gpt-6.1-sol", "anthropic/claude-opus-4", undefined]
        for (const option of codexOptions)
          for (const asks of named)
            for (const followUp of [false, true]) {
              const sessions = { root: {}, ses_i: { parentID: "root", agent: "implementor" } }
              const plugin = yield* start({ now: WEDNESDAY, ...option }, { model, variants: ["medium"], others: codexOffered, codex: admits([]), sessions })
              const input = { agent: "implementor", prompt: "x", ...(asks === undefined ? {} : { model: asks }), ...(followUp ? { sessionID: "ses_i" } : {}) }
              const call = yield* plugin.call("subagent", "root", input)
              const runs = (call.input as { model?: string }).model
              const where = JSON.stringify({ option, asks, followUp, runs })
              expect([where, call.refused]).toEqual([where, undefined])
              // The oracle: a Codex model is one of its gpt- families, on any provider.
              expect([where, runs !== undefined && /(^|\/)gpt-/.test(runs)]).toEqual([where, false])
              // A model that is no Codex model, named, is kept as named.
              if (asks === "anthropic/claude-opus-4") expect([where, runs]).toEqual([where, asks])
            }
      }),
    ))

  test("the spend-evenly pace alone holds a planner or verifier but not an implementor, which starts on Opus", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const paced = { anthropic: { ok: false, measured: true, soft: true, reason: "the pool's weekly pace is over (457.0% spent across 6 accounts)", retryAt: Date.parse(WEDNESDAY) + 86_400_000 } }
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked), pool: paced })
        expect((yield* plugin.call("subagent", "root", { agent: "implementor", prompt: "x" })).input).toEqual({ agent: "implementor", prompt: "x", model: "anthropic/claude-opus#medium" })
        expect((yield* plugin.call("subagent", "root", { agent: "verifier", prompt: "x" })).input).toMatchObject({ model: "openai/gpt-6.1-sol#medium" })
      }),
    ))

  test("a model the call names is kept: held, it latches on it, and Codex is never asked", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, others: codexOffered, codex: admits(asked), pool: held })
        const call = yield* plugin.call("subagent", "root", { agent: "verifier", model: "anthropic/claude-opus-4", prompt: "x" })
        expect(call.input).toMatchObject({ model: "anthropic/claude-opus-4", sessionID: "ses_latched1" })
        expect(asked).toEqual([])
        expect(plugin.kept[0]!.context).toEqual({ reason: "kept" })
      }),
    ))

  test("a role call naming the role's own model runs as if it named none: held, it falls back to Codex, its line says model-dropped", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked), pool: held })
        const call = yield* plugin.call("subagent", "root", { agent: "verifier", model: "anthropic/claude-opus", description: "verifier sso r1", prompt: "x" })
        expect(call.input).toEqual({ agent: "verifier", description: "verifier sso r1", prompt: "x", model: "openai/gpt-6.1-sol#medium" })
        expect(asked).toEqual(["gpt-6.1-sol verifier"])
        expect(plugin.kept).toEqual([])
        expect(plugin.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"verifier","agent":"verifier","reason":"model-dropped","model":"openai/gpt-6.1-sol#medium","description":"verifier sso r1","fallback":"anthropic/claude-opus#medium held: all pool accounts are held","pace":{"ok":false,"measured":true,"reason":"all pool accounts are held"},"fallbackCodex":{"ok":true,"measured":true,"reason":"scripted room"}}',
        ])
        // Held on both, it latches as an unnamed start does, and the latch keeps the reason.
        const both = yield* start({ now: WEDNESDAY }, { model, others: codexOffered, codex: () => ({ ok: false, measured: true, reason: "5h pace", retryAt: now + 900_000 }), pool: held })
        yield* both.call("subagent", "root", { agent: "planner", model: "claude-opus#high", prompt: "x" })
        expect(both.kept[0]!.context).toEqual({ reason: "model-dropped", models: { primary: "anthropic/claude-opus", fallback: "openai/gpt-6.1-sol#high" } })
      }),
    ))

  test("with no Codex provider, or none offered, a held start latches on Opus as before", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const off = yield* start({ now: WEDNESDAY, codex: false }, { model, others: codexOffered, codex: admits(asked), pool: held })
        expect((yield* off.call("subagent", "root", { agent: "planner", prompt: "x" })).input).toMatchObject({ sessionID: "ses_latched1" })
        const none = yield* start({ now: WEDNESDAY }, { model, codex: admits(asked), pool: held })
        expect((yield* none.call("subagent", "root", { agent: "planner", prompt: "x" })).input).toMatchObject({ sessionID: "ses_latched1" })
        expect(asked).toEqual([])
      }),
    ))

  test("over the Sabbath it latches on Opus, and Codex is never asked", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const friday = yield* start({ now: FRIDAY_EVENING }, { model, others: codexOffered, codex: admits(asked), pool: held })
        const call = yield* friday.call("subagent", "root", { agent: "planner", prompt: "x" })
        expect(call.input).toMatchObject({ model: "anthropic/claude-opus", sessionID: "ses_latched1" })
        expect(friday.kept[0]).toMatchObject({ hold: "sabbath" })
        expect(asked).toEqual([])
      }),
    ))

  test("held on both, it latches on whichever opens first; each open tries Opus before Codex", () =>
    scenario(
      Effect.gen(function* () {
        const kept: Array<LatchAsk & { readonly child: string }> = []
        const codexHeld = (): Pace => ({ ok: false, measured: true, reason: "5h pace", retryAt: now + 300_000 })
        const plugin = yield* start({ now: WEDNESDAY }, { model, others: codexOffered, codex: codexHeld, pool: held, kept })
        const call = yield* plugin.call("subagent", "root", { agent: "planner", description: "plan", prompt: "x" })
        // Codex opens at +5 min, before the pool's +10: the child is made on sol and latched on Codex's hold.
        expect(call.input).toMatchObject({ model: "openai/gpt-6.1-sol#high", sessionID: "ses_latched1" })
        expect(kept[0]).toMatchObject({
          hold: "pace",
          reason: "5h pace",
          subagent: { model: "openai/gpt-6.1-sol#high" },
          context: { reason: "kept", models: { primary: "anthropic/claude-opus", fallback: "openai/gpt-6.1-sol#high" } },
        })
        expect(plugin.logged()[0]).toContain(
          '"fallback":"anthropic/claude-opus held: all pool accounts are held","pace":{"ok":false,"measured":true,"reason":"all pool accounts are held"},"fallbackCodex":{"ok":false,"measured":true,"reason":"5h pace"},"hold":"pace","why":"5h pace"',
        )
        const latch = { kind: "latch", id: "w000001", directory: "/work", setAt: now, ...kept[0]!, child: "ses_latched1" }
        // At its time Claude has room: it opens on Opus, switching the child's model.
        const started: Array<string> = []
        const later = yield* start({ now: WEDNESDAY }, { model, others: codexOffered, codex: codexHeld, started })
        expect(yield* later.open(latch)).toEqual({ outcome: "opened" })
        expect(later.ran[0]!.input).toMatchObject({ model: "anthropic/claude-opus", sessionID: "ses_latched1", background: true })
        expect(started).toEqual(["anthropic"])
        // Claude still held and Codex with room: it opens on Codex.
        const codexStarted: Array<string> = []
        const codexLater = yield* start({ now: WEDNESDAY }, { model, others: codexOffered, codex: admits([]), pool: held, started: codexStarted })
        expect(yield* codexLater.open(latch)).toEqual({ outcome: "opened" })
        expect(codexLater.ran[0]!.input).toMatchObject({ model: "openai/gpt-6.1-sol#high" })
        expect(codexStarted).toEqual(["openai"])
        expect(codexLater.logged()[0]).toContain('"fallback":"anthropic/claude-opus held: all pool accounts are held"')
      }),
    ))
})

describe("the planner's first model", () => {
  const now = Date.parse(WEDNESDAY)
  const model = { providerID: "anthropic", id: "claude-opus" }
  const fable: Offered = { providerID: "anthropic", id: "claude-fable", family: "claude-fable", variants: [{ id: "medium" }, { id: "max" }] }
  const sol: Offered = { providerID: "openai", id: "gpt-6.1-sol", family: "gpt-sol", time: { released: 2 }, variants: [{ id: "high" }] }
  const options = { now: WEDNESDAY, planner: { model: "anthropic/claude-fable" } }
  const room = () => ({ ok: true, measured: true, reason: "scripted room" })
  const line = (logged: ReadonlyArray<string>) => JSON.parse(logged[0]!) as Record<string, unknown>
  const day = 86_400_000
  /** The pool's own pace over one account: room in its 5-hour and weekly windows, and Fable's week `fableUsed`; each ask recorded in `asked`. */
  const fablePool = (fableUsed: number, asked: Array<unknown>): OpenCodePoolPace.Ask => {
    const account: AccountStatus = {
      credentialID: "a",
      load: 0,
      live: 0,
      noRoom: false,
      reading: {
        at: now,
        windows: [
          { name: "5h", utilization: 0.1, resetAt: now + 3_600_000 },
          { name: "7d", utilization: 0.1, resetAt: now + 3 * day },
          { name: "7d:Fable", utilization: fableUsed, resetAt: now + 2 * day },
        ],
      },
    }
    return (input) =>
      Effect.sync(() => {
        asked.push(input)
        return poolPace([account], now, NO_INFLIGHT, input.model)
      })
  }
  const FABLE_SPENT = "anthropic/claude-fable#medium held: every pool account has spent claude-fable's own weekly window"

  test("every new planner start runs on the first model at the planner's effort, whatever its description, and its line names it", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(options, { model, variants: ["medium"], others: [fable, sol] })
        const calls = [
          { agent: "planner", description: "planner billing r1", prompt: "x" },
          { agent: "planner", description: "planner auth r2", prompt: "x" },
          { agent: "planner", description: "Plan the export", prompt: "x" },
          { agent: "planner", prompt: "x" },
          // Described as a planner, asked as the worker: routed to the role, so it is a planner start.
          { agent: "worker", description: "planner search r1", prompt: "x" },
          // Naming the role's own model is naming none.
          { agent: "planner", description: "planner pay r1", model: "anthropic/claude-opus", prompt: "x" },
        ]
        for (const input of calls) expect((yield* plugin.call("subagent", "root", input)).input).toMatchObject({ model: "anthropic/claude-fable#medium" })
        for (const text of plugin.logged()) {
          const started = JSON.parse(text) as Record<string, unknown>
          expect(started).toMatchObject({ agent: "planner", model: "anthropic/claude-fable#medium" })
          expect(started.first).toBeUndefined()
          expect(started.fallback).toBeUndefined()
        }
      }),
    ))

  test("an implementor, a verifier or a worker never starts on the planner's first model, nor its follow-up", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(options, {
          model,
          variants: ["high", "medium"],
          others: [fable, sol],
          sessions: { impl: { parentID: "root", agent: "implementor" }, check: { parentID: "root", agent: "verifier" } },
        })
        const calls = [
          { agent: "implementor", description: "implementor billing r1", prompt: "x" },
          { agent: "verifier", description: "verifier batch-1 r1", prompt: "x" },
          { agent: "worker", description: "implementor auth r1", prompt: "x" },
          { agent: "worker", description: "verifier batch-2 r1", prompt: "x" },
          { agent: "worker", description: "Survey the call sites", prompt: "x" },
          { agent: "general", prompt: "x" },
          { agent: "implementor", description: "implementor billing r2", prompt: "go on", sessionID: "impl" },
          { agent: "verifier", description: "verifier batch-1 r1", prompt: "go on", sessionID: "check" },
        ]
        for (const input of calls) {
          const started = yield* plugin.call("subagent", "root", input)
          expect(String((started.input as Record<string, unknown>).model ?? "")).not.toContain("fable")
        }
        for (const text of plugin.logged()) {
          expect(JSON.parse(text).model ?? "").not.toContain("fable")
          expect(JSON.parse(text).first).toBeUndefined()
        }
      }),
    ))

  test("a resumed planner keeps its child's model, and a planner naming a model of its own runs on it", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(options, { model, variants: ["medium"], others: [fable, sol], sessions: { child: { parentID: "root", agent: "planner" } } })
        const resumed = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r2", prompt: "go on", sessionID: "child" })
        expect(resumed.input).toEqual({ agent: "planner", description: "planner billing r2", prompt: "go on", sessionID: "child" })
        const named = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", model: "openai/gpt-6.1-sol", prompt: "x" })
        expect(named.input).toMatchObject({ model: "openai/gpt-6.1-sol" })
        for (const text of plugin.logged()) expect(JSON.parse(text).first).toBeUndefined()
      }),
    ))

  // The workbox's Ergo root named `model: "anthropic/claude-fable-5-2"` on 11 planner starts (2026-11-12/13): kept as
  // asked, they ran at Fable's default effort, $20.6 a plan against $5 at medium (dream 2026-11-13, candidate 5).
  test("a planner naming its first model, at any variant or none, runs on it at the planner's effort; its line says model-dropped", () =>
    scenario(
      Effect.gen(function* () {
        for (const asked of ["anthropic/claude-fable", "anthropic/claude-fable#max", "anthropic/claude-fable#medium", "claude-fable", "claude-fable#max"]) {
          const plugin = yield* start(options, { model, variants: ["medium"], others: [fable, sol] })
          const call = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", model: asked, prompt: "x" })
          expect(call.input, asked).toMatchObject({ model: "anthropic/claude-fable#medium" })
          expect(line(plugin.logged()), asked).toMatchObject({ agent: "planner", reason: "model-dropped", model: "anthropic/claude-fable#medium" })
        }
      }),
    ))

  test("a planner naming another model with no variant runs it at the planner's effort when that model offers it", () =>
    scenario(
      Effect.gen(function* () {
        const sage: Offered = { providerID: "anthropic", id: "claude-sage", family: "claude-sage", variants: [{ id: "medium" }, { id: "high" }] }
        const plugin = yield* start(options, { model, variants: ["medium"], others: [fable, sol, sage] })
        const bare = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", model: "anthropic/claude-sage", prompt: "x" })
        expect(bare.input).toMatchObject({ model: "anthropic/claude-sage#medium" })
        // A variant it names is kept: the orchestrator chose it.
        const high = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", model: "anthropic/claude-sage#high", prompt: "x" })
        expect(high.input).toMatchObject({ model: "anthropic/claude-sage#high" })
        // Any other role naming a model keeps it as named.
        const verifier = yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier batch-1 r1", model: "anthropic/claude-sage", prompt: "x" })
        expect(verifier.input).toMatchObject({ model: "anthropic/claude-sage" })
      }),
    ))

  test("a host offering the first model without the planner's effort starts the planner on Opus at it, and its line says why", () =>
    scenario(
      Effect.gen(function* () {
        const noMedium: Offered = { ...fable, variants: [{ id: "high" }, { id: "max" }] }
        for (const asked of [{}, { model: "anthropic/claude-fable" }]) {
          const plugin = yield* start(options, { model, variants: ["medium"], others: [noMedium, sol] })
          const call = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x", ...asked })
          expect(call.input).toMatchObject({ model: "anthropic/claude-opus#medium" })
          expect(line(plugin.logged())).toMatchObject({
            model: "anthropic/claude-opus#medium",
            first: { model: "anthropic/claude-fable", fellBack: "anthropic/claude-fable offers no medium" },
          })
        }
      }),
    ))

  test("every new planner start carries the planner's effort, or its line names why it could not: over what it names and what the host offers", () =>
    scenario(
      Effect.gen(function* () {
        const offers: ReadonlyArray<ReadonlyArray<string>> = [["medium", "max"], ["max"], [], ["low", "medium", "high", "xhigh", "max"]]
        const names = ["", "anthropic/claude-opus", "anthropic/claude-opus#max", "anthropic/claude-fable", "anthropic/claude-fable#high", "claude-fable"]
        const onFable = { model: "anthropic/claude-fable#medium" }
        const onOpus = { model: "anthropic/claude-opus#medium", first: { model: "anthropic/claude-fable", fellBack: "anthropic/claude-fable offers no medium" } }
        for (const variants of offers)
          for (const asked of names) {
            const host: Offered = { ...fable, variants: variants.map((id) => ({ id })) }
            const plugin = yield* start(options, { model, variants: ["medium"], others: [host, sol] })
            // An empty model is no model.
            const call = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x", model: asked })
            const at = `"${asked}" on a Fable offering [${variants.join(",")}]`
            const ran = Option.match(Option.liftPredicate(variants, (offered) => offered.includes("medium")), { onNone: () => onOpus, onSome: () => onFable })
            expect(call.input, at).toMatchObject({ model: ran.model })
            expect(line(plugin.logged()), at).toMatchObject(ran)
          }
      }),
    ))

  test("the account's Fable week is spent and its main windows are free: the planner starts on Opus, and its line says why", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<unknown> = []
        const plugin = yield* start(options, { model, variants: ["medium"], others: [fable, sol], poolAsk: fablePool(1, asked), codex: room })
        const planner = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x" })
        expect(planner.input).toMatchObject({ model: "anthropic/claude-opus#medium" })
        const started = line(plugin.logged())
        expect(started).toMatchObject({
          model: "anthropic/claude-opus#medium",
          pace: { ok: true, measured: true },
          first: { model: "anthropic/claude-fable", fellBack: FABLE_SPENT },
        })
        expect(started.fallback).toBeUndefined()
        // The pool is asked of each model by its bare id, as its windows name models, from the session whose start would wait.
        expect(asked).toEqual([
          { providerID: "anthropic", model: "claude-fable", sessionID: "root" },
          { providerID: "anthropic", model: "claude-opus", sessionID: "root" },
        ])
      }),
    ))

  test("Fable and Opus both held: the planner starts on sol, and its line says why it left each", () =>
    scenario(
      Effect.gen(function* () {
        const held = { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 600_000 } }
        const plugin = yield* start(options, { model, variants: ["medium"], others: [fable, sol], pool: held, codex: room })
        const planner = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x" })
        expect(planner.input).toMatchObject({ model: "openai/gpt-6.1-sol#high" })
        expect(line(plugin.logged())).toMatchObject({
          model: "openai/gpt-6.1-sol#high",
          fallback: "anthropic/claude-opus#medium held: all pool accounts are held",
          first: { model: "anthropic/claude-fable", fellBack: "anthropic/claude-fable#medium held: all pool accounts are held" },
        })
      }),
    ))

  test("all three held: the planner latches on Opus with its Codex fallback, and the latch keeps why it left Fable for the line its open writes", () =>
    scenario(
      Effect.gen(function* () {
        const held = { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 600_000 } }
        const codexHeld = () => ({ ok: false, measured: true, reason: "codex week spent", retryAt: now + 900_000 })
        const plugin = yield* start(options, { model, variants: ["medium"], others: [fable, sol], pool: held, codex: codexHeld })
        yield* plugin.call("subagent", "root", { agent: "planner", description: "planner auth r1", prompt: "x" })
        const first = { model: "anthropic/claude-fable", fellBack: "anthropic/claude-fable#medium held: all pool accounts are held" }
        expect(plugin.kept[0]!.context).toEqual({ reason: "kept", models: { primary: "anthropic/claude-opus#medium", fallback: "openai/gpt-6.1-sol#high" }, first })
        expect(line(plugin.logged())).toMatchObject({ kind: "latched", model: "anthropic/claude-opus#medium", first })
        // Opus opens first: the open starts it there, and its line keeps why it left Fable.
        const later = yield* start(options, { model, variants: ["medium"], others: [fable, sol], codex: codexHeld })
        const latch = { kind: "latch", id: "w000001", directory: "/work", setAt: now, ...plugin.kept[0]!, child: "ses_latched1" }
        expect(yield* later.open(latch)).toEqual({ outcome: "opened" })
        expect(line(later.logged())).toMatchObject({ kind: "call", model: "anthropic/claude-opus#medium", first })
      }),
    ))

  test("over the Sabbath a planner latches on its first model until work resumes, as every role latches on its own: no pace asked, never moved to Opus", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<unknown> = []
        const codexAsked: Array<string> = []
        // Fable's week is spent too: still no pace is asked, and the planner is not moved to Opus.
        const friday = yield* start(
          { ...options, now: FRIDAY_EVENING },
          { model, variants: ["medium"], others: [fable, sol], poolAsk: fablePool(1, asked), codex: (id) => (codexAsked.push(id), room()) },
        )
        const call = yield* friday.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x" })
        expect(call.input).toMatchObject({ model: "anthropic/claude-fable#medium", sessionID: "ses_latched1" })
        expect(friday.kept[0]).toMatchObject({ hold: "sabbath", subagent: { model: "anthropic/claude-fable#medium" }, context: { reason: "kept" } })
        expect(friday.kept[0]!.context).toEqual({ reason: "kept" })
        const latched = line(friday.logged())
        expect(latched).toMatchObject({ kind: "latched", agent: "planner", model: "anthropic/claude-fable#medium", hold: "sabbath" })
        expect(latched.first).toBeUndefined()
        expect(latched.fallback).toBeUndefined()
        expect(asked).toEqual([])
        expect(codexAsked).toEqual([])
        // An implementor and a verifier latch on their own model the same way.
        for (const [agent, description] of [["implementor", "implementor billing r1"], ["verifier", "verifier batch-1 r1"]] as const) {
          const role = yield* friday.call("subagent", "root", { agent, description, prompt: "x" })
          expect(role.refused, String(role.refused?.message)).toBeUndefined()
          expect(role.input).toMatchObject({ model: "anthropic/claude-opus#medium" })
        }
        expect(friday.kept.map((kept) => kept.hold)).toEqual(["sabbath", "sabbath", "sabbath"])
        expect(asked).toEqual([])
      }),
    ))

  test("once work resumes, a planner latched over the Sabbath opens on its first model, or takes the chain (Opus, then sol) when the pool holds it", () =>
    scenario(
      Effect.gen(function* () {
        const friday = yield* start({ ...options, now: FRIDAY_EVENING }, { model, variants: ["medium"], others: [fable, sol] })
        yield* friday.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x" })
        const latch = { kind: "latch", id: "w000001", directory: "/work", setAt: now, ...friday.kept[0]!, child: "ses_latched1" }
        // Fable has room: it opens on Fable, with nothing to explain.
        const free = yield* start(options, { model, variants: ["medium"], others: [fable, sol], poolAsk: fablePool(0.2, []), codex: room })
        expect(yield* free.open(latch)).toEqual({ outcome: "opened" })
        expect(free.ran[0]!.input).toMatchObject({ model: "anthropic/claude-fable#medium", sessionID: "ses_latched1" })
        expect(line(free.logged())).toMatchObject({ kind: "call", model: "anthropic/claude-fable#medium" })
        expect(line(free.logged()).first).toBeUndefined()
        // Fable's week spent: it opens on Opus at the planner's effort, and the line says why.
        const spent = yield* start(options, { model, variants: ["medium"], others: [fable, sol], poolAsk: fablePool(1, []), codex: room })
        expect(yield* spent.open(latch)).toEqual({ outcome: "opened" })
        expect(spent.ran[0]!.input).toMatchObject({ model: "anthropic/claude-opus#medium" })
        expect(line(spent.logged())).toMatchObject({ kind: "call", model: "anthropic/claude-opus#medium", first: { model: "anthropic/claude-fable", fellBack: FABLE_SPENT } })
        // Fable and Opus held, Codex with room: it opens on sol.
        const held = { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 600_000 } }
        const both = yield* start(options, { model, variants: ["medium"], others: [fable, sol], pool: held, codex: room })
        expect(yield* both.open(latch)).toEqual({ outcome: "opened" })
        expect(both.ran[0]!.input).toMatchObject({ model: "openai/gpt-6.1-sol#high" })
        expect(line(both.logged())).toMatchObject({
          model: "openai/gpt-6.1-sol#high",
          fallback: "anthropic/claude-opus#medium held: all pool accounts are held",
          first: { model: "anthropic/claude-fable", fellBack: "anthropic/claude-fable#medium held: all pool accounts are held" },
        })
      }),
    ))

  test("a Sabbath planner latch rechecked while the Sabbath still holds latches again on Fable: no pace asked, never moved to Opus", () =>
    scenario(
      Effect.gen(function* () {
        const friday = yield* start({ ...options, now: FRIDAY_EVENING }, { model, variants: ["medium"], others: [fable, sol] })
        yield* friday.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x" })
        const latch = { kind: "latch", id: "w000001", directory: "/work", setAt: now, ...friday.kept[0]!, child: "ses_latched1" }
        const asked: Array<unknown> = []
        const codexAsked: Array<string> = []
        const still = yield* start(
          { ...options, now: FRIDAY_EVENING },
          { model, variants: ["medium"], others: [fable, sol], poolAsk: fablePool(1, asked), codex: (id) => (codexAsked.push(id), room()) },
        )
        expect(yield* still.open(latch)).toMatchObject({ outcome: "held", hold: "sabbath" })
        expect(still.ran).toEqual([])
        const relatched = line(still.logged())
        expect(relatched).toMatchObject({ kind: "latched", agent: "planner", model: "anthropic/claude-fable#medium", hold: "sabbath" })
        expect(relatched.first).toBeUndefined()
        expect(relatched.fallback).toBeUndefined()
        expect(asked).toEqual([])
        expect(codexAsked).toEqual([])
      }),
    ))

  test("a host that does not offer the first model starts the planner on Opus, saying so", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(options, { model, variants: ["medium"] })
        const call = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x" })
        expect(call.input).toMatchObject({ model: "anthropic/claude-opus#medium" })
        expect(line(plugin.logged())).toMatchObject({ first: { model: "anthropic/claude-fable", fellBack: "anthropic/claude-fable is not offered" } })
      }),
    ))

  test("with no first model set, every planner starts on the role's own model and no line names one", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: [fable] })
        const call = yield* plugin.call("subagent", "root", { agent: "planner", description: "planner billing r1", prompt: "x" })
        expect(call.input).toMatchObject({ model: "anthropic/claude-opus#medium" })
        expect(line(plugin.logged()).first).toBeUndefined()
      }),
    ))
})

describe("the units' logs", () => {
  /** A scratch checkout, removed with the test's scope. */
  const checkout = Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "orchestrate-checkout-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  /** A unit's moves, without their times. */
  const moves = (dir: string) =>
    existsSync(join(dir, "log.md"))
      ? readFileSync(join(dir, "log.md"), "utf8")
          .trim()
          .split("\n")
          .map((line) => line.replace(/^\S+Z /, ""))
      : []

  test("a planner's and an implementor's start and hand-back move its unit in the run's log, once each; a verifier's move nothing", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* checkout
        const auth = join(work, "tmp/orchestrate/web/auth")
        mkdirSync(auth, { recursive: true })
        writeFileSync(join(work, "tmp/orchestrate/web/plan.md"), "")
        const handBack = (role: string, line: string) => ({ parentID: "root", agent: role, directory: work, lastWords: `${line}\nGate green; the request names the head.` })
        const plugin = yield* start(
          { now: WEDNESDAY },
          {
            sessions: {
              root: { directory: work },
              planner: handBack("planner", `planner auth r1: ready ${auth}/spec.md`),
              implementor: handBack("implementor", `implementor auth r1: ready ${auth}/round-1-request.md`),
              verifier: handBack("verifier", `verifier auth r1: changes ${auth}/round-1-findings.md`),
              worker: handBack("worker", `implementor auth r1: blocked ${auth}/blocked.md`),
              busy: { parentID: "root", agent: "implementor", directory: work, lastWords: "Running the gate now." },
              lead: { agent: "implementor", directory: work, lastWords: `implementor auth r2: blocked ${auth}/blocked.md` },
            },
          },
        )
        // The planner's prompt names the unit dir; the implementor's names none, so the checkout's runs are searched.
        yield* plugin.call("subagent", "root", { agent: "planner", description: "planner auth r1", prompt: `Write ${auth}/spec.md from the template.` })
        yield* plugin.idle("planner")
        yield* plugin.call("subagent", "root", { agent: "implementor", description: "implementor auth r1", prompt: "Build the spec." })
        yield* plugin.idle("busy")
        yield* plugin.idle("implementor")
        // A verifier verifies a batch: neither its start nor its hand-back moves a unit.
        yield* plugin.call("subagent", "root", { agent: "general", description: "verifier auth r1", prompt: `Verify ${auth}/round-1-request.md.` })
        yield* plugin.idle("verifier")
        yield* plugin.idle("verifier")
        // Neither a main session, even one running as a role, nor a worker moves a unit, whatever it writes.
        yield* plugin.idle("root")
        yield* plugin.idle("lead")
        yield* plugin.idle("worker")
        // A worker call described as a step runs as that role (role.ts), so its start moves the unit as the
        // role's would: back to implement r1, as when a refused request goes back to its implementor.
        yield* plugin.call("subagent", "root", { agent: "worker", description: "implementor auth r1", prompt: "x" })
        // The next round, after its batch's verifier asked for changes, moves it on to r2.
        yield* plugin.call("subagent", "root", { sessionID: "implementor", description: "implementor auth r2", prompt: `Fix ${auth}/round-1-findings.md.` })
        expect(moves(auth)).toEqual([
          "new → plan r1",
          "plan → implement r1 spec.md",
          "implement → ready r1 round-1-request.md ready",
          "ready → implement r1 spec.md",
          "implement → implement r2 round-1-findings.md",
        ])
      }),
    ))

  test("a start whose unit dir is not found, or names no round, writes nothing and runs as ever", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* checkout
        const elsewhere = join(work, "notes/auth")
        for (const run of ["web", "api"]) {
          mkdirSync(join(work, "tmp/orchestrate", run, "auth"), { recursive: true })
          writeFileSync(join(work, "tmp/orchestrate", run, "plan.md"), "")
        }
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: { root: { directory: work } } })
        // Two runs hold an `auth` unit: the search finds none.
        const call = yield* plugin.call("subagent", "root", { agent: "implementor", description: "implementor auth r1", prompt: "x" })
        expect(call).toEqual({ refused: undefined, input: { agent: "implementor", description: "implementor auth r1", prompt: "x" } })
        yield* plugin.call("subagent", "root", { agent: "implementor", description: "implementor auth", prompt: `Build ${elsewhere}/spec.md` })
        for (const dir of ["tmp/orchestrate/web/auth", "tmp/orchestrate/api/auth", "notes/auth"]) expect(existsSync(join(work, dir, "log.md"))).toBe(false)
        // A directory named for the unit that holds no spec.md, log.md or run's plan.md is no unit dir.
        mkdirSync(elsewhere, { recursive: true })
        yield* plugin.call("subagent", "root", { agent: "implementor", description: "implementor auth r1", prompt: `Build ${elsewhere}/spec.md` })
        expect(existsSync(join(elsewhere, "log.md"))).toBe(false)
        // A path the prompt names finds it once it holds the unit's spec.
        writeFileSync(join(elsewhere, "spec.md"), "")
        yield* plugin.call("subagent", "root", { agent: "implementor", description: "implementor auth r1", prompt: `Build ${elsewhere}/spec.md` })
        expect(moves(elsewhere)).toEqual(["new → implement r1 spec.md"])
      }),
    ))

  test("an implementor started in a Rift named like its unit, with no unit dir, writes no log.md into the Rift", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* checkout
        const rift = join(work, ".rifts/dotfiles/land-fixes")
        mkdirSync(rift, { recursive: true })
        writeFileSync(join(rift, "README.md"), "")
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: { root: { directory: rift } } })
        yield* plugin.call("subagent", "root", {
          agent: "implementor",
          description: "implementor land-fixes r1",
          prompt: `You work in the Rift ${rift}. Commit there.`,
        })
        expect(existsSync(join(rift, "log.md"))).toBe(false)
      }),
    ))

  test("a latched role moves its unit when its latch opens and it starts, not when it latches", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* checkout
        const auth = join(work, "tmp/orchestrate/web/auth")
        mkdirSync(auth, { recursive: true })
        writeFileSync(join(work, "tmp/orchestrate/web/plan.md"), "")
        const now = Date.parse(WEDNESDAY)
        const model = { providerID: "anthropic", id: "claude" }
        const held = { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 600_000 } }
        const kept: Array<LatchAsk & { readonly child: string }> = []
        const sessions = { root: { directory: work } }
        const plugin = yield* start({ now: WEDNESDAY }, { model, pool: held, kept, sessions })
        yield* plugin.call("subagent", "root", { agent: "planner", description: "planner auth r1", prompt: "Plan it." })
        expect(moves(auth)).toEqual([])
        const later = yield* start({ now: WEDNESDAY }, { model, sessions })
        const latch = { kind: "latch", id: "w000001", directory: work, setAt: now, ...kept[0]!, child: kept[0]!.child }
        expect(yield* later.open(latch)).toEqual({ outcome: "opened" })
        expect(moves(auth)).toEqual(["new → plan r1"])
      }),
    ))
})

describe("an idle root with units to move or a batch to land", () => {
  const LINE = "idle with units in plan, implement or verify: closure-flake, pkg-lower; start them or name what you wait on."
  const world = {
    sessions: { root: {}, child: { parentID: "root" } },
    steps: { root: ["closure-flake"] },
    runs: [
      {
        name: "p5",
        units: [
          { unit: "closure-flake", state: "implement" },
          { unit: "pkg-lower", state: "plan" },
          { unit: "parser", state: "merged abc1234" },
        ],
      },
      { name: "theirs", units: [{ unit: "audio", state: "plan" }] },
    ],
  }

  test("is steered once with one marked line; going idle again does not nudge again until new input", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, world)
        yield* plugin.idle("root")
        yield* eventually(() =>
          expect(plugin.nudges).toEqual([{ sessionID: "root", text: LINE, description: LINE, metadata: { [MARK]: true }, delivery: "steer", resume: true }]),
        )
        // The nudge's own arrival is not new input; the root answers it and goes idle again.
        yield* plugin.enqueue("root", { type: "synthetic", metadata: { [MARK]: true } })
        yield* plugin.idle("root")
        yield* settle
        expect(plugin.nudges).toHaveLength(1)
        // A worker's notice or the owner's prompt is new input: the next idle period nudges again.
        yield* plugin.enqueue("root", { type: "synthetic", metadata: { other: true } })
        yield* settle
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.nudges).toHaveLength(2))
        yield* plugin.enqueue("root", { type: "user" })
        yield* settle
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.nudges).toHaveLength(3))
      }),
    ))

  test("ready units from the status plugin: their batch, due by count or by the oldest's log time (each unit's own cadence when it has one), is landed by each unit's Rift; short of both, no nudge", () =>
    scenario(
      Effect.gen(function* () {
        const ready = (units: ReadonlyArray<{ readonly unit: string; readonly since?: string; readonly cadence?: string }>) =>
          start({ now: WEDNESDAY }, { ...world, runs: [{ name: "p5", units: [{ unit: "closure-flake", state: "merged abc1234" }, ...units.map((unit) => ({ ...unit, state: "ready" }))] }] })
        const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 16) + "Z"
        const three = yield* ready([{ unit: "lexer" }, { unit: "parser" }, { unit: "docs" }])
        const old = yield* ready([{ unit: "lexer", since: minutesAgo(45) }])
        const fresh = yield* ready([{ unit: "lexer", since: minutesAgo(5) }, { unit: "parser" }])
        // A unit's own cadence, as the status script prints it from its spec: one ready lands at once; a longer wait holds.
        const hot = yield* ready([{ unit: "hotfix", since: minutesAgo(5), cadence: "1 ready or 30 min" }])
        const slow = yield* ready([{ unit: "lexer", since: minutesAgo(45), cadence: "3 ready or 60 min" }])
        for (const plugin of [three, old, fresh, hot, slow]) yield* plugin.idle("root")
        yield* eventually(() =>
          expect(hot.nudges.map((nudge) => nudge.text)).toEqual([
            'idle with a batch due (1 ready): hotfix; land it with rift({ action: "land", rifts: ["p5/hotfix"] }).',
          ]),
        )
        yield* eventually(() =>
          expect(three.nudges.map((nudge) => nudge.text)).toEqual([
            'idle with a batch due (3 ready): lexer, parser, docs; land it with rift({ action: "land", rifts: ["p5/lexer", "p5/parser", "p5/docs"] }).',
          ]),
        )
        // The log's time is to the minute, so the age is 45 or, across a minute's turn, 46.
        yield* eventually(() =>
          expect(old.nudges.map((nudge) => nudge.text)).toEqual([
            expect.stringMatching(/^idle with a batch due \(lexer ready 4[56] min\): lexer; land it with rift\(\{ action: "land", rifts: \["p5\/lexer"\] \}\)\.$/),
          ]),
        )
        expect(fresh.nudges).toEqual([])
        expect(slow.nudges).toEqual([])
      }),
    ))

  test("a subagent's session, work still running, the Sabbath, or a run that is not its: no nudge", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, world)
        yield* plugin.idle("child")
        yield* plugin.idle("root", [{ kind: "shell", sessionID: "root", shellID: "sh_1", command: "bun test" }])
        const stranger = yield* start({ now: WEDNESDAY }, { ...world, steps: { root: ["audio-x"] } })
        yield* stranger.idle("root")
        const friday = yield* start({ now: FRIDAY_EVENING }, world)
        yield* friday.idle("root")
        yield* settle
        expect([plugin.nudges, stranger.nudges, friday.nudges]).toEqual([[], [], []])
      }),
    ))

  test("a wake, a question to the owner or a named wait holds it", () =>
    scenario(
      Effect.gen(function* () {
        const held = (holds: Partial<Holds>) => start({ now: WEDNESDAY }, { ...world, holds: { root: { ...NO_HOLDS, ...holds } } })
        const plugins = [yield* held({ wakes: 1 }), yield* held({ questions: 1 }), yield* held({ needsYou: ["Pick a format"] }), yield* held({ waits: ["owner review"] })]
        for (const plugin of plugins) yield* plugin.idle("root")
        yield* settle
        expect(plugins.map((plugin) => plugin.nudges.length)).toEqual([0, 0, 0, 0])
      }),
    ))

  test("while the owner drafts to it, it waits; a draft that ends with no input nudges it, one that is sent does not", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, world)
        expect(yield* plugin.draft({ sessionID: "root", client: "tui-1", drafting: true })).toEqual({ ok: true })
        yield* plugin.idle("root")
        yield* settle
        expect(plugin.nudges).toEqual([])
        yield* plugin.draft({ sessionID: "root", client: "tui-1", drafting: false })
        yield* Effect.sleep(RECHECK_MS / 2)
        expect(plugin.nudges).toEqual([])
        yield* eventually(() => expect(plugin.nudges.map((nudge) => nudge.text)).toEqual([LINE]))

        const sent = yield* start({ now: WEDNESDAY }, world)
        yield* sent.draft({ sessionID: "root", client: "tui-1", drafting: true })
        yield* sent.idle("root")
        yield* sent.draft({ sessionID: "root", client: "tui-1", drafting: false })
        yield* sent.enqueue("root", { type: "user" })
        yield* Effect.sleep(RECHECK_MS + 200)
        expect(sent.nudges).toEqual([])
        // A report that is not one is refused without a word.
        expect(yield* sent.draft({ sessionID: "root" })).toEqual({ ok: false })
      }),
    ))

  test("a nudge the host refuses is not tried again in that idle period", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { ...world, refuseNudge: "session busy" })
        yield* plugin.idle("root")
        yield* plugin.idle("root")
        yield* settle
        expect(plugin.nudges).toEqual([])
      }),
    ))
})

describe("a root whose run saw an older skill", () => {
  const DIR = "/repo/tmp/orchestrate/p5"
  const history = (count: number) => Array.from({ length: count }, (_, n) => ({ hash: `${n}`.repeat(40), subject: `feat(orchestrate): change ${n}` }))
  const world = (seen: string | undefined, departures: ReadonlyArray<string> = []) => ({
    sessions: { root: {}, child: { parentID: "root" } },
    steps: { root: ["lexer"] },
    runs: [{ name: "p5", dir: DIR, units: [{ unit: "lexer", state: "merged abc1234" }] }],
    skill: { history: history(3) },
    records: { seen: new Map(seen === undefined ? [] : [[DIR, seen]]), departures: { [DIR]: departures } },
  })

  test("a newer skill: one note with the commit subjects since, newest first, and the run's departures; the run then records the new version", () =>
    scenario(
      Effect.gen(function* () {
        const state = world("0".repeat(40), ["common.md:12: Departs from Heavy checks fit the machine: benchmarks need the whole box"])
        const plugin = yield* start({ now: WEDNESDAY }, state)
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.notes).toHaveLength(1))
        const [note] = plugin.notes
        expect(note).toMatchObject({ sessionID: "root", metadata: { [DRIFT_MARK]: true }, delivery: "steer", resume: true })
        expect(note?.text).toBe(
          [
            "The orchestrate skill changed since run p5 saw it (0000000..2222222, 2 commits):",
            "- feat(orchestrate): change 2",
            "- feat(orchestrate): change 1",
            "Run p5's departures, to check against these changes:",
            "- common.md:12: Departs from Heavy checks fit the machine: benchmarks need the whole box",
            RECONCILE,
          ].join("\n"),
        )
        expect(note?.description).toBe("orchestrate skill changed since p5 saw it: reconcile the run's rules files")
        expect(state.records.seen.get(DIR)).toBe("2".repeat(40))
        // The idle nudge is its own: the run holds nothing to move, so none came.
        expect(plugin.nudges).toEqual([])
      }),
    ))

  test("the same skill: no note", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, world("2".repeat(40)))
        yield* plugin.idle("root")
        yield* settle
        expect(plugin.notes).toEqual([])
      }),
    ))

  test("idle twice, or twice at once, on one newer version: one note; the next version brings one more", () =>
    scenario(
      Effect.gen(function* () {
        const state = world("1".repeat(40))
        const plugin = yield* start({ now: WEDNESDAY }, state)
        yield* Effect.all([plugin.idle("root"), plugin.idle("root")], { concurrency: "unbounded" })
        yield* eventually(() => expect(plugin.notes).toHaveLength(1))
        yield* plugin.idle("root")
        yield* settle
        expect(plugin.notes).toHaveLength(1)
        expect(plugin.notes[0]?.text).toStartWith("The orchestrate skill changed since run p5 saw it (1111111..2222222, 1 commit):\n- feat(orchestrate): change 2\n")
        state.skill.history.push({ hash: "3".repeat(40), subject: "fix(orchestrate): change 3" })
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.notes).toHaveLength(2))
        expect(plugin.notes[1]?.text).toStartWith("The orchestrate skill changed since run p5 saw it (2222222..3333333, 1 commit):\n- fix(orchestrate): change 3\n")
      }),
    ))

  test("a run never seen records its version silently; a subagent, a run not its own, an older skill or the Sabbath: no note", () =>
    scenario(
      Effect.gen(function* () {
        const fresh = world(undefined)
        const first = yield* start({ now: WEDNESDAY }, fresh)
        yield* first.idle("root")
        yield* eventually(() => expect(fresh.records.seen.get(DIR)).toBe("2".repeat(40)))
        const behind = world("0".repeat(40))
        const child = yield* start({ now: WEDNESDAY }, behind)
        yield* child.idle("child")
        const stranger = yield* start({ now: WEDNESDAY }, { ...behind, steps: { root: ["audio"] } })
        yield* stranger.idle("root")
        // The checkout moved back: the installed version is older than the one the run saw.
        const ahead = { ...world("2".repeat(40)), skill: { history: history(3), installed: "1".repeat(40) } }
        const older = yield* start({ now: WEDNESDAY }, ahead)
        yield* older.idle("root")
        const friday = yield* start({ now: FRIDAY_EVENING }, behind)
        yield* friday.idle("root")
        yield* settle
        expect([first.notes, child.notes, stranger.notes, older.notes, friday.notes]).toEqual([[], [], [], [], []])
        expect(behind.records.seen.get(DIR)).toBe("0".repeat(40))
        expect(ahead.records.seen.get(DIR)).toBe("2".repeat(40))
      }),
    ))

  test("a note the host refuses is not recorded, so the next idle tries again", () =>
    scenario(
      Effect.gen(function* () {
        const state = world("0".repeat(40))
        const plugin = yield* start({ now: WEDNESDAY }, { ...state, refuseNudge: "session busy" })
        yield* plugin.idle("root")
        yield* settle
        expect(state.records.seen.get(DIR)).toBe("0".repeat(40))
      }),
    ))
})

describe("the agents", () => {
  test("each role gets its definition, each role and primary agent the 400k window; compaction keeps the files", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY })
        const agents: Record<string, EditedAgent> = {}
        for (const [id, mode] of [["build", "primary"], ["explore", "subagent"], ["planner", "subagent"], ["worker", "subagent"]] as const)
          agents[id] = { id, mode, permissions: [], request: { settings: {} } }
        agents.hidden = { id: "hidden", mode: "primary", hidden: true, permissions: [], request: { settings: {} } }
        const editor = {
          list: () => Object.values(agents),
          update: (id: string, edit: (agent: EditedAgent) => void) => {
            const agent = agents[id]
            if (agent) edit(agent)
          },
        }
        expect(plugin.transforms).toHaveLength(1)
        plugin.transforms[0]!(editor)
        expect(agents.build!.request.settings.compactionWindow).toBe(400_000)
        expect(agents.hidden!.request.settings.compactionWindow).toBeUndefined()
        expect(agents.explore!.request.settings.compactionWindow).toBeUndefined()
        expect(agents.planner).toMatchObject({
          description: definitions.planner.description,
          system: definitions.planner.system,
          mode: "subagent",
          permissions: definitions.planner.permissions,
          request: { settings: { compactionWindow: 400_000, cacheTTL: "5m" } },
        })
        expect(agents.worker!.request.settings.compactionWindow).toBe(400_000)
        // Roles cache for five minutes; the main agent keeps the provider's lifetime.
        expect(agents.worker!.request.settings.cacheTTL).toBe("5m")
        expect(agents.build!.request.settings.cacheTTL).toBeUndefined()

        // The keep-list follows the conversation as a user message, leaving the system and the messages before it (and
        // so the cached prefix) as they were.
        const system: Array<unknown> = []
        const conversation = [{ role: "user", content: [{ type: "text", text: "Fix the parser." }] }]
        const messages: Array<unknown> = [...conversation]
        for (const hook of plugin.hooks.compaction ?? []) yield* hook({ system, messages })
        expect(system).toEqual([])
        expect(messages).toEqual([...conversation, { role: "user", content: [{ type: "text", text: KEEP }] }])
      }),
    ))
})

describe("the batch machine", () => {
  /** A root's step sessions: each a role's child of `root`, with the hand-back it ends on. */
  const steps = (said: Readonly<Record<string, { readonly agent: string; readonly lastWords?: string; readonly stopped?: boolean }>>) => ({
    root: {},
    ...Object.fromEntries(Object.entries(said).map(([id, session]) => [id, { parentID: "root", ...session }])),
  })
  const implementor = (unit: string) => ({ agent: "implementor", description: `implementor ${unit} r1`, prompt: "go", background: true })
  type Plugin = Effect.Success<ReturnType<typeof start>>
  /** A background step started and answered with its child, as the host does. */
  const begin = (plugin: Plugin, input: Record<string, unknown>, child: string) =>
    Effect.gen(function* () {
      const called = yield* plugin.call("subagent", "root", input)
      expect(called.refused).toBeUndefined()
      yield* plugin.finish({ input, status: "completed", result: { metadata: { sessionID: child, status: "running" } } })
    })
  const kinds = (plugin: Plugin) => plugin.ledger.map((line) => (line as { kind: string }).kind)
  /** A seeded stream in [0, 1), so a failing trial names its seed. */
  const rngOf = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** A scratch run dir, removed with the test's scope. */
  const scratchRun = Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "orchestrate-run-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  /** A run's drops journal: where log.ts, run from the root's shell, writes each drop, and the plugin reads them. */
  const journalOf = (run: string) => join(run, "drops.jsonl")
  /**
   * A shell line run for real in `cwd`: its output, both streams, as the shell tool answers with it. Run as the
   * root's (`spawnRoot`), it has the session and the run's journal the host and the plugin give it; otherwise no
   * session, so a test run from an OpenCode shell never writes the owner's journal.
   */
  const spawnShell = (line: string, cwd: string) => {
    const ran = spawnSync(["/usr/bin/env", "-u", "OPENCODE_SESSION_ID", "/bin/zsh", "-c", line], { cwd })
    return `${ran.stdout}${ran.stderr}`
  }
  const spawnRoot = (line: string, cwd: string, journal: string) => {
    const ran = spawnSync(["/usr/bin/env", "OPENCODE_SESSION_ID=root", `ORCHESTRATE_DROPS=${journal}`, "/bin/zsh", "-c", line], { cwd })
    return `${ran.stdout}${ran.stderr}`
  }
  /** `unit`'s dir in `run`, its log moved by the skill's log.ts (`new decide r1`). */
  const logged = (run: string, unit: string, move: string) => {
    mkdirSync(join(run, unit), { recursive: true })
    spawnShell(`bun ${LOG_SCRIPT} ${join(run, unit)} ${move}`, run)
  }
  /** The root's shell call, run for real in `cwd` (the call's `workdir`, when its input names one), through the plugin's hooks. */
  const shell = (plugin: Plugin, input: { readonly command: string; readonly workdir?: string }, cwd: string, journal: string) =>
    plugin.finish({ tool: "shell", input, status: "completed", result: { content: [{ type: "text", text: spawnRoot(input.command, cwd, journal) }] } })

  test("a verifier for one unit is refused in the skill's words before anything starts; the batch's starts", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready /u/alpha/round-1-request.md" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        const lines = plugin.logged().length
        const refused = yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier alpha r1", prompt: "verify" })
        expect(refused.refused?.message).toContain(RULES.VerifierPerUnit.words)
        expect(refused.refused?.message).toContain("verifier batch-<k> r1")
        expect(refused.refused?.message).toContain("(departs: <why>)")
        // Nothing of the refused call: no line, no latch, no rewritten input.
        expect(plugin.logged()).toHaveLength(lines)
        expect(plugin.kept).toEqual([])
        expect(kinds(plugin)).toEqual(["UnitStarted", "StepSpawned", "UnitHandedBack", "Refused"])
        const batch = yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier batch-1 r1", prompt: "verify" })
        expect(batch.refused).toBeUndefined()
        expect(plugin.ledger.at(-1)).toMatchObject({ kind: "VerifierStarted", batch: "batch-1", units: ["alpha"] })
      }),
    ))

  test("a departure stated in the description passes and is recorded", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        const departed = yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier alpha r1 (departs: the owner asked)", prompt: "v" })
        expect(departed.refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "Departed", rule: "VerifierPerUnit", why: "the owner asked" }))
      }),
    ))

  test("one kernel cell starting an implementor and landing at once: the land is decided after the start, and waits", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        const [started, landed] = yield* Effect.all(
          [plugin.call("subagent", "root", implementor("beta")), plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })],
          { concurrency: "unbounded" },
        )
        expect(started.refused).toBeUndefined()
        expect(landed.refused?.message).toContain(RULES.BatchNotDue.words)
        expect(landed.refused?.message).toContain('departs: "<why>"')
      }),
    ))

  test("a dead implementor and a dead verifier hold nothing: each is handed back as none before the next decision", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_a")
        // beta's session runs no turn and keeps nothing: it died. The land of alpha alone passes.
        expect((yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })).refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "UnitHandedBack", unit: "beta", ready: false }))
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed 1 Rift(s) as one push" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        // The verifier died with no hand-back: the next batch's verifier starts all the same.
        expect((yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier batch-2 r1", prompt: "v" })).refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "VerifierEnded", batch: "batch-1", verdict: "none" }))
      }),
    ))

  test("subagent-handle: the live sessions read a session whose last turn was interrupted as stopped, and no other", () => {
    const fresh: StepHostSession = { time: {}, location: { directory: "/work" } }
    const ended = (outcome: "succeeded" | "failed" | "interrupted"): StepHostSession => ({ ...fresh, outcome })
    expect(stepSessionOf(ended("interrupted"))).toEqual({ started: true, stopped: true, directory: "/work" })
    expect(stepSessionOf(ended("succeeded"))).toEqual({ started: true, stopped: false, directory: "/work" })
    expect(stepSessionOf(ended("failed")).stopped).toBe(false)
    expect(stepSessionOf(fresh)).toEqual({ started: false, stopped: false, directory: "/work" })
  })

  // subagent-handle: a step its root stopped (the `subagents` tool's stop, the host's interrupt) ends with its last
  // words an earlier turn's. They are no hand-back: the ledger sees it stopped.
  test("subagent-handle: a stopped implementor is handed back as stopped, not as the ready an earlier turn wrote; a stopped verifier gave no verdict", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(
          { now: WEDNESDAY },
          {
            sessions: steps({
              ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x", stopped: true },
              ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" },
              ses_v: { agent: "verifier", lastWords: "verifier batch-1 r1: accepted /run/batch-1-findings.md", stopped: true },
            }),
          },
        )
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* begin(plugin, implementor("beta"), "ses_b")
        // alpha was stopped: a stopped turn has no idle, and the next decision's reconcile reads it.
        yield* plugin.idle("ses_b")
        expect((yield* plugin.call("rift", "root", { action: "land", rifts: ["beta"] })).refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "UnitHandedBack", unit: "alpha", ready: false, said: "stopped" }))
        expect(plugin.ledger).not.toContainEqual(expect.objectContaining({ kind: "UnitHandedBack", unit: "alpha", ready: true }))
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["beta"] }, status: "completed", result: { content: [{ type: "text", text: "Landed 1 Rift(s) as one push" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        // The verifier was stopped: its batch's units wait for a verdict again, and the next verifier starts.
        expect((yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier batch-2 r1", prompt: "v" })).refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "VerifierEnded", batch: "batch-1", verdict: "stopped" }))
        expect(plugin.ledger).not.toContainEqual(expect.objectContaining({ kind: "VerifierEnded", batch: "batch-1", verdict: "accepted" }))
      }),
    ))

  test("ledger-stale: a land made before an idle implementor's hand-back is read (no idle seen yet) takes the hand-back its last words say, not none", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready /u/alpha/round-1-request.md" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        expect((yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })).refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "UnitHandedBack", unit: "alpha", ready: true }))
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed 1 Rift(s) as one push" }] } })
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "BatchLanded", units: ["alpha"] }))
      }),
    ))

  test("an implementor idle with its own shell still running has not ended: the batch still waits for it", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_a")
        yield* plugin.idle("ses_b", [{ kind: "shell", sessionID: "ses_b", shellID: "sh_1", command: "bun test" }])
        expect((yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })).refused?.message).toContain(RULES.BatchNotDue.words)
      }),
    ))

  test("a foreground step is alive while its call is in flight, before its session is known", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        expect((yield* plugin.call("subagent", "root", { agent: "implementor", description: "implementor beta r1", prompt: "go" })).refused).toBeUndefined()
        expect((yield* plugin.call("rift", "root", { action: "land", rifts: ["feat/alpha"] })).refused?.message).toContain(RULES.BatchNotDue.words)
      }),
    ))

  test("after a restart the ledger is read back: the same land is refused by the new plugin", () =>
    scenario(
      Effect.gen(function* () {
        const ledger: Array<unknown> = []
        const sessions = steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" } })
        const before = yield* start({ now: WEDNESDAY }, { sessions, ledger, alive: { ses_b: true } })
        yield* begin(before, implementor("alpha"), "ses_a")
        yield* begin(before, implementor("beta"), "ses_b")
        yield* before.idle("ses_a")
        const after = yield* start({ now: WEDNESDAY }, { sessions, ledger, alive: { ses_b: true } })
        expect((yield* after.call("rift", "root", { action: "land", rifts: ["alpha"] })).refused?.message).toContain(RULES.BatchNotDue.words)
      }),
    ))

  test("a root that compacted is told the machine and its run once, on its next request; a subagent and an idle root without units are not", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: { ...steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" } }), quiet: {} } })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* plugin.compacted("root", "evt_1")
        yield* plugin.compacted("root", "evt_1")
        yield* plugin.compacted("ses_a", "evt_2")
        yield* plugin.compacted("quiet", "evt_3")
        yield* eventually(() => expect(plugin.briefs).toHaveLength(1))
        yield* settle
        expect(plugin.briefs).toHaveLength(1)
        const brief = plugin.briefs[0]!
        expect(brief).toMatchObject({ sessionID: "root", delivery: "steer", resume: false, metadata: { [OpenCodeSteer.BRIEF_MARK]: true } })
        expect(brief.text).toStartWith("## The machine")
        expect(brief.text).toContain("ONE fresh verifier per batch")
        expect(brief.text).toContain("Your run now, from the plugin's ledger:\nready: alpha")
        // The run's drift from the machine so far: none yet.
        expect(brief.text).toContain("\ndrift 0 (clean)\n\nRe-read")
        expect(brief.text).toEndWith("Re-read ~/.claude/skills/orchestrate/SKILL.md and protocol.md, and your plan, before any other action.")
      }),
    ))

  test("the brief arriving is not new input to an idle root", () =>
    scenario(
      Effect.gen(function* () {
        const runs: ReadonlyArray<Run> = [{ name: "web", units: [{ unit: "auth", state: "implement" }] }]
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: { root: {} }, steps: { root: ["auth"] }, runs })
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.nudges).toHaveLength(1))
        yield* plugin.enqueue("root", { type: "synthetic", metadata: { [OpenCodeSteer.BRIEF_MARK]: true } })
        yield* settle
        yield* plugin.idle("root")
        yield* settle
        expect(plugin.nudges).toHaveLength(1)
      }),
    ))

  test("under guard warn the call passes, its answer carries the rule's words, and the departure is recorded", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY, guard: "warn" }, { sessions: steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor" } }) })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        const input = { agent: "verifier", description: "verifier alpha r1", prompt: "v" }
        const called = yield* plugin.call("subagent", "root", input)
        expect(called.refused).toBeUndefined()
        const answer = yield* plugin.runTool(called.input)
        expect(String(answer.content)).toContain(RULES.VerifierPerUnit.words)
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "Departed", rule: "VerifierPerUnit" }))
        expect(kinds(plugin)).not.toContain("Refused")
      }),
    ))

  test("the pipeline through the plugin: the next batch fans out while batch-1 verifies; its findings fold into a running implementor and a fix unit; batch-2 lands and its verifier is told the folds", () =>
    scenario(
      Effect.gen(function* () {
        const report = "/run/batch-1-findings.md"
        const sessions = steps({
          ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready /run/alpha/round-1-request.md" },
          ses_v: { agent: "verifier", lastWords: `verifier batch-1 r1: changes ${report}` },
          ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" },
          ses_g: { agent: "implementor", lastWords: "implementor gamma r1: ready x" },
          ses_f: { agent: "implementor", lastWords: "implementor alpha-fix1 r1: ready x" },
        })
        const logged: Array<{ readonly near: string; readonly line: string }> = []
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, alive: { ses_v: true, ses_g: true }, findings: { [report]: ["alpha/M1", "alpha/M2"] }, records: { seen: new Map(), logged } })
        const land = (rifts: ReadonlyArray<string>) => plugin.call("rift", "root", { action: "land", rifts })
        const landed = (rifts: ReadonlyArray<string>) =>
          plugin.finish({ tool: "rift", input: { action: "land", rifts }, status: "completed", result: { content: [{ type: "text", text: `Landed ${rifts.length} Rift(s) as one push` }] } })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        expect((yield* land(["alpha"])).refused).toBeUndefined()
        yield* landed(["alpha"])
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "verify batch-1", background: true }, "ses_v")
        // While batch-1 verifies, batch-2 fans out, and its land waits for the verdict.
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* begin(plugin, implementor("gamma"), "ses_g")
        yield* plugin.idle("ses_b")
        const early = yield* land(["beta"])
        expect(early.refused?.message).toContain(RULES.VerdictPending.words)
        // The verdict is in: its findings are read from its report, and the land waits for them to be folded.
        yield* plugin.idle("ses_v")
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "VerifierEnded", batch: "batch-1", verdict: "changes", findings: ["alpha/M1", "alpha/M2"] }))
        // The verdict adds the root's drift to its run's log.md, by its report: the early land's refusal.
        expect(logged).toEqual([{ near: report, line: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\dZ drift 1 after batch-1 changes: 1 refused ×1$/) }])
        const unfolded = yield* land(["beta"])
        expect(unfolded.refused?.message).toContain(RULES.FindingUnfolded.words)
        expect(unfolded.refused?.message).toContain("alpha/M1 (not folded)")
        // alpha/M1 to gamma's running implementor, as a round message; alpha/M2 to a new fix unit.
        const round = { agent: "implementor", description: "implementor gamma r1 (folds: alpha/M1)", prompt: "fold alpha/M1", sessionID: "ses_g", background: true }
        expect((yield* plugin.call("subagent", "root", round)).refused).toBeUndefined()
        yield* plugin.finish({ input: round, status: "completed", result: { metadata: { sessionID: "ses_g", status: "running" } } })
        yield* begin(plugin, { agent: "implementor", description: "implementor alpha-fix1 r1 (folds: alpha/M2)", prompt: "fix alpha/M2", background: true }, "ses_f")
        yield* plugin.idle("ses_f")
        expect(plugin.ledger.filter((line) => (line as { kind: string }).kind === "FindingFolded")).toEqual([
          expect.objectContaining({ finding: "alpha/M1", into: "gamma" }),
          expect.objectContaining({ finding: "alpha/M2", into: "alpha-fix1" }),
        ])
        // Folded into gamma, which still implements: alpha/M1 rides with gamma and holds no land. Only the cadence holds
        // this one (two ready while gamma runs), never the finding.
        const riding = yield* land(["beta", "alpha-fix1"])
        expect(riding.refused?.message).toContain(RULES.BatchNotDue.words)
        expect(riding.refused?.message).not.toContain(RULES.FindingUnfolded.words)
        yield* plugin.idle("ses_g")
        expect((yield* land(["beta", "gamma", "alpha-fix1"])).refused).toBeUndefined()
        yield* landed(["beta", "gamma", "alpha-fix1"])
        // Batch-2's one verifier covers its units and is told batch-1's findings as folded.
        const two = yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier batch-2 r1", prompt: "verify batch-2", background: true })
        expect(two.refused).toBeUndefined()
        expect(String((two.input as { prompt: string }).prompt)).toContain("verify batch-2\n\nFindings of the batch before, folded into this batch")
        expect(String((two.input as { prompt: string }).prompt)).toContain("- batch-1 alpha/M1 → gamma\n- batch-1 alpha/M2 → alpha-fix1")
        expect(plugin.ledger.at(-1)).toMatchObject({ kind: "VerifierStarted", batch: "batch-2", units: ["beta", "gamma", "alpha-fix1"], findings: ["alpha/M1 → gamma", "alpha/M2 → alpha-fix1"] })
        expect(plugin.ledger.filter((line) => (line as { kind: string }).kind === "Refused").map((line) => (line as { rule: string }).rule)).toEqual(["VerdictPending", "FindingUnfolded", "BatchNotDue"])
      }),
    ))

  test("a unit's next round in a Rift of another name lands as the unit by its branch, its folded findings with it (orch-pipeline OB1)", () =>
    scenario(
      Effect.gen(function* () {
        const report = "/run/batch-1-findings.md"
        const sessions = steps({
          ses_a: { agent: "implementor", lastWords: "implementor reset-use r1: ready x" },
          ses_v: { agent: "verifier", lastWords: `verifier batch-1 r1: changes ${report}` },
          ses_a2: { agent: "implementor", lastWords: "implementor reset-use r2: ready x" },
        })
        const branches = { "/u/.rifts/dotfiles/scratch-17": "feat/reset-use-2" }
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, alive: { ses_v: true }, findings: { [report]: ["reset-use/B1", "reset-use/M1"] }, branches })
        const land = (rifts: ReadonlyArray<unknown>) => plugin.call("rift", "root", { action: "land", rifts })
        const landed = (rifts: ReadonlyArray<unknown>) =>
          plugin.finish({ tool: "rift", input: { action: "land", rifts }, status: "completed", result: { content: [{ type: "text", text: `Landed ${rifts.length} Rift(s) as one push` }] } })
        yield* begin(plugin, implementor("reset-use"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* land(["reset-use"])
        yield* landed(["reset-use"])
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "verify batch-1", background: true }, "ses_v")
        yield* plugin.idle("ses_v")
        // Round 2 runs in a Rift named for no unit, on branch feat/reset-use-2: the land reads the branch.
        yield* begin(plugin, { agent: "implementor", description: "implementor reset-use r2", prompt: "Round 2. You work in the Rift /u/.rifts/dotfiles/scratch-17.", background: true }, "ses_a2")
        yield* plugin.idle("ses_a2")
        expect((yield* land(["/u/.rifts/dotfiles/scratch-17"])).refused).toBeUndefined()
        yield* landed(["/u/.rifts/dotfiles/scratch-17"])
        expect(plugin.ledger.at(-1)).toMatchObject({ kind: "BatchLanded", units: ["reset-use"] })
        expect(kinds(plugin)).not.toContain("Refused")
        // No prompt is read: no line of the ledger holds a workspace.
        expect(JSON.stringify(plugin.ledger)).not.toContain("scratch-17")
      }),
    ))

  test("a brief that names another unit's Rift in any form is never read: a land is each unit's by its Rift's branch, or the unit it names (land-upstream r3 M1)", () =>
    scenario(
      Effect.gen(function* () {
        const sessions = steps({
          ses_api: { agent: "implementor", lastWords: "implementor api r2: ready x" },
          ses_web: { agent: "implementor", lastWords: "implementor web r1: ready x" },
        })
        // The verifier's probe: brief A names web's Rift in a `Rift:` line under Do not touch; brief B in a negated phrase.
        const briefA = "You work in the Rift /u/.rifts/app/api-2.\n\n## Do not touch\n- Rift: /u/.rifts/app/web-3 (web's, running)"
        const briefB = "Do not work in the Rift /u/.rifts/app/api-2 (api's). You work in the Rift /u/.rifts/app/web-3."
        const branches = { "/u/.rifts/app/api-2": "feat/api-2", "/u/.rifts/app/web-3": "feat/web-3", "/u/.rifts/app/wip": "wip" }
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, branches })
        yield* begin(plugin, { agent: "implementor", description: "implementor api r2", prompt: briefA, background: true }, "ses_api")
        yield* begin(plugin, { agent: "implementor", description: "implementor web r1", prompt: briefB, background: true }, "ses_web")
        yield* plugin.idle("ses_api")
        yield* plugin.idle("ses_web")
        const land = (rifts: ReadonlyArray<unknown>, departs?: string) => plugin.call("rift", "root", { action: "land", rifts, ...(departs === undefined ? {} : { departs }) })
        const landed = (rifts: ReadonlyArray<unknown>) =>
          plugin.finish({ tool: "rift", input: { action: "land", rifts }, status: "completed", result: { content: [{ type: "text", text: "Landed as one push" }] } })
        // web's Rift alone is web's, so the land leaves api out; landed anyway, it is web that lands, never api.
        expect((yield* land(["/u/.rifts/app/web-3"])).refused?.message).toContain(RULES.LandPartial.words)
        expect((yield* land(["/u/.rifts/app/web-3"], "probe")).refused).toBeUndefined()
        yield* landed(["/u/.rifts/app/web-3"])
        expect(plugin.ledger.at(-1)).toMatchObject({ kind: "BatchLanded", units: ["web"] })
        // A Rift of no unit's branch is none of the machine's: it passes, though web's verdict is pending.
        expect((yield* land(["/u/.rifts/app/wip"])).refused).toBeUndefined()
        // The same Rift named for api is api's: held by the pending verdict, and landed anyway, api lands.
        const named = [{ path: "/u/.rifts/app/wip", unit: "api" }]
        expect((yield* land(named)).refused?.message).toContain(RULES.VerdictPending.words)
        expect((yield* land(named, "probe")).refused).toBeUndefined()
        yield* landed(named)
        expect(plugin.ledger.at(-1)).toMatchObject({ kind: "BatchLanded", units: ["api"] })
      }),
    ))

  test("unit-map r1 M1 through the plugin: with units db and db-2, db's round-2 Rift db-2 on p5/db-2 lands as db when its start named it (rift: <path>), and as no unit by its branch alone", () =>
    scenario(
      Effect.gen(function* () {
        const sessions = steps({
          ses_d2: { agent: "implementor", lastWords: "implementor db-2 r1: ready x" },
          ses_d: { agent: "implementor", lastWords: "implementor db r2: ready x" },
        })
        const branches = { "/u/.rifts/app/db-2-first": "p5/db-2", "/u/.rifts/app/db-2": "p5/db-2" }
        const land = (plugin: Plugin, rifts: ReadonlyArray<unknown>, departs?: string) =>
          plugin.call("rift", "root", { action: "land", rifts, ...(departs === undefined ? {} : { departs }) })
        const landed = (plugin: Plugin, rifts: ReadonlyArray<unknown>) =>
          plugin.finish({ tool: "rift", input: { action: "land", rifts }, status: "completed", result: { content: [{ type: "text", text: "Landed as one push" }] } })
        // The starts name their Rifts: db's round-2 Rift is db's, though its name and branch read as db-2.
        const named = yield* start({ now: WEDNESDAY }, { sessions, branches })
        yield* begin(named, { agent: "implementor", description: "implementor db-2 r1 (rift: /u/.rifts/app/db-2-first)", prompt: "go", background: true }, "ses_d2")
        yield* begin(named, { agent: "implementor", description: "implementor db r2 (rift: /u/.rifts/app/db-2)", prompt: "go", background: true }, "ses_d")
        yield* named.idle("ses_d2")
        yield* named.idle("ses_d")
        expect(named.ledger).toContainEqual(expect.objectContaining({ kind: "UnitStarted", unit: "db", round: 2, rift: "/u/.rifts/app/db-2" }))
        const partial = yield* land(named, ["/u/.rifts/app/db-2"])
        expect(partial.refused?.message).toContain('rifts: [{ path: "/u/.rifts/app/db-2-first", unit: "db-2" }, { path: "/u/.rifts/app/db-2", unit: "db" }]')
        expect((yield* land(named, ["/u/.rifts/app/db-2"], "probe")).refused).toBeUndefined()
        yield* landed(named, ["/u/.rifts/app/db-2"])
        expect(named.ledger.at(-1)).toMatchObject({ kind: "BatchLanded", units: ["db"] })
        // No start named them: the branch p5/db-2 reads as db-2 and as db's round 2, so the land is no unit's.
        const unnamed = yield* start({ now: WEDNESDAY }, { sessions, branches })
        yield* begin(unnamed, { agent: "implementor", description: "implementor db-2 r1", prompt: "go", background: true }, "ses_d2")
        yield* begin(unnamed, { agent: "implementor", description: "implementor db r2", prompt: "go", background: true }, "ses_d")
        yield* unnamed.idle("ses_d2")
        yield* unnamed.idle("ses_d")
        expect((yield* land(unnamed, ["/u/.rifts/app/db-2"])).refused).toBeUndefined()
        yield* landed(unnamed, ["/u/.rifts/app/db-2"])
        expect(kinds(unnamed)).not.toContain("BatchLanded")
      }),
    ))

  test("property: over arbitrary units, numbered rounds and briefs naming other units' Rifts in every own-form, a land of every unit's Rift by path is exactly the batch", async () => {
    const random = rngOf(1111)
    const pick = <A,>(list: ReadonlyArray<A>): A => list[Math.floor(random() * list.length)]!
    const word = () => Array.from({ length: 1 + Math.floor(random() * 5) }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(random() * 26)]).join("")
    const ownForms = [(path: string) => `Rift: ${path}`, (path: string) => `- **Workspace:** ${path}`, (path: string) => `You work in the Rift ${path}.`, (path: string) => `## Workspace\n${path}`]
    const mentions = [...ownForms, (path: string) => `Do not work in the Rift ${path}.`, (path: string) => `## Do not touch\n- Rift: ${path} (running)`]
    for (let trial = 0; trial < 40; trial++) {
      const units = [...new Set(Array.from({ length: 2 + Math.floor(random() * 3) }, () => Array.from({ length: 1 + Math.floor(random() * 2) }, word).join("-")))]
      if (units.length < 2) continue
      const rounds = Object.fromEntries(units.map((unit) => [unit, 1 + Math.floor(random() * 5)]))
      // Each unit's Rift: called for another unit, or for nothing, on its own branch (a later round's numbered).
      const paths = Object.fromEntries(units.map((unit, i) => [unit, random() < 0.5 ? `/h/.rifts/r/${pick(units)}-${i + 2}` : `/h/.rifts/r/${word()}-${i}`]))
      const branches = Object.fromEntries(units.map((unit) => [paths[unit]!, rounds[unit]! > 1 && random() < 0.7 ? `feat/${unit}-${rounds[unit]}` : `feat/${unit}`]))
      const brief = (unit: string) => {
        const others = units.filter((other) => other !== unit).map((other) => pick(mentions)(paths[other]!))
        const cut = Math.floor(random() * (others.length + 1))
        return [...others.slice(0, cut), pick(ownForms)(paths[unit]!), ...others.slice(cut)].join("\n")
      }
      const sessions = steps(Object.fromEntries(units.map((unit, i) => [`ses_${i}`, { agent: "implementor", lastWords: `implementor ${unit} r${rounds[unit]}: ready x` }])))
      await scenario(
        Effect.gen(function* () {
          const plugin = yield* start({ now: WEDNESDAY }, { sessions, branches })
          for (const [i, unit] of units.entries())
            yield* begin(plugin, { agent: "implementor", description: `implementor ${unit} r${rounds[unit]}`, prompt: brief(unit), background: true }, `ses_${i}`)
          for (const i of units.keys()) yield* plugin.idle(`ses_${i}`)
          const where = JSON.stringify({ trial, units, paths, branches })
          // One unit's Rift alone is that unit's: the land leaves the others out.
          const one = yield* plugin.call("rift", "root", { action: "land", rifts: [paths[units[0]!]] })
          expect([where, one.refused?.message.includes(RULES.LandPartial.words)]).toEqual([where, true])
          const all = [...units].sort(() => random() - 0.5).map((unit) => paths[unit]!)
          expect([where, (yield* plugin.call("rift", "root", { action: "land", rifts: all })).refused]).toEqual([where, undefined])
          yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: all }, status: "completed", result: { content: [{ type: "text", text: "Landed" }] } })
          const batch = plugin.ledger.at(-1) as { kind: string; units: ReadonlyArray<string> }
          expect([where, batch.kind, [...batch.units].sort()]).toEqual([where, "BatchLanded", [...units].sort()])
        }),
      )
    }
  })

  test("a land before the verdict passes when it departs, and the departure is recorded", () =>
    scenario(
      Effect.gen(function* () {
        const sessions = steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" } })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, alive: { ses_v: true } })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed 1 Rift(s) as one push" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_b")
        const departed = yield* plugin.call("rift", "root", { action: "land", rifts: ["beta"], departs: "the owner ships beta today" })
        expect(departed.refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "Departed", rule: "VerdictPending", why: "the owner ships beta today" }))
      }),
    ))

  // Round 1, M2 (the verifier's live probe, promoted): a covered unit's next round does not end its batch's wait.
  test("a covered unit restarted while its batch's verifier runs cannot land until the verdict is in", () =>
    scenario(
      Effect.gen(function* () {
        const sessions = steps({
          ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" },
          ses_v: { agent: "verifier", lastWords: "verifier batch-1 r1: accepted /run/batch-1-findings.md" },
          ses_a2: { agent: "implementor", lastWords: "implementor alpha r2: ready x" },
        })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, alive: { ses_v: true }, findings: {} })
        const land = (rifts: ReadonlyArray<string>) => plugin.call("rift", "root", { action: "land", rifts })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* land(["alpha"])
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed 1 Rift(s) as one push" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        // alpha's round 2 starts and hands back ready while batch-1's verifier still runs.
        yield* begin(plugin, { agent: "implementor", description: "implementor alpha r2", prompt: "go", background: true }, "ses_a2")
        yield* plugin.idle("ses_a2")
        const early = yield* land(["alpha"])
        expect(early.refused?.message).toContain(RULES.VerdictPending.words)
        expect(early.refused?.message).toContain("Verifier batch-1 still runs over alpha")
        // The verdict comes in: alpha's round 2 is kept, and lands.
        yield* plugin.idle("ses_v")
        expect((yield* land(["alpha"])).refused).toBeUndefined()
        expect(plugin.ledger.filter((line) => (line as { kind: string }).kind === "Departed")).toEqual([])
      }),
    ))

  test("B3: an accepted verdict asks the fleet to record the target its batch file names, by the verifier's report, never its checkout; changes asks nothing", () =>
    scenario(
      Effect.gen(function* () {
        const fleet: Array<FleetTest.Asked> = []
        const sessions = {
          ...steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" } }),
          ses_v: { parentID: "root", agent: "verifier", lastWords: "verifier batch-1 r1: changes /run/batch-1-findings.md", directory: "/checkouts/dotfiles" },
          ses_w: { parentID: "root", agent: "verifier", lastWords: "verifier batch-2 r1: accepted /run/batch-2-findings.md", directory: "/checkouts/dotfiles" },
        }
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, findings: { "/run/batch-1-findings.md": ["alpha/M1"] }, fleet })
        const land = (rifts: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            yield* plugin.call("rift", "root", { action: "land", rifts })
            yield* plugin.finish({ tool: "rift", input: { action: "land", rifts }, status: "completed", result: { content: [{ type: "text", text: "Landed" }] } })
          })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* land(["alpha"])
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* plugin.idle("ses_v")
        expect(fleet).toEqual([])
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_b")
        yield* land(["beta"])
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-2 r1", prompt: "v", background: true }, "ses_w")
        yield* plugin.idle("ses_w")
        yield* eventually(() => expect(fleet).toEqual([{ report: "/run/batch-2-findings.md", batch: "batch-2" }]))
      }),
    ))

  test("M1, M2: an accepted batch whose target is refused says NOT published where the orchestrator reads it: its root's context and the run's log.md; a published one only logs", () =>
    scenario(
      Effect.gen(function* () {
        const fleet: Array<FleetTest.Asked> = []
        const logged: Array<{ readonly near: string; readonly line: string }> = []
        const sessions = {
          ...steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" } }),
          ses_v: { parentID: "root", agent: "verifier", lastWords: "verifier batch-1 r1: accepted /run/batch-1-findings.md", directory: "/checkouts/dotfiles" },
          ses_w: { parentID: "root", agent: "verifier", lastWords: "verifier batch-2 r1: accepted /run/batch-2-findings.md", directory: "/checkouts/dotfiles" },
        }
        const target = { dotfiles: "d".repeat(40), fork: "f".repeat(40), batch: "batch-1" }
        const outcomes = new Map<string, FleetOutcome>([
          ["batch-1", FleetOutcome.Recorded({ target })],
          ["batch-2", FleetOutcome.Refused({ reason: "the batch file /run/batch-2.md lacks the fork head" })],
        ])
        const fleetOutcome = (asked: FleetTest.Asked) => Option.getOrElse(Option.fromNullishOr(outcomes.get(asked.batch)), () => FleetOutcome.Off())
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, fleet, fleetOutcome, records: { seen: new Map(), logged } })
        const land = (rifts: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            yield* plugin.call("rift", "root", { action: "land", rifts })
            yield* plugin.finish({ tool: "rift", input: { action: "land", rifts }, status: "completed", result: { content: [{ type: "text", text: "Landed" }] } })
          })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* land(["alpha"])
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* plugin.idle("ses_v")
        yield* eventually(() => expect(logged.some((each) => each.line.includes("fleet: batch-1 accepted; published the verified target"))).toBe(true))
        expect(plugin.briefs.filter((brief) => brief.description === FLEET_DESCRIPTION)).toEqual([])
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_b")
        yield* land(["beta"])
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-2 r1", prompt: "v", background: true }, "ses_w")
        yield* plugin.idle("ses_w")
        const said = "fleet: batch-2 accepted, but NOT published: the batch file /run/batch-2.md lacks the fork head. Every host stays on the last published target."
        yield* eventually(() => expect(plugin.briefs.filter((brief) => brief.description === FLEET_DESCRIPTION)).toHaveLength(1))
        const [told] = plugin.briefs.filter((brief) => brief.description === FLEET_DESCRIPTION)
        expect([told?.sessionID, told?.text.endsWith(said)]).toEqual(["root", true])
        const refusals = logged.filter((each) => each.line.endsWith(said))
        expect(refusals.map((each) => each.near)).toEqual(["/run/batch-2-findings.md"])
      }),
    ))

  // Round 1, M1 (the verifier's live probe, promoted): a `changes` whose report does not read is never an empty set.
  test("a changes whose report does not read holds the next land, naming it; once the report reads its findings open and fold, and the land passes", () =>
    scenario(
      Effect.gen(function* () {
        const report = "/nonexistent/loop-probe-x/missing-findings.md"
        const reports: Record<string, ReadonlyArray<string>> = {}
        const sessions = steps({
          ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" },
          ses_v: { agent: "verifier", lastWords: `verifier batch-1 r1: changes ${report}` },
          ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" },
          ses_f: { agent: "implementor", lastWords: "implementor alpha-fix1 r1: ready x" },
        })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, alive: { ses_v: true }, findings: reports })
        const land = (rifts: ReadonlyArray<string>) => plugin.call("rift", "root", { action: "land", rifts })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* land(["alpha"])
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed 1 Rift(s) as one push" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_b")
        yield* plugin.idle("ses_v")
        expect(plugin.ledger).toContainEqual(
          expect.objectContaining({ kind: "VerifierEnded", batch: "batch-1", verdict: "changes", unresolved: { report, why: `the report ${report} does not read` } }),
        )
        const held = yield* land(["beta"])
        expect(held.refused?.message).toContain(RULES.FindingUnfolded.words)
        expect(held.refused?.message).toContain(`The findings of batch-1's \`changes\` are not known: the report ${report} does not read`)
        // The report reads now: the next land reads it again, opens its finding, and waits for it to be folded.
        reports[report] = ["alpha/M1"]
        const unfolded = yield* land(["beta"])
        expect(unfolded.refused?.message).toContain("alpha/M1 (not folded)")
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "ReportResolved", batch: "batch-1", findings: ["alpha/M1"] }))
        yield* begin(plugin, { agent: "implementor", description: "implementor alpha-fix1 r1 (folds: alpha/M1)", prompt: "fix", background: true }, "ses_f")
        yield* plugin.idle("ses_f")
        expect((yield* land(["beta", "alpha-fix1"])).refused).toBeUndefined()
      }),
    ))

  test("a changes that names no report holds the next land until it departs", () =>
    scenario(
      Effect.gen(function* () {
        const sessions = steps({
          ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" },
          ses_v: { agent: "verifier", lastWords: "verifier batch-1 r1: changes, see my notes" },
          ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" },
        })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, alive: { ses_v: true }, findings: {} })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed 1 Rift(s) as one push" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_b")
        yield* plugin.idle("ses_v")
        const held = yield* plugin.call("rift", "root", { action: "land", rifts: ["beta"] })
        expect(held.refused?.message).toContain("its hand-back names no findings report")
        const departed = yield* plugin.call("rift", "root", { action: "land", rifts: ["beta"], departs: "the owner read the verdict himself" })
        expect(departed.refused).toBeUndefined()
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "Departed", rule: "FindingUnfolded", why: "the owner read the verdict himself" }))
      }),
    ))

  // orch-followups 2: the race ledger-stale fixed for an implementor, on the verifier's path. A verifier that handed
  // back and went quiet before its idle was seen was marked dead (`none`) by the next decision's reconcile: its
  // verdict was lost, and its idle then found no verifier, so the fleet target and the run's log line never came.
  test("orch-followups 2: a verifier's hand-back a land reads before its idle is its verdict, concluded once: the fleet asked and the run's log written once, its idle after adds nothing", () =>
    scenario(
      Effect.gen(function* () {
        const fleet: Array<FleetTest.Asked> = []
        const logged: Array<{ readonly near: string; readonly line: string }> = []
        const sessions = {
          ...steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" } }),
          ses_v: { parentID: "root", agent: "verifier", lastWords: "verifier batch-1 r1: accepted /run/batch-1-findings.md", directory: "/checkouts/dotfiles" },
        }
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, fleet, records: { seen: new Map(), logged } })
        const land = (rifts: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const called = yield* plugin.call("rift", "root", { action: "land", rifts })
            yield* plugin.finish({ tool: "rift", input: { action: "land", rifts }, status: "completed", result: { content: [{ type: "text", text: "Landed" }] } })
            return called
          })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* land(["alpha"])
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_b")
        // The verifier handed back accepted and its session stopped; its idle is not seen yet. beta's land reads it.
        expect((yield* land(["beta"])).refused).toBeUndefined()
        const verdicts = () => kinds(plugin).filter((kind) => kind === "VerifierEnded")
        expect(verdicts()).toHaveLength(1)
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "VerifierEnded", batch: "batch-1", verdict: "accepted" }))
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "BatchLanded", units: ["beta"] }))
        yield* eventually(() => expect(fleet).toEqual([{ report: "/run/batch-1-findings.md", batch: "batch-1" }]))
        const driftLines = () => logged.filter((each) => / drift \d+ after batch-1 accepted/.test(each.line))
        expect(driftLines().map((each) => each.near)).toEqual(["/run/batch-1-findings.md"])
        // Its idle comes after: the ledger decides the hand-back to nothing, and nothing is told twice.
        yield* plugin.idle("ses_v")
        yield* settle
        expect([verdicts().length, fleet.length, driftLines().length]).toEqual([1, 1, 1])
      }),
    ))

  test("orch-followups 2: a verifier's changes a land reads before its idle opens its findings and holds that land, and its log line is still written once", () =>
    scenario(
      Effect.gen(function* () {
        const logged: Array<{ readonly near: string; readonly line: string }> = []
        const report = "/run/batch-1-findings.md"
        const sessions = {
          ...steps({ ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" }, ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" } }),
          ses_v: { parentID: "root", agent: "verifier", lastWords: `verifier batch-1 r1: changes ${report}`, directory: "/checkouts/dotfiles" },
        }
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, findings: { [report]: ["alpha/M1"] }, records: { seen: new Map(), logged } })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* begin(plugin, implementor("beta"), "ses_b")
        yield* plugin.idle("ses_b")
        const held = yield* plugin.call("rift", "root", { action: "land", rifts: ["beta"] })
        expect(held.refused?.message).toContain("alpha/M1 (not folded)")
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "VerifierEnded", batch: "batch-1", verdict: "changes", findings: ["alpha/M1"] }))
        yield* plugin.idle("ses_v")
        yield* settle
        expect(logged).toEqual([{ near: report, line: expect.stringMatching(/ drift \d+ after batch-1 changes/) }])
      }),
    ))

  // orch-followups 3: a unit the root drops ends on its machine and releases its findings. r1 M1: which unit log.ts
  // dropped is its log.md's to say, never the command line's: a refused move drops nothing.
  test("orch-followups 3, r1 M1: each unit whose log.md a root's log.ts call moved to dropped ends on the ledger and releases its finding; one whose move log.ts refused keeps its own; the next land needs no departs", () =>
    scenario(
      Effect.gen(function* () {
        const run = yield* scratchRun
        const report = "/run/batch-1-findings.md"
        const sessions = steps({
          ses_a: { agent: "implementor", lastWords: "implementor alpha r1: ready x" },
          ses_v: { agent: "verifier", lastWords: `verifier batch-1 r1: changes ${report}` },
          ses_fa: { agent: "implementor" },
          ses_fb: { agent: "implementor" },
          ses_fg: { agent: "implementor" },
          ses_d: { agent: "implementor", lastWords: "implementor delta r1: ready x" },
        })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, findings: { [report]: ["alpha/M1", "alpha/M2", "alpha/M3"] }, drops: journalOf(run) })
        const land = (rifts: ReadonlyArray<string>) => plugin.call("rift", "root", { action: "land", rifts })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        yield* plugin.idle("ses_a")
        yield* land(["alpha"])
        yield* plugin.finish({ tool: "rift", input: { action: "land", rifts: ["alpha"] }, status: "completed", result: { content: [{ type: "text", text: "Landed" }] } })
        yield* begin(plugin, { agent: "verifier", description: "verifier batch-1 r1", prompt: "v", background: true }, "ses_v")
        yield* plugin.idle("ses_v")
        // Each finding folds into a fix whose implementor dies and is never restarted; delta is ready.
        yield* begin(plugin, { agent: "implementor", description: "implementor a-fix r1 (folds: alpha/M1)", prompt: "fix", background: true }, "ses_fa")
        yield* begin(plugin, { agent: "implementor", description: "implementor b-fix r1 (folds: alpha/M2)", prompt: "fix", background: true }, "ses_fb")
        yield* begin(plugin, { agent: "implementor", description: "implementor g-fix r1 (folds: alpha/M3)", prompt: "fix", background: true }, "ses_fg")
        yield* begin(plugin, implementor("delta"), "ses_d")
        yield* plugin.idle("ses_d")
        for (const unit of ["a-fix", "b-fix", "g-fix"]) logged(run, unit, "new decide r1")
        const dropped = () => plugin.ledger.filter((_, at) => kinds(plugin)[at] === "UnitDropped")
        // The first move is refused (b-fix is in decide, not implement), the second written: a-fix alone is dropped.
        yield* shell(plugin, { command: `bun ${LOG_SCRIPT} ${run}/b-fix implement dropped r1 x; bun ${LOG_SCRIPT} ${run}/a-fix decide dropped r1 x` }, tmpdir(), journalOf(run))
        expect(dropped()).toEqual([expect.objectContaining({ unit: "a-fix", released: ["alpha/M1"] })])
        // Another unit's move, and a move asked of no log, drop nothing.
        yield* shell(plugin, { command: `bun ${LOG_SCRIPT} ${run}/g-fix decide implement r2 again` }, tmpdir(), journalOf(run))
        yield* shell(plugin, { command: `bun ${LOG_SCRIPT} ${run}/nowhere decide dropped r1 x` }, tmpdir(), journalOf(run))
        expect(dropped()).toHaveLength(1)
        // Two moves in one line, both written, relative to the call's workdir: both are dropped.
        yield* shell(plugin, { command: `bun ${LOG_SCRIPT} --current b-fix dropped r1 x && bun ${LOG_SCRIPT} g-fix implement dropped r2 x`, workdir: run }, run, journalOf(run))
        expect(dropped().slice(1)).toEqual([expect.objectContaining({ unit: "b-fix", released: ["alpha/M2"] }), expect.objectContaining({ unit: "g-fix", released: ["alpha/M3"] })])
        expect((yield* land(["delta"])).refused).toBeUndefined()
        expect(kinds(plugin)).not.toContain("Departed")
      }),
    ))

  const DroppedLine = Schema.Struct({ kind: Schema.Literal("UnitDropped"), unit: Schema.String })
  const decodeDropped = Schema.decodeUnknownOption(DroppedLine)
  /** The units the ledger dropped, one entry per `UnitDropped`. */
  const droppedUnits = (plugin: Plugin) => plugin.ledger.flatMap((line) => Option.toArray(Option.map(decodeDropped(line), (dropped) => dropped.unit)))
  /** Whether `unit`'s log.md ends in a move to dropped: what log.ts wrote. */
  const endsDropped = (run: string, unit: string) => / → dropped r\d+(?: [^\n]*)?$/.test(readFileSync(join(run, unit, "log.md"), "utf8").trim())

  /**
   * One way a root's shell call runs a log.ts move: its input, where it runs, how it ends, and whether it answers
   * before log.ts writes (`hook-first`: a command it backgrounded, or one still running when the call timed out).
   */
  interface Call {
    readonly input: { readonly command: string; readonly workdir?: string }
    readonly cwd: string
    readonly status: "completed" | "error"
    readonly order: "run-first" | "hook-first"
  }
  type Move = (dir: string) => string
  const FORMS = {
    absolute: (run: string, unit: string, move: Move): Call => ({ input: { command: move(`${run}/${unit}`) }, cwd: "/", status: "completed", order: "run-first" }),
    relative: (run: string, unit: string, move: Move): Call => ({ input: { command: move(unit), workdir: run }, cwd: run, status: "completed", order: "run-first" }),
    variable: (run: string, unit: string, move: Move): Call => ({ input: { command: `RUN=${run}; ${move(`$RUN/${unit}`)}` }, cwd: "/", status: "completed", order: "run-first" }),
    braced: (run: string, unit: string, move: Move): Call => ({ input: { command: `RUN=${run}; ${move(`"\${RUN}/${unit}"`)}` }, cwd: "/", status: "completed", order: "run-first" }),
    cd: (run: string, unit: string, move: Move): Call => ({ input: { command: `cd ${run} && ${move(unit)}` }, cwd: "/", status: "completed", order: "run-first" }),
    backgrounded: (run: string, unit: string, move: Move): Call => ({ input: { command: `${move(`${run}/${unit}`)} &` }, cwd: "/", status: "completed", order: "hook-first" }),
    "timed out": (run: string, unit: string, move: Move): Call => ({ input: { command: `cd ${run}; ${move(unit)}` }, cwd: "/", status: "error", order: "hook-first" }),
  }
  const FORM_NAMES: ReadonlyArray<keyof typeof FORMS> = ["absolute", "relative", "variable", "braced", "cd", "backgrounded", "timed out"]
  /** The call through the plugin's after hook, its command run for real by the root's shell: before the hook answers, or after. */
  const RUNS = {
    "run-first": (plugin: Plugin, call: Call, journal: string) =>
      Effect.suspend(() => plugin.finish({ tool: "shell", input: call.input, status: call.status, result: { content: [{ type: "text", text: spawnRoot(call.input.command, call.cwd, journal) }] } })),
    "hook-first": (plugin: Plugin, call: Call, journal: string) =>
      plugin.finish({ tool: "shell", input: call.input, status: call.status, result: { content: [{ type: "text", text: "still running" }] } }).pipe(Effect.andThen(Effect.sync(() => spawnRoot(call.input.command, call.cwd, journal)))),
  }

  /** The reader trials run beside their units: `reader` hands back ready, `starter` starts when asked. */
  const READER = { ses_reader: { agent: "implementor", lastWords: "implementor reader r1: ready x" }, ses_starter: { agent: "implementor" } }
  /**
   * Where a trial's late drop is first read: the root's next shell call, its next start, a step's hand-back, or its
   * next land. Each is a call the plugin reads the root's drops at.
   */
  const READS = {
    shell: (plugin: Plugin) => plugin.finish({ tool: "shell", input: { command: "true" }, status: "completed", result: { content: [{ type: "text", text: "" }] } }),
    start: (plugin: Plugin) => begin(plugin, implementor("starter"), "ses_starter"),
    "hand-back": (plugin: Plugin) => plugin.idle("ses_reader"),
    land: (plugin: Plugin) => Effect.asVoid(plugin.call("rift", "root", { action: "land", rifts: ["reader"] })),
  }
  const READ_NAMES: ReadonlyArray<keyof typeof READS> = ["shell", "start", "hand-back", "land"]

  /**
   * One trial: up to three units, each moved by a call of the form `forms` gives it, the calls that answer before
   * log.ts writes last, so the last one's drop is first seen at the `read` point. Then the first unit dropped is
   * started again at r2, its log.md still ending in its r1 drop (no dir found to log the start in), and two lands
   * follow. The counts of drops per unit right after the read and at the end, and what each log.md ends in.
   */
  const dropTrial = (trial: number, forms: (at: number) => keyof typeof FORMS, from: () => string, read: keyof typeof READS) =>
    Effect.gen(function* () {
      const run = yield* scratchRun
      const journal = journalOf(run)
      const units = Array.from({ length: 1 + (trial % 3) }, (_, at) => `t${trial}-u${at}`)
      const sessions = Object.fromEntries(units.flatMap((unit) => [[`ses_${unit}`, { agent: "implementor" }], [`ses_${unit}_r2`, { agent: "implementor" }]]))
      const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ...sessions, ...READER }), drops: journal })
      yield* begin(plugin, implementor("reader"), "ses_reader")
      for (const unit of units) {
        yield* begin(plugin, implementor(unit), `ses_${unit}`)
        logged(run, unit, "new decide r1")
      }
      // A move from decide is written, one from implement refused, by log.ts itself.
      const named = units.map((unit, at) => ({ unit, form: forms(at) }))
      const calls = named.map(({ unit, form }) => FORMS[form](run, unit, (dir) => `bun ${LOG_SCRIPT} ${dir} ${from()} dropped r1 x`))
      for (const call of [...calls.filter((call) => call.order === "run-first"), ...calls.filter((call) => call.order === "hook-first")]) yield* RUNS[call.order](plugin, call, journal)
      yield* READS[read](plugin)
      const countsOf = () => units.map((unit) => [unit, droppedUnits(plugin).filter((each) => each === unit).length])
      const atRead = countsOf()
      const written = units.map((unit) => [unit, Number(endsDropped(run, unit))])
      // A unit dropped and started again at r2 is live: the old drop its log.md still ends in drops nothing more.
      const revived = units.filter((unit) => endsDropped(run, unit)).slice(0, 1)
      for (const unit of revived) yield* begin(plugin, { ...implementor(unit), description: `implementor ${unit} r2` }, `ses_${unit}_r2`)
      yield* READS.shell(plugin)
      yield* plugin.call("rift", "root", { action: "land", rifts: units })
      return { forms: named.map(({ form }) => form), atRead, atEnd: countsOf(), written }
    })

  // orch-followups r2 M1 (a repeat of r1 M1) and orch-late-drop item 1: the hook read the unit dir off the command's
  // text, so a dir named through a variable or after a `cd` was missed, and so was a drop log.ts wrote after the
  // call answered (backgrounded, or a call that timed out). What log.ts wrote decides now, through its drops journal.
  // Over every form a root's line names the dir in, each move written or refused by log.ts itself, and every point a
  // late drop is first read at (r1 M1: a shell call, a start, a hand-back, a land), the ledger drops each written drop
  // exactly once by that point and a refused one never, and a unit started again at r2 is not dropped again.
  test("property: whatever form names the unit dir, whenever log.ts writes and wherever it is read, each written drop ends its unit exactly once and a refused one none", () =>
    scenario(
      Effect.gen(function* () {
        const rng = rngOf(11)
        const pick = <A,>(list: ReadonlyArray<A>): A => list[Math.floor(rng() * list.length)]!
        const formsSeen = new Set<string>()
        const readsSeen = new Set<string>()
        // Each trial's first unit takes the forms in turn, and the trials the read points in turn; the rest pick.
        for (let trial = 0; trial < 4 * FORM_NAMES.length; trial++) {
          const read = READ_NAMES[trial % READ_NAMES.length]!
          const result = yield* dropTrial(trial, (at) => [FORM_NAMES[trial % FORM_NAMES.length]!, pick(FORM_NAMES), pick(FORM_NAMES)][at]!, () => pick(["decide", "implement"]), read)
          for (const form of result.forms) formsSeen.add(form)
          readsSeen.add(read)
          expect([trial, read, result.forms, result.atRead, result.atEnd]).toEqual([trial, read, result.forms, result.written, result.written])
        }
        expect([[...formsSeen].toSorted(), [...readsSeen].toSorted()]).toEqual([[...FORM_NAMES].toSorted(), [...READ_NAMES].toSorted()])
      }),
    ), 240_000)

  // orch-late-drop item 1's acceptance: a drop log.ts writes after the call's hook read the journal ends its unit at
  // the next land, and only once.
  test("orch-late-drop 1: a drop written after its shell call answered ends its unit at the next land, once", () =>
    scenario(
      Effect.gen(function* () {
        const run = yield* scratchRun
        const journal = journalOf(run)
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor" } }), drops: journal })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        logged(run, "alpha", "new decide r1")
        const call = FORMS.backgrounded(run, "alpha", (dir) => `bun ${LOG_SCRIPT} ${dir} decide dropped r1 superseded`)
        yield* plugin.finish({ tool: "shell", input: call.input, status: "completed", result: { content: [{ type: "text", text: "backgrounded" }] } })
        expect(droppedUnits(plugin)).toEqual([])
        spawnRoot(call.input.command, call.cwd, journal)
        yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })
        expect(droppedUnits(plugin)).toEqual(["alpha"])
        yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })
        yield* begin(plugin, implementor("beta"), "ses_a")
        expect(droppedUnits(plugin)).toEqual(["alpha"])
      }),
    ), 60_000)

  /** A plugin whose root dropped alpha by a backgrounded log.ts call that wrote after the call's hook read the journal. */
  const droppedLate = (sessions: Readonly<Record<string, { readonly agent: string; readonly lastWords?: string }>>, first: (plugin: Plugin) => Effect.Effect<void, unknown>) =>
    Effect.gen(function* () {
      const run = yield* scratchRun
      const journal = journalOf(run)
      const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor" }, ...sessions }), drops: journal })
      yield* begin(plugin, implementor("alpha"), "ses_a")
      yield* first(plugin)
      logged(run, "alpha", "new decide r1")
      const call = FORMS.backgrounded(run, "alpha", (dir) => `bun ${LOG_SCRIPT} ${dir} decide dropped r1 superseded`)
      yield* RUNS[call.order](plugin, call, journal)
      expect(droppedUnits(plugin)).toEqual([])
      return plugin
    })

  // orch-late-drop r1 M1: a late drop is read at the next start and the next hand-back too, not only at a land or a
  // shell call (mutants V2 and V3 left every test green).
  test("orch-late-drop r1 M1: a drop written after its shell call answered ends its unit at the root's next start", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* droppedLate({ ses_b: { agent: "implementor" } }, () => Effect.void)
        yield* begin(plugin, implementor("beta"), "ses_b")
        expect(droppedUnits(plugin)).toEqual(["alpha"])
      }),
    ), 60_000)

  test("orch-late-drop r1 M1: a drop written after its shell call answered ends its unit at a step's next hand-back", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* droppedLate({ ses_b: { agent: "implementor", lastWords: "implementor beta r1: ready x" } }, (plugin) => begin(plugin, implementor("beta"), "ses_b"))
        yield* plugin.idle("ses_b")
        expect(droppedUnits(plugin)).toEqual(["alpha"])
      }),
    ), 60_000)

  // orch-late-drop r1 M1 (mutant V5): a unit started again at a later round is live, though its log.md still ends in
  // its old drop when the plugin found no dir to log the start in.
  test("orch-late-drop r1 M1: a unit started again at r2 whose log.md still ends in its r1 drop is not dropped again", () =>
    scenario(
      Effect.gen(function* () {
        const run = yield* scratchRun
        const journal = journalOf(run)
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor" }, ses_a2: { agent: "implementor" } }), drops: journal })
        yield* begin(plugin, implementor("alpha"), "ses_a")
        logged(run, "alpha", "new decide r1")
        yield* shell(plugin, { command: `bun ${LOG_SCRIPT} ${run}/alpha decide dropped r1 x` }, "/", journal)
        expect(droppedUnits(plugin)).toEqual(["alpha"])
        yield* begin(plugin, { ...implementor("alpha"), description: "implementor alpha r2" }, "ses_a2")
        expect(endsDropped(run, "alpha")).toBe(true)
        yield* shell(plugin, { command: "true" }, "/", journal)
        yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })
        expect(droppedUnits(plugin)).toEqual(["alpha"])
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "UnitStarted", unit: "alpha", round: 2 }))
      }),
    ), 60_000)

  // orch-followups r2 M2: only log.md's last line counts. A drop log.ts wrote and the root then undid (`dropped →
  // decide`) is no drop; a unit revived (`dropped → implement r2`) whose later drop log.ts refused stays live.
  test("orch-followups r2 M2: a drop undone in the same line, and a revived unit's refused drop, end nothing; only log.md's last line counts", () =>
    scenario(
      Effect.gen(function* () {
        const run = yield* scratchRun
        const journal = journalOf(run)
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_u: { agent: "implementor" }, ses_v: { agent: "implementor" }, ses_v2: { agent: "implementor" } }), drops: journal })
        const root = (command: string) => shell(plugin, { command }, tmpdir(), journal)
        yield* begin(plugin, implementor("undone"), "ses_u")
        yield* begin(plugin, implementor("revived"), "ses_v")
        logged(run, "undone", "new decide r1")
        logged(run, "revived", "new decide r1")
        // Dropped and undone in one line: log.ts journaled the drop, but the log's last line moves the unit on.
        yield* root(`bun ${LOG_SCRIPT} ${run}/undone decide dropped r1 x; bun ${LOG_SCRIPT} ${run}/undone dropped decide r1 undo`)
        // Dropped for real, then revived at r2; a later drop from the wrong state is refused.
        yield* root(`bun ${LOG_SCRIPT} ${run}/revived decide dropped r1 x`)
        expect(droppedUnits(plugin)).toEqual(["revived"])
        yield* begin(plugin, { ...implementor("revived"), description: "implementor revived r2" }, "ses_v2")
        yield* root(`bun ${LOG_SCRIPT} ${run}/revived dropped implement r2 again; bun ${LOG_SCRIPT} ${run}/revived decide dropped r2 x`)
        expect(readFileSync(join(run, "revived", "log.md"), "utf8")).toContain("dropped → implement r2 again")
        yield* plugin.call("rift", "root", { action: "land", rifts: ["undone", "revived"] })
        expect(droppedUnits(plugin)).toEqual(["revived"])
        expect(plugin.ledger).toContainEqual(expect.objectContaining({ kind: "UnitStarted", unit: "revived", round: 2 }))
      }),
    ), 60_000)

  test("a checked land lands only the Rifts it answered green or pending, by their paths and branches, each with the unit its input named", () => {
    const text = ["Checked 2 Rift(s) as one batch", "- run/alpha (/r/run-alpha): green", "- run/beta (/r/run-beta): red; conflict", "- run/gamma (/r/scratch): pending"].join("\n")
    expect(greenOf([{ rift: "alpha" }, { rift: "beta" }, { rift: "/r/scratch/", unit: "gamma" }], text)).toEqual([
      { rift: "/r/run-alpha", branch: "run/alpha" },
      { rift: "/r/scratch", branch: "run/gamma", unit: "gamma" },
    ])
    expect(greenOf([{ rift: "alpha" }], "Landed 1 Rift(s) as one push")).toEqual([{ rift: "alpha" }])
  })
})

// orch-late-drop item 2: a restart in the Sabbath rest (a crash, a restart by hand) resumes the turns the old server
// left running; each waits for the rest's end before its next model request. Outside the rest it goes as today.
describe("a turn resumed after a restart", () => {
  const FRIDAY_NIGHT = Date.parse("2026-10-30T23:00:00Z")
  const END = rest(FRIDAY_NIGHT, KNOWLTON).end
  const resumed = (created: number) => [
    { type: "user", text: "go", time: { created: created - 3_600_000 } },
    { type: "synthetic", text: "The server restarted while you were working.", metadata: { notice: RESTART_NOTICE }, time: { created } },
  ]
  /** The plugin on the test clock at `now`, with `root`'s turn resumed by a restart notice written then. */
  const restarted = (now: number) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const plugin = yield* start({})
      plugin.contexts.set("root", resumed(now))
      return plugin
    })

  test("in the rest, the resumed turn makes no model request until the rest ends; a prompt's turn asks at once", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* restarted(FRIDAY_NIGHT)
        plugin.contexts.set("other", [{ type: "user", text: "go", time: { created: FRIDAY_NIGHT } }])
        yield* plugin.modelRequest("other")
        const held = yield* Effect.forkChild(plugin.modelRequest("root"))
        yield* TestClock.adjust(END - FRIDAY_NIGHT - 60_000)
        expect(held.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(60_000)
        yield* Fiber.join(held)
        expect(yield* Clock.currentTimeMillis).toBe(END)
      }).pipe(Effect.provide(TestClock.layer())),
    ))

  test("outside the rest, the resumed turn asks at once", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* restarted(Date.parse(WEDNESDAY))
        yield* plugin.modelRequest("root")
        expect(yield* Clock.currentTimeMillis).toBe(Date.parse(WEDNESDAY))
      }).pipe(Effect.provide(TestClock.layer())),
    ))
})

describe("the options", () => {
  const decode = Schema.decodeUnknownSync(Options)
  const defaults = {
    log: DEFAULT_LOG,
    ledger: DEFAULT_LEDGER,
    cadence: DEFAULT_CADENCE,
    guard: "refuse" as const,
    place: KNOWLTON,
    fullAgent: false,
    codex: { providers: ["openai"], script: CODEX_BUDGET },
    unitLog: UNIT_LOG,
    drops: FileUnitLogs.DROPS_JOURNAL,
    skill: SKILL_DIR,
  }

  test("each absent option takes its default; an undefined one is absent", () => {
    expect(decode({})).toEqual(defaults)
    expect(decode({ log: undefined, now: undefined, place: undefined, codex: undefined })).toEqual(defaults)
    expect(decode({ codex: {} }).codex).toEqual(defaults.codex)
  })

  test("the ones given are read as the plugin uses them", () => {
    const place = { name: "Lisbon", lat: 38.7, lon: -9.1, timeZone: "Europe/Lisbon" }
    expect(
      decode({ log: "/l.jsonl", now: WEDNESDAY, place, fullAgent: true, codex: { providers: ["openai", "sim"] } }),
    ).toEqual({
      log: "/l.jsonl",
      ledger: DEFAULT_LEDGER,
      cadence: DEFAULT_CADENCE,
      guard: "refuse",
      now: Date.parse(WEDNESDAY),
      place,
      fullAgent: true,
      codex: { providers: ["openai", "sim"], script: CODEX_BUDGET },
      unitLog: UNIT_LOG,
      drops: FileUnitLogs.DROPS_JOURNAL,
      skill: SKILL_DIR,
    })
    expect(decode({ skill: "/s" }).skill).toBe("/s")
    expect(decode({ drops: "/d.jsonl" }).drops).toBe("/d.jsonl")
    expect(decode({ codex: false }).codex).toBe(false)
    expect(decode({ codex: { pool: true } }).codex).toEqual({ ...defaults.codex, pool: true })
    expect(decode({ planner: { model: "anthropic/claude-fable-5-2" } }).planner).toEqual({ model: "anthropic/claude-fable-5-2" })
    // The A/B's option an earlier install wrote is ignored: the planner has a first model only by `planner`.
    expect(decode({ experiment: { role: "planner", model: "anthropic/claude-fable-5-2", share: 0.5 } }).planner).toBeUndefined()
    expect(decode({ ledger: "/m.jsonl", cadence: { ready: 2, waitMs: 60_000 }, guard: "warn" })).toMatchObject({ ledger: "/m.jsonl", cadence: { ready: 2, waitMs: 60_000 }, guard: "warn" })
  })

  test("a malformed option stops the plugin at setup, naming the option", async () => {
    const malformed: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ log: null }, '["log"]'],
      [{ now: "someday" }, '["now"]'],
      [{ place: "home" }, '["place"]'],
      [{ place: { name: "Lisbon" } }, '["place"]["lat"]'],
      [{ fullAgent: "yes" }, '["fullAgent"]'],
      [{ codex: true }, '["codex"]'],
      [{ codex: { providers: ["openai", 7] } }, '["codex"]["providers"][1]'],
      [{ skill: 7 }, '["skill"]'],
      [{ guard: "loud" }, '["guard"]'],
      [{ cadence: { ready: 0, waitMs: 1 } }, '["cadence"]["ready"]'],
      [{ planner: { model: "claude-fable" } }, '["planner"]["model"]'],
      [{ planner: { model: "anthropic/claude-fable#medium" } }, '["planner"]["model"]'],
      [{ planner: "anthropic/claude-fable" }, '["planner"]'],
    ]
    for (const [options, path] of malformed) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start(options))))
      expect(exit._tag).toBe("Failure")
      const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined
      expect(reason?._tag).toBe("Die")
      const message = reason?._tag === "Die" ? String((reason.defect as Error).message) : ""
      expect(message).toStartWith("dotfiles-opencode.orchestrate: invalid options: ")
      expect(message).toContain(`at ${path}`)
    }
  })
})
