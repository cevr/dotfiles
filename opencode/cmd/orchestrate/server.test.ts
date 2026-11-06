// The plugin seam: the composition root on a stand-in host, with every
// outside system a test layer. It checks what OpenCode sees: the rewritten
// subagent input, the refusals' words, a latched call's answer and its
// opening, the call log's lines, the compaction prompt and the agents'
// windows. tests/orchestrate.test.ts and tests/prime-latch.test.ts run it in
// OpenCode.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { type Latch, type LatchAsk, Opened } from "@dotfiles/opencode-wake/latch"
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { KEEP } from "@dotfiles/opencode-orchestrate/compaction"
import * as CallLogTest from "@dotfiles/opencode-orchestrate/memory/call-log"
import * as CodexAdmissionTest from "@dotfiles/opencode-orchestrate/memory/codex-admission"
import * as CompactionWindowsTest from "@dotfiles/opencode-orchestrate/memory/compaction-windows"
import * as ModelsTest from "@dotfiles/opencode-orchestrate/memory/models"
import * as PoolPaceTest from "@dotfiles/opencode-orchestrate/memory/pool-pace"
import * as SessionsTest from "@dotfiles/opencode-orchestrate/memory/sessions"
import * as FileUnitLogs from "@dotfiles/opencode-orchestrate/filestore/unit-logs"
import * as OpenCodeLatches from "@dotfiles/opencode-orchestrate/opencode/latches"
import * as OpenCodePoolPace from "@dotfiles/opencode-orchestrate/opencode/pool-pace"
import type { Pace } from "@dotfiles/opencode-orchestrate/pace"
import { definitions } from "@dotfiles/opencode-orchestrate/role"
import { KNOWLTON } from "@dotfiles/opencode-orchestrate/sabbath"
import type { Offered } from "@dotfiles/opencode-orchestrate/service"
import Orchestrate, { CODEX_BUDGET, DEFAULT_LOG, DEFAULT_WINDOWS, make, Options, UNIT_LOG } from "./server.ts"

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
  readonly compactJson?: string
  /** The wakes' refusal of every latch (no wakes plugin, say); absent, they keep each one. */
  readonly refuse?: string
  /** The latches the wakes kept, in order. */
  readonly kept?: Array<LatchAsk & { readonly child: string }>
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
      session: { hook: register },
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
    const externals = (start: OpenCodeLatches.Start) => Layer.mergeAll(
      CallLogTest.layer(lines),
      SessionsTest.layer(world.sessions ?? {}),
      ModelsTest.layer(world.model, world.variants, world.others),
      world.poolAsk === undefined
        ? PoolPaceTest.layer(world.pool ?? {}, world.started)
        : OpenCodePoolPace.layer(world.poolAsk, () => Effect.succeed({})),
      CodexAdmissionTest.layer(world.codex ?? (() => undefined)),
      CompactionWindowsTest.layer(world.compactJson),
      OpenCodeLatches.layer(keep, start),
      FileUnitLogs.layer(LOG_SCRIPT),
    )
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
    for (const transform of toolTransforms) transform({ update: (id: string, edit: (tool: EditedTool) => void) => (id === "subagent" ? edit(subagent) : undefined) })
    /** The subagent tool run with the input the hooks left, in the root session's call. */
    const runTool = (input: unknown) => subagent.execute(input, { sessionID: "root", agent: "build", messageID: "msg", id: "call", progress: () => Effect.void })
    /** The wakes asking the opener to open a latch. */
    const open = (latch: unknown) => {
      const handler = rpc["dotfiles-opencode.wake.opener"]?.open
      return handler === undefined ? Effect.die(new Error("no opener")) : handler(latch)
    }

    /** One tool call through the `execute.before` hooks: the input the tool then runs with, or the refusal. */
    const call = Effect.fn(function* (tool: string, sessionID: string, input: unknown = {}) {
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
    const finish = Effect.fn(function* (result: Record<string, unknown>) {
      const event = { tool: "subagent", sessionID: "root", agent: "build", messageID: "msg", id: "call", input: {}, ...result }
      for (const hook of hooks["execute.after"] ?? []) yield* hook(event)
    })
    /** The log's lines without their wall-clock times, which are checked once. */
    const logged = () => {
      for (const line of lines) expect(Number.isFinite(Date.parse(line.at))).toBe(true)
      return lines.map(({ at: _, ...line }) => JSON.stringify(line))
    }
    /** A session going idle, through the `experimental.idle` hooks. */
    const idle = Effect.fn(function* (sessionID: string) {
      for (const hook of hooks["experimental.idle"] ?? []) yield* hook({ sessionID, background: [] })
    })
    return { call, finish, logged, hooks, transforms, runTool, ran, open, kept, subagent, idle }
  })

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
        const offered = yield* start({ now: WEDNESDAY }, { model, variants: ["high"] })
        expect((yield* offered.call("subagent", "root", { agent: "orchestrate-planner", model: "" })).input).toEqual({
          agent: "planner",
          model: "anthropic/claude#high",
        })
        expect(offered.logged()).toEqual([
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"orchestrate-planner","agent":"planner","reason":"renamed","model":"anthropic/claude#high","pace":{"ok":true,"measured":false,"reason":"provider is not pooled"}}',
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

  test("a light, direct or mechanical step falls back to the newest luna at max", () =>
    scenario(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const plugin = yield* start({ now: WEDNESDAY }, { model, variants: ["medium"], others: codexOffered, codex: admits(asked), pool: held })
        const call = yield* plugin.call("subagent", "root", { agent: "implementor", description: "pkg-lower implementor (mechanical)", prompt: "x" })
        expect((call.input as { model?: string }).model).toBe("openai/gpt-6-luna#max")
        expect(asked).toEqual(["gpt-6-luna implementor"])
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

  test("each role's start and hand-back move its unit in the run's log, once each", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* checkout
        const auth = join(work, "tmp/orchestrate/web/auth")
        mkdirSync(auth, { recursive: true })
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
        // The verifier's start finds the move its implementor's hand-back made.
        yield* plugin.call("subagent", "root", { agent: "general", description: "verifier auth r1", prompt: `Verify ${auth}/round-1-request.md.` })
        yield* plugin.idle("verifier")
        yield* plugin.idle("verifier")
        // Neither a main session, even one running as a role, nor a worker moves a unit, whatever it writes.
        yield* plugin.idle("root")
        yield* plugin.idle("lead")
        yield* plugin.idle("worker")
        yield* plugin.call("subagent", "root", { agent: "worker", description: "implementor auth r1", prompt: "x" })
        yield* plugin.call("subagent", "root", { sessionID: "implementor", description: "implementor auth r2", prompt: `Fix ${auth}/round-1-findings.md.` })
        expect(moves(auth)).toEqual([
          "new → plan r1",
          "plan → implement r1 spec.md",
          "implement → verify r1 round-1-request.md ready",
          "verify → implement r2 round-1-findings.md changes",
        ])
      }),
    ))

  test("a start whose unit dir is not found, or names no round, writes nothing and runs as ever", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* checkout
        const elsewhere = join(work, "notes/auth")
        mkdirSync(join(work, "tmp/orchestrate/web/auth"), { recursive: true })
        mkdirSync(join(work, "tmp/orchestrate/api/auth"), { recursive: true })
        const plugin = yield* start({ now: WEDNESDAY }, { sessions: { root: { directory: work } } })
        // Two runs hold an `auth` unit: the search finds none.
        const call = yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier auth r1", prompt: "x" })
        expect(call).toEqual({ refused: undefined, input: { agent: "verifier", description: "verifier auth r1", prompt: "x" } })
        yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier auth", prompt: `Verify ${elsewhere}/round-1-request.md` })
        for (const dir of ["tmp/orchestrate/web/auth", "tmp/orchestrate/api/auth", "notes/auth"]) expect(existsSync(join(work, dir, "log.md"))).toBe(false)
        // A path the prompt names finds it.
        mkdirSync(elsewhere, { recursive: true })
        yield* plugin.call("subagent", "root", { agent: "verifier", description: "verifier auth r1", prompt: `Verify ${elsewhere}/round-1-request.md` })
        expect(moves(elsewhere)).toEqual(["new → verify r1 round-1-request.md"])
      }),
    ))

  test("a latched role moves its unit when its latch opens and it starts, not when it latches", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* checkout
        const auth = join(work, "tmp/orchestrate/web/auth")
        mkdirSync(auth, { recursive: true })
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

describe("the agents", () => {
  test("each role gets its definition and window, each primary agent root's; compaction keeps the files", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(
          { now: WEDNESDAY },
          { compactJson: JSON.stringify({ windows: { planner: 300_000, root: 600_000 } }) },
        )
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
        expect(agents.build!.request.settings.compactionWindow).toBe(600_000)
        expect(agents.hidden!.request.settings.compactionWindow).toBeUndefined()
        expect(agents.explore!.request.settings.compactionWindow).toBeUndefined()
        expect(agents.planner).toMatchObject({
          description: definitions.planner.description,
          system: definitions.planner.system,
          mode: "subagent",
          permissions: definitions.planner.permissions,
          request: { settings: { compactionWindow: 300_000, cacheTTL: "5m" } },
        })
        expect(agents.worker!.request.settings.compactionWindow).toBe(200_000)
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

describe("the options", () => {
  const decode = Schema.decodeUnknownSync(Options)
  const defaults = {
    windows: DEFAULT_WINDOWS,
    log: DEFAULT_LOG,
    place: KNOWLTON,
    fullAgent: false,
    codex: { providers: ["openai"], script: CODEX_BUDGET },
    unitLog: UNIT_LOG,
  }

  test("each absent option takes its default; an undefined one is absent", () => {
    expect(decode({})).toEqual(defaults)
    expect(decode({ windows: undefined, now: undefined, place: undefined, codex: undefined })).toEqual(defaults)
    expect(decode({ codex: {} }).codex).toEqual(defaults.codex)
  })

  test("the ones given are read as the plugin uses them", () => {
    const place = { name: "Lisbon", lat: 38.7, lon: -9.1, timeZone: "Europe/Lisbon" }
    expect(
      decode({ windows: "/w.json", log: "/l.jsonl", now: WEDNESDAY, place, fullAgent: true, codex: { providers: ["openai", "sim"] } }),
    ).toEqual({
      windows: "/w.json",
      log: "/l.jsonl",
      now: Date.parse(WEDNESDAY),
      place,
      fullAgent: true,
      codex: { providers: ["openai", "sim"], script: CODEX_BUDGET },
      unitLog: UNIT_LOG,
    })
    expect(decode({ codex: false }).codex).toBe(false)
    expect(decode({ codex: { pool: true } }).codex).toEqual({ ...defaults.codex, pool: true })
  })

  test("a malformed option stops the plugin at setup, naming the option", async () => {
    const malformed: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ windows: 1 }, '["windows"]'],
      [{ log: null }, '["log"]'],
      [{ now: "someday" }, '["now"]'],
      [{ place: "home" }, '["place"]'],
      [{ place: { name: "Lisbon" } }, '["place"]["lat"]'],
      [{ fullAgent: "yes" }, '["fullAgent"]'],
      [{ codex: true }, '["codex"]'],
      [{ codex: { providers: ["openai", 7] } }, '["codex"]["providers"][1]'],
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
