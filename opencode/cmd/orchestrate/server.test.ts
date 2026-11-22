// The plugin seam: the composition root on a stand-in host, with every
// outside system a test layer. It checks what OpenCode sees: the rewritten
// subagent input, the refusals' words, a latched call's answer and its
// opening, the call log's lines, the compaction prompt and the agents'
// windows. tests/orchestrate.test.ts and tests/prime-latch.test.ts run it in
// OpenCode.
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
import { DRIFT_MARK } from "@dotfiles/opencode-orchestrate/skill-drift"
import * as FileUnitLogs from "@dotfiles/opencode-orchestrate/filestore/unit-logs"
import * as OpenCodeLatches from "@dotfiles/opencode-orchestrate/opencode/latches"
import { type Holds, MARK, NO_HOLDS, type Run } from "@dotfiles/opencode-orchestrate/idle"
import { NOTHING_HELD } from "@dotfiles/opencode-orchestrate/ledger"
import * as StepLogTest from "@dotfiles/opencode-orchestrate/memory/step-log"
import * as FleetTest from "@dotfiles/opencode-orchestrate/memory/fleet"
import * as MainLineTest from "@dotfiles/opencode-orchestrate/memory/main-line"
import * as RunFilesTest from "@dotfiles/opencode-orchestrate/memory/run-files"
import * as WorkGitTest from "@dotfiles/opencode-orchestrate/memory/work-git"
import { FLEET_DESCRIPTION, FleetOutcome } from "@dotfiles/opencode-orchestrate/fleet"
import { RECHECK_MS } from "@dotfiles/opencode-orchestrate/model"
import * as OpenCodePoolPace from "@dotfiles/opencode-orchestrate/opencode/pool-pace"
import * as OpenCodeRuns from "@dotfiles/opencode-orchestrate/opencode/runs"
import * as OpenCodeSteer from "@dotfiles/opencode-orchestrate/opencode/steer"
import type { Pace } from "@dotfiles/opencode-orchestrate/pace"
import { NO_INFLIGHT, poolPace } from "@dotfiles/opencode-pool/pace"
import type { AccountStatus } from "@dotfiles/opencode-pool/status"
import { iso } from "@dotfiles/opencode-pool/usage-text"
import { definitions, ORCHESTRATOR, orchestrator } from "@dotfiles/opencode-orchestrate/role"
import { KNOWLTON, rest } from "@dotfiles/opencode-orchestrate/sabbath"
import { type Offered, RootHolds } from "@dotfiles/opencode-orchestrate/service"
import { eventuallyPasses } from "../../tests/wait.ts"
import Orchestrate, { CODEX_BUDGET, DEFAULT_LOG, make, Options, SKILL_DIR, SUBAGENTS, type StepHostSession, stepSessionOf, UNIT_LOG } from "./server.ts"

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
  /** The verified targets the plugin asked to record. */
  readonly fleet?: Array<FleetTest.Asked>
  /** What recording each of them answers; `Off` (nothing said) when not named. */
  readonly fleetOutcome?: (asked: FleetTest.Asked) => FleetOutcome
  /** The directories that are checkouts of the fleet's repository; every one when not named. */
  readonly fleetCovers?: (directory: string) => Option.Option<boolean>
}

