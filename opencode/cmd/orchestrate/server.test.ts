// The plugin seam: the composition root on a stand-in host, with every
// outside system a test layer. It checks what OpenCode sees: the rewritten
// subagent input, the refusals' words, the call log's lines, the compaction
// prompt and the agents' windows. tests/orchestrate.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { KEEP } from "@dotfiles/opencode-orchestrate/compaction"
import * as CallLogTest from "@dotfiles/opencode-orchestrate/memory/call-log"
import * as CodexAdmissionTest from "@dotfiles/opencode-orchestrate/memory/codex-admission"
import * as CompactionWindowsTest from "@dotfiles/opencode-orchestrate/memory/compaction-windows"
import * as ModelsTest from "@dotfiles/opencode-orchestrate/memory/models"
import * as PoolPaceTest from "@dotfiles/opencode-orchestrate/memory/pool-pace"
import * as SessionsTest from "@dotfiles/opencode-orchestrate/memory/sessions"
import type { Session } from "@dotfiles/opencode-orchestrate/opencode/sessions"
import type { Pace } from "@dotfiles/opencode-orchestrate/pace"
import { definitions } from "@dotfiles/opencode-orchestrate/role"
import { KNOWLTON } from "@dotfiles/opencode-orchestrate/sabbath"
import Orchestrate, { CODEX_BUDGET, DEFAULT_LOG, DEFAULT_WINDOWS, make, Options } from "./server.ts"

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/
const PACE_SCRIPT = resolve(import.meta.dir, "../../scripts/pace.ts")

type Host = Parameters<(typeof Orchestrate)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void, { readonly _tag: string; readonly message: string }>

/** The outside systems' state for one test. */
interface World {
  readonly sessions?: Readonly<Record<string, Session>>
  readonly pool?: Readonly<Record<string, Pace>>
  /** The providers the pool is told a new agent started on, in order. */
  readonly started?: Array<string>
  readonly codex?: (model: string, role: string) => Pace | undefined
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly variants?: ReadonlyArray<string>
  readonly compactJson?: string
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
      tool: { hook: register },
    } as unknown as Host
    const externals = Layer.mergeAll(
      CallLogTest.layer(lines),
      SessionsTest.layer(world.sessions ?? {}),
      ModelsTest.layer(world.model, world.variants),
      PoolPaceTest.layer(world.pool ?? {}, world.started),
      CodexAdmissionTest.layer(world.codex ?? (() => undefined)),
      CompactionWindowsTest.layer(world.compactJson),
    )
    yield* make(() => externals).effect(host)

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
    return { call, finish, logged, hooks, transforms }
  })

const scenario = <A, E>(body: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("over the Sabbath", () => {
  test("no subagent starts, and a running subagent's tools are refused; the main session's are not", () =>
    scenario(
      Effect.gen(function* () {
        const friday = yield* start({ now: FRIDAY_EVENING }, { sessions: { root: {}, child: { parentID: "root" } } })
        const subagent = yield* friday.call("subagent", "root", { prompt: "x" })
        expect(subagent.refused?._tag).toBe("Tool.Error")
        expect(subagent.refused?.message).toEndWith("No agent starts now. Do not retry; start it again once work resumes.")
        expect(subagent.refused?.message.replace(/ No agent starts now.*$/, "")).toMatch(SABBATH)
        const shell = yield* friday.call("shell", "child")
        expect(shell.refused?.message).toEndWith(
          "Stop now: end your turn with one line on where you stopped. Make no more tool calls.",
        )
        expect((yield* friday.call("shell", "root")).refused).toBeUndefined()
        // A subagent call is refused even when its input is not one the tool takes.
        expect((yield* friday.call("subagent", "root", "x")).refused?._tag).toBe("Tool.Error")
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
          '{"kind":"call","sessionID":"root","callID":"call","from":"build","asked":"orchestrate-planner","agent":"planner","reason":"renamed","model":"anthropic/claude#high"}',
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

  test("the pool's hold refuses a new agent, with the wait script and the time to retry", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(
          { now: WEDNESDAY },
          {
            model: { providerID: "anthropic", id: "claude" },
            pool: { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: now + 300_000.5 } },
          },
        )
        const held = yield* plugin.call("subagent", "root", { agent: "explore" })
        expect(held.refused?.message).toBe(
          `orchestrate: the pool's pace holds this agent. all pool accounts are held. Run \`bun '${PACE_SCRIPT}' --wait ${now + 300_001}\` with shell's background:true and go on with other work. When it exits, call subagent again with the same agent and description; admission is checked again. Do not poll.`,
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
        const plugin = yield* start({ now: WEDNESDAY }, { codex })
        const held = yield* plugin.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5#high" })
        expect(held.refused?.message).toStartWith("orchestrate: the Codex account's pace holds this agent. weekly pace. Run")
        expect(held.refused?.message).toContain(`--wait ${now + 60_000}\``)
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
          { codex, pool: { openai: { ok: false, measured: true, reason, retryAt: now + 120_000 } } },
        )
        const refused = (yield* held.call("subagent", "root", { agent: "verifier", model: "openai/gpt-5#high" })).refused
        expect(refused?.message).toStartWith(`orchestrate: the Codex account's pace holds this agent. ${reason}. Run`)
        expect(refused?.message).toContain(`--wait ${now + 120_000}\``)
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

  test("each new agent that starts is told to the pool by its provider; a held one, a follow-up or a Sabbath refusal is not", () =>
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
        expect((yield* plugin.call("subagent", "root", { agent: "explore", model: "sim/model" })).refused).toBeDefined()
        expect((yield* plugin.call("subagent", "root", { sessionID: "child", prompt: "more" })).refused).toBeUndefined()
        expect(started).toEqual(["anthropic", "openai"])
        const friday = yield* start({ now: FRIDAY_EVENING }, { started })
        yield* friday.call("subagent", "root", { agent: "explore" })
        expect(started).toEqual(["anthropic", "openai"])
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

        // The keep-list joins the summary prompt, leaving the system (and so the cached prefix) as it was.
        const system: Array<unknown> = []
        const prompt = ["Summarize."]
        for (const hook of plugin.hooks.compaction ?? []) yield* hook({ system, experimental: { prompt } })
        expect(system).toEqual([])
        expect(prompt).toEqual(["Summarize.", KEEP])
        // A host without the summary prompt takes it as a system part.
        const older: Array<unknown> = []
        for (const hook of plugin.hooks.compaction ?? []) yield* hook({ system: older })
        expect(older).toEqual([{ type: "text", text: KEEP }])
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