/** A tool as the host's tool editor hands it out: only what the plugin touches. */
interface EditedTool {
  execute: (input: unknown, context: unknown) => Effect.Effect<{ readonly output?: unknown; readonly content?: unknown; readonly metadata?: unknown }, unknown>
  output?: Schema.Codec<unknown, unknown>
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
    const briefs: Array<OpenCodeSteer.Synthetic> = []
    const externals = (start: OpenCodeLatches.Start) => Layer.mergeAll(
      OpenCodeSteer.remindLayer((input) => Effect.sync(() => void briefs.push(input))),
      CallLogTest.layer(lines),
      SessionsTest.layer(world.sessions ?? {}),
      ModelsTest.layer(world.model, world.variants, world.others),
      world.poolAsk === undefined
        ? PoolPaceTest.layer(world.pool ?? {}, world.started)
        : OpenCodePoolPace.layer(world.poolAsk, () => Effect.succeed({})),
      CodexAdmissionTest.layer(world.codex ?? (() => undefined)),
      OpenCodeLatches.layer(keep, start),
      FileUnitLogs.layer(LOG_SCRIPT),
      StepLogTest.layer(world.steps ?? {}),
      OpenCodeRuns.layer(() => Effect.succeed({ agents: [], runs: world.runs ?? [], errors: [] })),
      Layer.succeed(RootHolds, { of: (sessionID: string) => Effect.succeed(world.holds?.[sessionID] ?? NO_HOLDS), held: () => Effect.succeed(NOTHING_HELD) }),
      OpenCodeSteer.layer((input) => (world.refuseNudge === undefined ? Effect.sync(() => void nudges.push(input)) : Effect.fail(new Error(world.refuseNudge)))),
      OpenCodeSteer.tellLayer((input) => (world.refuseNudge === undefined ? Effect.sync(() => void notes.push(input)) : Effect.fail(new Error(world.refuseNudge)))),
      SkillTest.skill(world.skill ?? { history: [] }),
      SkillTest.records(world.records ?? { seen: new Map() }),
      FleetTest.layer(world.fleet ?? [], world.fleetOutcome, world.fleetCovers),
      MainLineTest.layer(() => Option.none()),
      RunFilesTest.layer(new Map()),
      WorkGitTest.layer(WorkGitTest.world()),
    )
    const nudges: Array<OpenCodeSteer.Synthetic> = []
    const notes: Array<OpenCodeSteer.Synthetic> = []
    yield* make((_ctx, _options, start) => externals(start)).effect(host)

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
    for (const transform of toolTransforms) transform({ add: () => {}, update: (id: string, edit: (tool: EditedTool) => void) => (id === "subagent" ? edit(subagent) : undefined) })
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
    const inboxIDs = { next: 0 }
    /**
     * An input reaching a session's inbox: the owner's prompt, or a synthetic message with `metadata`; a turn takes it
     * (`session.inbox.delivered`) unless `taken` is false. Answers its inbox id.
     */
    const enqueue = Effect.fn("OrchestrateServerTest.enqueue")(function* (
      sessionID: string,
      item: { readonly type: "user" } | { readonly type: "synthetic"; readonly metadata?: Record<string, unknown> },
      taken = true,
    ) {
      const inboxID = `inbox_${inboxIDs.next++}`
      yield* Queue.offer(published, {
        type: "session.inbox.enqueued",
        data: { sessionID, inboxID, item: item.type === "user" ? { type: "user", payload: {} } : { type: "synthetic", payload: { text: "x", metadata: item.metadata } } },
      })
      if (taken) yield* deliver(sessionID, inboxID)
      return inboxID
    })
    /** A turn of the session took inbox item `inboxID`. */
    const deliver = (sessionID: string, inboxID: string) => Queue.offer(published, { type: "session.inbox.delivered", data: { sessionID, inboxID } })
    /** Inbox item `inboxID` is cancelled: the owner took it back, or a queue merge replaced it. */
    const cancel = (sessionID: string, inboxID: string) => Queue.offer(published, { type: "session.inbox.cancelled", data: { sessionID, inboxID } })
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
    return { contexts, modelRequest, call, finish, logged, hooks, transforms, runTool, ran, open, kept, subagent, idle, enqueue, deliver, cancel, draft, nudges, notes, briefs, compacted }
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
        expect(answer.output).toMatchObject({ note: NOTE, model: "anthropic/claude-opus" })
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
        const reason = "the pool's weekly pace is over: its 1 account's week is at 80.0% used of 100%; the spend-evenly line is 54.5% used of 100% now, and the start holds past it"
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
        // A kernel cell's handle carries the latch's answer and the model it will start on.
        expect(answer.output).toMatchObject({ note: answer.content, model: "anthropic/claude" })
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
        const call = yield* plugin.call("subagent", "root", { agent: "verifier", prompt: "x" })
        expect(call.input).toEqual({ agent: "verifier", prompt: "x", model: "anthropic/claude-opus#medium" })
        expect(asked).toEqual([])
        // Its answer names the model it runs on for a kernel cell's handle, and tells the parent nothing more.
        const answer = yield* plugin.runTool(call.input)
        expect(answer.content).toBe("working")
        expect(answer.output).toEqual({ sessionID: "ses_ran", status: "running", output: "working", model: "anthropic/claude-opus#medium" })
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
        // A kernel cell's handle reads the note and the model as data (mods/kernel/worker/subagent-handle.ts).
        expect(answer.output).toEqual({ sessionID: "ses_ran", status: "running", output: `${NOTE}\nworking`, note: NOTE, model: "openai/gpt-6.1-sol#medium" })
        // The tool's output schema keeps them: the kernel encodes a result by it before a cell reads it.
        const output = plugin.subagent.output
        expect(output && Schema.encodeUnknownSync(output)(answer.output)).toEqual(answer.output)
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

  /** An implementor's latch as the wakes hand it to the opener: made on `model`, with the opener's `context`. */
  const implementorLatch = (model: string, context: Latch["context"]): Latch => ({
    kind: "latch",
    id: "w000001",
    sessionID: "root",
    directory: "/work",
    setAt: now,
    child: "ses_latched1",
    subagent: { agent: "implementor", description: "FlowProducer close/add race", prompt: "x", model, from: "build", messageID: "msg", callID: "call" },
    hold: "pace",
    reason: "all pool accounts are held",
    opensAt: now,
    recheckAt: now,
    context,
  })

  test("Codex never implements: an implementor latch kept with a Codex fallback (an older build's) opens on Opus or latches again, never on Codex", () =>
    scenario(
      Effect.gen(function* () {
        // codex-no-implement: the workbox's 66 Codex implementors on 11-10 and 11-11 fell back so; a latch kept then keeps its fallback.
        const latch = implementorLatch("anthropic/claude-opus#medium", { reason: "kept", models: { primary: "anthropic/claude-opus#medium", fallback: "openai/gpt-6.1-sol#high" } })
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked), pool: held })
        expect(yield* plugin.open(latch)).toMatchObject({ outcome: "held" })
        expect(plugin.ran).toEqual([])
        expect(asked).toEqual([])
        // Opus with room: it opens there.
        const later = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked) })
        expect(yield* later.open(latch)).toEqual({ outcome: "opened" })
        expect(later.ran).toMatchObject([{ input: { model: "anthropic/claude-opus#medium" } }])
      }),
    ))

  test("Codex never implements: an implementor whose own model is Codex (a Codex parent's) runs on the newest Opus at its effort", () =>
    scenario(
      Effect.gen(function* () {
        const sol = { providerID: "openai", id: "gpt-6.1-sol-ultrafast" }
        const opus: ReadonlyArray<Offered> = [
          { providerID: "anthropic", id: "claude-opus-5-1", family: "claude-opus", time: { released: 1 }, variants: [{ id: "medium" }] },
          { providerID: "anthropic", id: "claude-opus-5-5", family: "claude-opus", time: { released: 2 }, variants: [{ id: "medium" }, { id: "high" }] },
        ]
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model: sol, variants: ["high"], others: [...codexOffered, ...opus], codex: admits(asked) })
        const call = yield* plugin.call("subagent", "root", { agent: "implementor", prompt: "x" })
        expect(call.input).toEqual({ agent: "implementor", prompt: "x", model: "anthropic/claude-opus-5-5#medium" })
        expect(call.refused).toBeUndefined()
        expect(asked).toEqual([])
        // A verifier on a Codex parent stays on the model it inherits: Codex plans and verifies.
        const verifier = yield* plugin.call("subagent", "root", { agent: "verifier", prompt: "x" })
        expect(verifier.input).toEqual({ agent: "verifier", prompt: "x" })
        expect(verifier.refused).toBeUndefined()
        // With no Opus offered, the start is refused: it never runs on Codex.
        const bare = yield* start({ now: WEDNESDAY }, { model: sol, variants: ["high"], others: codexOffered, codex: admits(asked) })
        expect(yield* bare.call("subagent", "root", { agent: "implementor", prompt: "x" })).toMatchObject({ refused: { message: expect.stringContaining("Codex never implements") } })
        // A latch made on Codex opens on Opus, or fails with no Opus offered.
        const latch = implementorLatch("openai/gpt-6.1-sol-ultrafast#high", { reason: "kept" })
        expect(yield* plugin.open(latch)).toEqual({ outcome: "opened" })
        expect(plugin.ran).toMatchObject([{ input: { model: "anthropic/claude-opus-5-5#medium" } }])
        expect(yield* bare.open(latch)).toMatchObject({ outcome: "failed" })
        expect(bare.ran).toEqual([])
      }),
    ))

  test("the spend-evenly pace alone holds a planner or verifier but not an implementor, which starts on Opus", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const paced = { anthropic: { ok: false, measured: true, soft: true, reason: "the pool's weekly pace is over: its 6 accounts' weeks are at 76.2% used of 100% on average; the spend-evenly line averages 54.5% used of 100% now, and the start holds past it", retryAt: Date.parse(WEDNESDAY) + 86_400_000 } }
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
  const FABLE_SPENT =
    "anthropic/claude-fable#medium held: every pool account is held or has claude-fable's own weekly window (7d:Fable) at 100% used of 100%: " +
    `a claude-fable start holds at 100% used of 100% there; the first resets ${iso(now + 2 * day)}`

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
        const rift = join(work, ".work/dotfiles/land-fixes")
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

describe("an idle root with units to move or to land", () => {
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

  test("an idle that comes while input heard during the turn still waits in the inbox does not nudge; the turn that takes it decides", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, world)
        // The owner's prompt came during the turn: the host runs the idle hook before the execution takes it.
        const prompt = yield* plugin.enqueue("root", { type: "user" }, false)
        yield* settle
        yield* plugin.idle("root")
        yield* settle
        expect(plugin.nudges).toEqual([])
        // The next turn takes it and ends with nothing running: that idle nudges.
        yield* plugin.deliver("root", prompt)
        yield* settle
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.nudges).toHaveLength(1))
      }),
    ))

  test("a queued prompt the owner takes back (inbox cancelled) no longer waits: the next idle nudges", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, world)
        const prompt = yield* plugin.enqueue("root", { type: "user" }, false)
        yield* plugin.cancel("root", prompt)
        yield* settle
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.nudges).toHaveLength(1))
      }),
    ))

  test("queued prompts merged into one (the originals cancelled, the merged one delivered) no longer wait: the next idle nudges", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, world)
        const first = yield* plugin.enqueue("root", { type: "user" }, false)
        const second = yield* plugin.enqueue("root", { type: "user" }, false)
        // The host enqueues the merged prompt, cancels the originals, and the turn takes the merged one.
        yield* plugin.enqueue("root", { type: "user" })
        yield* plugin.cancel("root", first)
        yield* plugin.cancel("root", second)
        yield* settle
        yield* plugin.idle("root")
        yield* eventually(() => expect(plugin.nudges).toHaveLength(1))
      }),
    ))

  test("ready units from the status plugin: each is ready to land at once, however few and however fresh; no cadence holds one", () =>
    scenario(
      Effect.gen(function* () {
        const ready = (units: ReadonlyArray<{ readonly unit: string; readonly since?: string; readonly cadence?: string }>) =>
          start({ now: WEDNESDAY }, { ...world, runs: [{ name: "p5", units: [{ unit: "closure-flake", state: "merged abc1234" }, ...units.map((unit) => ({ ...unit, state: "ready" }))] }] })
        const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 16) + "Z"
        const one = yield* ready([{ unit: "hotfix", since: minutesAgo(1) }])
        // An older run table's cadence is passed over: three wanted, one ready, it is still ready to land.
        const slow = yield* ready([{ unit: "lexer", since: minutesAgo(5), cadence: "3 ready or 60 min" }])
        const three = yield* ready([{ unit: "lexer" }, { unit: "parser" }, { unit: "docs" }])
        for (const plugin of [one, slow, three]) yield* plugin.idle("root")
        const LAND = 'land them with orchestrate({ action: "land" }).'
        yield* eventually(() => expect(one.nudges.map((nudge) => nudge.text)).toEqual([`idle with units ready to land: hotfix; ${LAND}`]))
        yield* eventually(() => expect(slow.nudges.map((nudge) => nudge.text)).toEqual([`idle with units ready to land: lexer; ${LAND}`]))
        yield* eventually(() => expect(three.nudges.map((nudge) => nudge.text)).toEqual([`idle with units ready to land: lexer, parser, docs; ${LAND}`]))
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
            "Reconcile the run's rules file once, as the orchestrate skill's references/run-rules.md says (When the skill changes). This note comes once per skill version.",
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
        // The roles' transform alone: the question tools' swap is a second one (cmd/orchestrate/asking.sim.test.ts).
        const plugin = yield* start({ now: WEDNESDAY, subagents: "owner" })
        const agents: Record<string, EditedAgent> = {}
        for (const [id, mode] of [["build", "primary"], ["explore", "subagent"], ["planner", "subagent"], ["worker", "subagent"]] as const)
          agents[id] = { id, mode, permissions: [], request: { settings: {} } }
        agents.hidden = { id: "hidden", mode: "primary", hidden: true, permissions: [], request: { settings: {} } }
        agents.build!.permissions.push({ action: "question", resource: "*", effect: "allow" })
        const chosen: Array<string> = []
        const editor = {
          list: () => Object.values(agents),
          get: (id: string) => agents[id],
          default: (id: string) => void chosen.push(id),
          // As the fork's editor: an agent not there yet is made, then edited.
          update: (id: string, edit: (agent: EditedAgent) => void) => {
            if (!Object.hasOwn(agents, id)) agents[id] = { id, mode: "primary", permissions: [], request: { settings: {} } }
            const agent = agents[id]
            if (agent) {
              edit(agent)
              agent.id = id
            }
          },
        }
        expect(plugin.transforms).toHaveLength(1)
        plugin.transforms[0]!(editor)
        expect(agents.build!.request.settings.compactionWindow).toBe(400_000)
        // The orchestrator: build's fields under its own name, primary, the default, with the window.
        expect(chosen).toEqual(["orchestrator"])
        expect(agents.orchestrator).toMatchObject({ id: "orchestrator", mode: "primary", permissions: agents.build!.permissions, request: { settings: { compactionWindow: 400_000 } } })
        expect(agents.orchestrator!.request.settings.cacheTTL).toBeUndefined()
        expect(agents.orchestrator!.permissions).not.toBe(agents.build!.permissions)
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

  test("each request the orchestrator makes, the turn's, the host's own (generate) and the summary's, carries its section exactly once after build's prompt; another agent's none", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY })
        const BUILD_PROMPT = "You are the build agent."
        const count = (text: string) => text.split(orchestrator.section).length - 1
        for (const name of ["context", "generate", "compaction"]) {
          const sent = (agent: string) =>
            Effect.gen(function* () {
              const event = { sessionID: "root", agent, system: [{ type: "text" as const, text: BUILD_PROMPT }, { type: "text" as const, text: "env" }], messages: [] }
              for (const hook of plugin.hooks[name] ?? []) yield* hook(event)
              return event.system
            })
          const orchestrated = yield* sent(ORCHESTRATOR)
          expect([name, orchestrated.map((part) => count(part.text))]).toEqual([name, [1, 0]])
          expect(orchestrated[0]?.text.startsWith(BUILD_PROMPT)).toBe(true)
          expect(orchestrated[1]?.text).toBe("env")
          expect([name, yield* sent("build")]).toEqual([name, [{ type: "text", text: BUILD_PROMPT }, { type: "text", text: "env" }]])
        }
      }),
    ))
})

describe("a verifier's verdict and a root's compaction, with no machine", () => {
  /** A root's step sessions: each a role's child of `root`, with the hand-back it ends on. */
  const steps = (said: Readonly<Record<string, { readonly agent: string; readonly lastWords?: string; readonly directory?: string }>>) => ({
    root: {},
    ...Object.fromEntries(Object.entries(said).map(([id, session]) => [id, { parentID: "root", ...session }])),
  })
  type Plugin = Effect.Success<ReturnType<typeof start>>
  /** A background step started and answered with its child, as the host does. */
  const begin = (plugin: Plugin, input: Record<string, unknown>, child: string) =>
    Effect.gen(function* () {
      const called = yield* plugin.call("subagent", "root", input)
      expect(called.refused).toBeUndefined()
      yield* plugin.finish({ input, status: "completed", result: { metadata: { sessionID: child, status: "running" } } })
    })
  const verifier = (batch: string) => ({ agent: "verifier", description: `verifier ${batch} r1`, prompt: "v", background: true })

  test("a root that runs units is told its status, its ledger and the re-read once per compaction; a subagent and a root that runs none are not", () =>
    scenario(
      Effect.gen(function* () {
        const runs: ReadonlyArray<Run> = [{ name: "app", units: [{ unit: "alpha", state: "ready" }, { unit: "beta", state: "implement" }] }]
        const plugin = yield* start(
          { now: WEDNESDAY },
          { sessions: { ...steps({ ses_a: { agent: "implementor" } }), quiet: {} }, runs, steps: { root: ["alpha"], ses_a: ["alpha"] } },
        )
        yield* plugin.compacted("root", "evt_1")
        yield* plugin.compacted("root", "evt_1")
        yield* plugin.compacted("ses_a", "evt_2")
        yield* plugin.compacted("quiet", "evt_3")
        yield* eventually(() => expect(plugin.briefs).toHaveLength(1))
        yield* settle
        expect(plugin.briefs).toHaveLength(1)
        const brief = plugin.briefs[0]!
        expect(brief).toMatchObject({ sessionID: "root", delivery: "steer", resume: false, metadata: { [OpenCodeSteer.BRIEF_MARK]: true } })
        expect(brief.text).toBe(
          [
            "orchestrate: run app:",
            "- alpha: ready · no lane",
            "- beta: implement · no lane",
            "next: wait for the hand-backs of beta (implementing).",
            "",
            "Your ledger, as it stood at the compaction:",
            "Queue: nothing open.",
            "Subagents: none running, latched or waiting on you.",
            "Wakes, monitors and jobs: none.",
            "",
            "Re-read ~/.claude/skills/orchestrate/SKILL.md and protocol.md, and your plan, before any other action.",
          ].join("\n"),
        )
      }),
    ))

  test("a second verifier while one runs, and a land of any Rift, are let through: no batch rule refuses", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: steps({ ses_a: { agent: "implementor" }, ses_v: { agent: "verifier" }, ses_w: { agent: "verifier" } }) })
        yield* begin(plugin, { agent: "implementor", description: "implementor alpha r1 (folds: beta/M1) (departs: owner)", prompt: "go", background: true }, "ses_a")
        expect((yield* plugin.call("rift", "root", { action: "land", rifts: ["alpha"] })).refused).toBeUndefined()
        yield* begin(plugin, verifier("batch-1"), "ses_v")
        yield* begin(plugin, verifier("alpha"), "ses_w")
        expect((yield* plugin.call("rift", "root", { action: "land", rifts: ["beta"] })).refused).toBeUndefined()
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

  test("B3: an accepted verdict asks the fleet to record the target its batch file names, by the verifier's report, never its checkout; changes asks nothing", () =>
    scenario(
      Effect.gen(function* () {
        const fleet: Array<FleetTest.Asked> = []
        const sessions = steps({
          ses_v: { agent: "verifier", lastWords: "verifier batch-1 r1: changes /run/batch-1-findings.md", directory: "/checkouts/dotfiles" },
          ses_w: { agent: "verifier", lastWords: "verifier batch-2 r1: accepted /run/batch-2-findings.md", directory: "/checkouts/dotfiles" },
          ses_i: { agent: "implementor", lastWords: "verifier batch-3 r1: accepted /run/batch-3-findings.md" },
        })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, fleet })
        yield* begin(plugin, verifier("batch-1"), "ses_v")
        yield* plugin.idle("ses_v")
        yield* begin(plugin, { agent: "implementor", description: "implementor alpha r1", prompt: "go", background: true }, "ses_i")
        yield* plugin.idle("ses_i")
        yield* settle
        expect(fleet).toEqual([])
        yield* begin(plugin, verifier("batch-2"), "ses_w")
        yield* plugin.idle("ses_w")
        yield* eventually(() => expect(fleet).toEqual([{ report: "/run/batch-2-findings.md", batch: "batch-2" }]))
        // The verifier goes idle again on the same verdict: published once.
        yield* plugin.idle("ses_w")
        yield* plugin.idle("ses_w")
        yield* settle
        expect(fleet).toEqual([{ report: "/run/batch-2-findings.md", batch: "batch-2" }])
      }),
    ))

  test("M1, M2: an accepted batch whose target is refused says NOT published where the orchestrator reads it: its root's context and the run's log.md; a published one only logs", () =>
    scenario(
      Effect.gen(function* () {
        const fleet: Array<FleetTest.Asked> = []
        const logged: Array<{ readonly near: string; readonly line: string }> = []
        const sessions = steps({
          ses_v: { agent: "verifier", lastWords: "verifier batch-1 r1: accepted /run/batch-1-findings.md", directory: "/checkouts/dotfiles" },
          ses_w: { agent: "verifier", lastWords: "verifier batch-2 r1: accepted /run/batch-2-findings.md", directory: "/checkouts/dotfiles" },
        })
        const target = { dotfiles: "d".repeat(40), fork: "f".repeat(40), batch: "batch-1" }
        const outcomes = new Map<string, FleetOutcome>([
          ["batch-1", FleetOutcome.Recorded({ target })],
          ["batch-2", FleetOutcome.Refused({ reason: "the batch file /run/batch-2.md lacks the fork head" })],
        ])
        const fleetOutcome = (asked: FleetTest.Asked) => Option.getOrElse(Option.fromNullishOr(outcomes.get(asked.batch)), () => FleetOutcome.Off())
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, fleet, fleetOutcome, records: { seen: new Map(), logged } })
        yield* begin(plugin, verifier("batch-1"), "ses_v")
        yield* plugin.idle("ses_v")
        yield* eventually(() => expect(logged.some((each) => each.line.includes("fleet: batch-1 accepted; published the verified target"))).toBe(true))
        expect(plugin.briefs.filter((brief) => brief.description === FLEET_DESCRIPTION)).toEqual([])
        yield* begin(plugin, verifier("batch-2"), "ses_w")
        yield* plugin.idle("ses_w")
        const said = "fleet: batch-2 accepted, but NOT published: the batch file /run/batch-2.md lacks the fork head. Every host stays on the last published target."
        yield* eventually(() => expect(plugin.briefs.filter((brief) => brief.description === FLEET_DESCRIPTION)).toHaveLength(1))
        const [told] = plugin.briefs.filter((brief) => brief.description === FLEET_DESCRIPTION)
        expect([told?.sessionID, told?.text.endsWith(said)]).toEqual(["root", true])
        const refusals = logged.filter((each) => each.line.endsWith(said))
        expect(refusals.map((each) => each.near)).toEqual(["/run/batch-2-findings.md"])
      }),
    ))

  test("M1, M2: another repository's accepted batch (a Bite verifier's, no heads line) is none of the fleet's: no record, no notice, no log; a dotfiles one still publishes", () =>
    scenario(
      Effect.gen(function* () {
        const fleet: Array<FleetTest.Asked> = []
        const logged: Array<{ readonly near: string; readonly line: string }> = []
        const bite = "/workspaces/.work/bite/scratchpad/batches/batch-288-findings.md"
        const sessions = steps({
          ses_b: { agent: "verifier", lastWords: `verifier batch-288 r1: accepted ${bite}`, directory: "/workspaces/.work/bite/verify-batch-288" },
          ses_d: { agent: "verifier", lastWords: "verifier batch-1 r1: accepted /run/batch-1-findings.md", directory: "/checkouts/dotfiles" },
        })
        const target = { dotfiles: "d".repeat(40), fork: "f".repeat(40), batch: "batch-1" }
        // Were the Bite batch recorded, its batch file would be refused: it has no heads line.
        const fleetOutcome = (asked: FleetTest.Asked) => {
          if (asked.batch === "batch-1") return FleetOutcome.Recorded({ target })
          return FleetOutcome.Refused({ reason: `the batch file ${asked.batch}.md has no heads line; write one` })
        }
        const fleetCovers = (directory: string) => Option.some(directory.startsWith("/checkouts/dotfiles"))
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, fleet, fleetOutcome, fleetCovers, records: { seen: new Map(), logged } })
        yield* begin(plugin, verifier("batch-288"), "ses_b")
        yield* plugin.idle("ses_b")
        yield* begin(plugin, verifier("batch-1"), "ses_d")
        yield* plugin.idle("ses_d")
        yield* eventually(() => expect(logged.some((each) => each.line.includes("fleet: batch-1 accepted; published the verified target"))).toBe(true))
        expect(fleet).toEqual([{ report: "/run/batch-1-findings.md", batch: "batch-1" }])
        expect(plugin.briefs.filter((brief) => brief.description === FLEET_DESCRIPTION)).toEqual([])
        expect(logged.filter((each) => each.line.includes("batch-288"))).toEqual([])
      }),
    ))

  test("M1, M2: a verifier's hand-back with a parenthetical between its verdict and its findings path records by that path", () =>
    scenario(
      Effect.gen(function* () {
        const fleet: Array<FleetTest.Asked> = []
        const findings = "/private/var/folders/qd/T/opencode/verify-1115cj/batch-2026-11-15cj-findings.md"
        const sessions = steps({
          ses_v: {
            agent: "verifier",
            lastWords: `verifier batch-2026-11-15cj r1: accepted (sidebar-fit accepted, status-pct accepted) ${findings}\n\nTwo units accepted.`,
            directory: "/checkouts/dotfiles",
          },
        })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions, fleet })
        yield* begin(plugin, verifier("batch-2026-11-15cj"), "ses_v")
        yield* plugin.idle("ses_v")
        yield* eventually(() => expect(fleet).toEqual([{ report: findings, batch: "batch-2026-11-15cj" }]))
      }),
    ))

  test("M1, M2: a verifier whose folder is no git checkout falls back to its root's folder: a dotfiles root publishes, another repository's root stays silent", () =>
    scenario(
      Effect.gen(function* () {
        // The plain folder's origin does not read; a checkout answers whether it is the dotfiles.
        const fleetCovers = (directory: string) =>
          Option.liftPredicate(directory.startsWith("/checkouts/dotfiles"), () => directory.startsWith("/checkouts/"))
        const run = (rootDirectory: string) =>
          Effect.gen(function* () {
            const fleet: Array<FleetTest.Asked> = []
            const sessions = {
              ...steps({ ses_v: { agent: "verifier", lastWords: "verifier batch-1 r1: accepted /run/batch-1-findings.md", directory: "/tmp/run" } }),
              root: { directory: rootDirectory },
            }
            const plugin = yield* start({ now: WEDNESDAY }, { sessions, fleet, fleetCovers })
            yield* begin(plugin, verifier("batch-1"), "ses_v")
            yield* plugin.idle("ses_v")
            return fleet
          })
        const dotfiles = yield* run("/checkouts/dotfiles")
        yield* eventually(() => expect(dotfiles).toEqual([{ report: "/run/batch-1-findings.md", batch: "batch-1" }]))
        const bite = yield* run("/checkouts/bite")
        yield* settle
        expect(bite).toEqual([])
      }),
    ))
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
    place: KNOWLTON,
    fullAgent: false,
    codex: { providers: ["openai"], script: CODEX_BUDGET },
    unitLog: UNIT_LOG,
    skill: SKILL_DIR,
    subagents: SUBAGENTS,
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
      now: Date.parse(WEDNESDAY),
      place,
      fullAgent: true,
      codex: { providers: ["openai", "sim"], script: CODEX_BUDGET },
      unitLog: UNIT_LOG,
      skill: SKILL_DIR,
      subagents: "orchestrator",
    })
    expect(decode({ subagents: "owner" }).subagents).toBe("owner")
    expect(decode({ skill: "/s" }).skill).toBe("/s")
    expect(decode({ codex: false }).codex).toBe(false)
    expect(decode({ codex: { pool: true } }).codex).toEqual({ ...defaults.codex, pool: true })
    expect(decode({ planner: { model: "anthropic/claude-fable-5-2" } }).planner).toEqual({ model: "anthropic/claude-fable-5-2" })
    // The A/B's option an earlier install wrote is ignored: the planner has a first model only by `planner`.
    expect(decode({ experiment: { role: "planner", model: "anthropic/claude-fable-5-2", share: 0.5 } }).planner).toBeUndefined()
    // The batch machine's options an older install wrote are ignored: no ledger, cadence, guard or drops journal is kept.
    expect(decode({ ledger: "/m.jsonl", cadence: { ready: 0, waitMs: 1 }, guard: "loud", drops: "/d.jsonl" })).toEqual(defaults)
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
