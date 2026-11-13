// The heavy-check footer at the plugin seam: the composition root on a
// stand-in host whose cores, load and heavy agents working the test fixes
// (memory/heavy-host.ts), with every other outside system a test layer. It
// checks the prompt the host's subagent tool receives: a new implementor's,
// a follow-up's, a batch verifier's after its folds, and a latched
// implementor's as its latch opens, each ending with exactly one footer at
// the share of the moment it is sent; a planner's and a worker's untouched.
// A kernel cell's `tools.subagent` call reaches the same `execute.before` hook
// with the same input, so it gets the same footer: the hook reads the agent
// and the prompt, never the call id cells share. Its tests register through
// sim-tui/effect-test.ts, as lint's do: a body is an Effect on the fork's
// Effect, which this package resolves too.
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Option, Predicate, Queue, Stream } from "effect"
import { type Latch, type LatchAsk, OPENER } from "@dotfiles/opencode-wake/latch"
import { working } from "@dotfiles/opencode-orchestrate/filestore/heavy-agents"
import { findingsIn } from "@dotfiles/opencode-orchestrate/filestore/findings"
import * as FileUnitLogs from "@dotfiles/opencode-orchestrate/filestore/unit-logs"
import { FOOTER_MARK, footerOf, shareOf, withFooter } from "@dotfiles/opencode-orchestrate/heavy"
import { NO_HOLDS } from "@dotfiles/opencode-orchestrate/idle"
import { DEFAULT_CADENCE } from "@dotfiles/opencode-orchestrate/machine"
import * as CallLogTest from "@dotfiles/opencode-orchestrate/memory/call-log"
import * as CodexAdmissionTest from "@dotfiles/opencode-orchestrate/memory/codex-admission"
import * as FleetTest from "@dotfiles/opencode-orchestrate/memory/fleet"
import * as HeavyHostTest from "@dotfiles/opencode-orchestrate/memory/heavy-host"
import * as MemoryLedger from "@dotfiles/opencode-orchestrate/memory/ledger"
import * as ModelsTest from "@dotfiles/opencode-orchestrate/memory/models"
import * as PoolPaceTest from "@dotfiles/opencode-orchestrate/memory/pool-pace"
import * as SessionsTest from "@dotfiles/opencode-orchestrate/memory/sessions"
import * as SkillTest from "@dotfiles/opencode-orchestrate/memory/skill"
import * as StepLogTest from "@dotfiles/opencode-orchestrate/memory/step-log"
import * as OpenCodeLatches from "@dotfiles/opencode-orchestrate/opencode/latches"
import { Branches, Findings, HostUnread, Liveness, Remind, RootHolds, Runs, Steer, Tell } from "@dotfiles/opencode-orchestrate/service"
import { TestClock } from "effect/testing"
import { effectTest } from "../../sim-tui/effect-test.ts"
import Orchestrate, { type Background, make } from "./server.ts"

/** Wednesday 4 November 2026, 10:00 in Knowlton: no Sabbath. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const NOW = Date.UTC(2026, 10, 4, 15)
/** What the subagent tool tells a new child first; a latched child is told it as it opens. */
const SPAWNED = "You are a subagent spawned by another session."
const MODEL = { providerID: "anthropic", id: "claude-opus" }
const HELD = { anthropic: { ok: false, measured: true, reason: "all pool accounts are held", retryAt: NOW + 600_000 } }
const TIMEOUT_MS = 30_000
/** The units' log writer: the plugin finds no unit dir in these tests, so it never runs it. */
const LOG_SCRIPT = "/nonexistent/loop-probe-x/log.ts"

type Host = Parameters<(typeof Orchestrate)["effect"]>[0]

/** A subagent or rift call's input, as these tests send it. */
interface CallInput {
  readonly agent?: string
  readonly description?: string
  readonly prompt?: string
  readonly sessionID?: string
  readonly background?: boolean
  readonly model?: string
  readonly action?: string
  readonly rifts?: ReadonlyArray<string>
}

/** A hook's event as the host hands it: the plugin may rewrite `input`. */
interface HookEvent {
  readonly tool?: string
  readonly sessionID: string
  readonly agent?: string
  readonly messageID?: string
  readonly id?: string
  input?: CallInput
  readonly status?: string
  readonly result?: { readonly metadata?: { readonly sessionID: string; readonly status: string }; readonly content?: ReadonlyArray<{ readonly type: string; readonly text: string }> }
  readonly background?: ReadonlyArray<string>
}

type Hook = (event: HookEvent) => Effect.Effect<void, { readonly message: string }>

/** The subagent tool as the host's editor holds it: what the plugin replaces. */
interface EditedTool {
  execute: (input: CallInput, context: { readonly sessionID: string }) => Effect.Effect<{ readonly output: { readonly sessionID: string }; readonly content: string }>
  output?: object
}

/** What a tool transform is handed: the editor's `update`. */
interface ToolEditor {
  readonly update: (id: string, edit: (tool: EditedTool) => void) => void
}

/** The outside systems' state for one test. */
interface World {
  readonly heavy: HeavyHostTest.MemoryHost
  readonly sessions?: Readonly<Record<string, SessionsTest.Session>>
  /** The pool's pace on each provider; none named is not pooled. */
  readonly pool?: typeof HELD
  readonly kept?: Array<LatchAsk & { readonly child: string }>
  /** The files a verifier's report names, by path. */
  readonly files?: ReadonlyMap<string, string>
}

/** The plugin started on a stand-in host, with the hooks a test drives. */
const start = (world: World) =>
  Effect.gen(function* () {
    const hooks = new Map<string, Array<Hook>>()
    const toolTransforms: Array<(editor: ToolEditor) => void> = []
    const openers: Array<(latch: Latch) => Effect.Effect<unknown>> = []
    const published = yield* Queue.unbounded<{ readonly type: string }>()
    const register = (name: string, callback: Hook) =>
      Effect.sync(() => {
        hooks.set(name, [...(hooks.get(name) || []), callback])
        return { dispose: Effect.void }
      })
    const stub = {
      options: { now: WEDNESDAY },
      agent: { transform: () => Effect.succeed({ dispose: Effect.void }), reload: () => Effect.void },
      session: { hook: register, get: () => Effect.succeed({ location: { directory: "/work" } }), context: () => Effect.succeed([]) },
      location: { directory: "/work" },
      shell: { hook: register },
      event: { subscribe: () => Stream.fromQueue(published) },
      tool: {
        hook: register,
        transform: (callback: (editor: ToolEditor) => void) =>
          Effect.sync(() => {
            toolTransforms.push(callback)
            return { dispose: Effect.void }
          }),
      },
      rpc: {
        register: (definition: { readonly id: string }, handlers: { readonly open?: (latch: Latch) => Effect.Effect<unknown> }) =>
          Effect.sync(() => {
            if (definition.id === OPENER.id && Predicate.isFunction(handlers.open)) openers.push(handlers.open)
            return { dispose: Effect.void, events: { emit: () => Effect.void } }
          }),
      },
    }
    /** The stand-in host is the plugin context in every part the plugin reads. */
    const isHost = (value: typeof stub): value is typeof stub & Host =>
      Predicate.hasProperty(value, "session") && Predicate.hasProperty(value, "tool") && Predicate.hasProperty(value, "rpc") && Predicate.hasProperty(value, "event")
    if (!isHost(stub)) return yield* Effect.die("the stand-in host lacks a part the plugin reads")
    const kept = world.kept || []
    const keep = (ask: LatchAsk) =>
      Effect.sync(() => {
        const child = `ses_latched${kept.length + 1}`
        kept.push({ ...ask, child })
        return { outcome: "latched" as const, id: `w00000${kept.length}`, child }
      })
    const files = world.files || new Map<string, string>()
    const externals = (latchStart: OpenCodeLatches.Start, background: Background) =>
      Layer.mergeAll(
        MemoryLedger.layer(DEFAULT_CADENCE),
        Layer.succeed(Findings, Findings.of({ read: (report) => Effect.sync(() => findingsIn(report, (path) => files.get(path))) })),
        Layer.succeed(Liveness, Liveness.of({ alive: (sessionID) => Effect.succeed(background(sessionID) > 0) })),
        Layer.succeed(Branches, Branches.of({ of: (path) => Effect.sync(() => new Map<string, string>().get(path)) })),
        Layer.succeed(Remind, Remind.of({ remind: () => Effect.void })),
        CallLogTest.layer([]),
        SessionsTest.layer(world.sessions || {}),
        ModelsTest.layer(MODEL, ["medium"]),
        PoolPaceTest.layer(world.pool || {}),
        CodexAdmissionTest.layer(() => ({ ok: true, measured: false, reason: "not asked here" })),
        OpenCodeLatches.layer(keep, latchStart),
        FileUnitLogs.layer(LOG_SCRIPT, { journal: "/nonexistent/loop-probe-x/drops.jsonl" }),
        StepLogTest.layer({}),
        Layer.succeed(Runs, Runs.of({ list: Effect.succeed([]) })),
        Layer.succeed(RootHolds, RootHolds.of({ of: () => Effect.succeed(NO_HOLDS) })),
        Layer.succeed(Steer, Steer.of({ nudge: () => Effect.void })),
        Layer.succeed(Tell, Tell.of({ tell: () => Effect.void })),
        SkillTest.skill({ history: [] }),
        SkillTest.records({ seen: new Map() }),
        FleetTest.layer([]),
      )
    yield* make(
      (_ctx, _options, latchStart, background) => externals(latchStart, background),
      () => HeavyHostTest.layer(world.heavy),
    ).effect(stub)

    // The subagent tool, as the host's editor holds it after the plugin's transform: it records each run's input.
    const ran: Array<CallInput> = []
    const subagent: EditedTool = {
      execute: (input) =>
        Effect.sync(() => {
          ran.push(input)
          return { output: { sessionID: "ses_ran" }, content: "working" }
        }),
    }
    for (const transform of toolTransforms)
      transform({
        update: (id, edit) => {
          if (id === "subagent") edit(subagent)
        },
      })

    const run = (name: string, event: HookEvent) => Effect.forEach(hooks.get(name) || [], (hook) => hook(event), { discard: true })
    /** One tool call through the `execute.before` hooks: the input the tool then runs with, and whether a hook refused it. */
    const call = Effect.fn("HeavyFooterTest.call")(function* (tool: string, input: CallInput) {
      const event: HookEvent = { tool, sessionID: "root", agent: "build", messageID: "msg", id: "call", input }
      const exit = yield* Effect.exit(run("execute.before", event))
      return { refused: Exit.isFailure(exit), input: event.input || {} }
    })
    /** A tool call returning through the `execute.after` hooks. */
    const finish = (event: Omit<HookEvent, "sessionID" | "agent" | "messageID" | "id">) =>
      run("execute.after", { tool: "subagent", sessionID: "root", agent: "build", messageID: "msg", id: "call", ...event })
    /** The session ends its turn. */
    const idle = (sessionID: string) => run("experimental.idle", { sessionID, background: [] })
    /** A background step started and answered with its child, as the host does: the prompt it was sent. */
    const begin = Effect.fn("HeavyFooterTest.begin")(function* (input: CallInput, child: string) {
      const called = yield* call("subagent", input)
      expect(called.refused).toBe(false)
      yield* finish({ input, status: "completed", result: { metadata: { sessionID: child, status: "running" } } })
      return String(called.input.prompt)
    })
    /** A rift land, let through and answered as one push. */
    const land = Effect.fn("HeavyFooterTest.land")(function* (rifts: ReadonlyArray<string>) {
      const input = { action: "land", rifts }
      expect((yield* call("rift", input)).refused).toBe(false)
      yield* finish({ tool: "rift", input, status: "completed", result: { content: [{ type: "text", text: `Landed ${rifts.length} Rift(s) as one push` }] } })
    })
    /** The wakes asking the opener to open the latch they kept for `ask`. */
    const open = (ask: LatchAsk & { readonly child: string }) => {
      const { child, ...rest } = ask
      const latch: Latch = { kind: "latch", id: "w000001", directory: "/work", setAt: NOW, child, ...rest }
      return Effect.forEach(openers, (opener) => opener(latch))
    }
    return { call, idle, begin, land, open, ran, kept }
  })

const scenario = <A, E>(name: string, body: Effect.Effect<A, E, import("effect").Scope.Scope>) => effectTest(name, Effect.scoped(body), TIMEOUT_MS)

const count = (text: string) => text.split(FOOTER_MARK).length - 1
/** The prompt ends with exactly one footer, and it is `footer`. */
const endsWithOne = (prompt: string, footer: string) => {
  expect(prompt).toEndWith(`\n\n${footer}`)
  expect(count(prompt)).toBe(1)
}

describe("the heavy footer", () => {
  scenario(
    "(a) a new implementor's prompt ends with one footer, its share counting the heavy agents working",
    Effect.gen(function* () {
      const heavy = HeavyHostTest.host(12, 1)
      const plugin = yield* start({ heavy })
      const called = yield* plugin.call("subagent", { agent: "implementor", description: "implementor alpha r1", prompt: "Spec: /run/alpha/spec.md" })
      expect(called.refused).toBe(false)
      // 12 cores, one other heavy agent working: 12 / 3 = 4, never the 6 the cores alone would give.
      expect(called.input.prompt).toBe(`Spec: /run/alpha/spec.md\n\n${footerOf("implementor", 4, 12)}`)
      expect(heavy.asked).toEqual([Option.none()])
    }),
  )

  scenario(
    "(b) an implementor's follow-up by sessionID ends with one footer, though its prompt carries an older one; it is not counted itself",
    Effect.gen(function* () {
      const heavy = HeavyHostTest.host(64, 2)
      const plugin = yield* start({ heavy, sessions: { root: {}, impl: { parentID: "root", agent: "implementor" } } })
      const plain = yield* plugin.call("subagent", { sessionID: "impl", prompt: "go on" })
      expect(plain.refused).toBe(false)
      expect(plain.input.prompt).toBe(`go on\n\n${footerOf("implementor", 16, 64)}`)
      // An orchestrator that pasted the last prompt back, footer and all: still one footer, the newest.
      heavy.working = 6
      const pasted = yield* plugin.call("subagent", { sessionID: "impl", prompt: `go on\n\n${footerOf("implementor", 16, 64)}\nand fix M1` })
      endsWithOne(String(pasted.input.prompt), footerOf("implementor", 8, 64))
      expect(pasted.input.prompt).toStartWith("go on\n\n")
      expect(heavy.asked).toEqual([Option.some("impl"), Option.some("impl")])
    }),
  )

  scenario(
    "(c) a batch verifier's prompt ends with one footer, after its (folds: …) addition",
    Effect.gen(function* () {
      const report = "/run/alpha/round-1-findings.md"
      const sessions = {
        root: {},
        ses_a: { parentID: "root", agent: "implementor", lastWords: "implementor alpha r1: ready x" },
        ses_v: { parentID: "root", agent: "verifier", lastWords: `verifier batch-1 r1: changes ${report}` },
        ses_f: { parentID: "root", agent: "implementor", lastWords: "implementor alpha-fix1 r1: ready x" },
      }
      const heavy = HeavyHostTest.host(12, 0)
      const plugin = yield* start({ heavy, sessions, files: new Map([[report, "changes\n\n## Major\n\n### M1 — the footer\n"]]) })
      yield* plugin.begin({ agent: "implementor", description: "implementor alpha r1", prompt: "go", background: true }, "ses_a")
      yield* plugin.idle("ses_a")
      yield* plugin.land(["alpha"])
      const first = yield* plugin.begin({ agent: "verifier", description: "verifier batch-1 r1", prompt: "verify batch-1", background: true }, "ses_v")
      endsWithOne(first, footerOf("verifier", 6, 12))
      yield* plugin.idle("ses_v")
      yield* plugin.begin({ agent: "implementor", description: "implementor alpha-fix1 r1 (folds: alpha/M1)", prompt: "fix alpha/M1", background: true }, "ses_f")
      yield* plugin.idle("ses_f")
      yield* plugin.land(["alpha-fix1"])
      heavy.working = 2
      const two = yield* plugin.call("subagent", { agent: "verifier", description: "verifier batch-2 r1", prompt: "verify batch-2", background: true })
      expect(two.refused).toBe(false)
      const prompt = String(two.input.prompt)
      expect(prompt).toStartWith("verify batch-2\n\nFindings of the batch before, folded into this batch")
      expect(prompt).toContain("- batch-1 alpha/M1 → alpha-fix1")
      endsWithOne(prompt, footerOf("verifier", 4, 12))
      expect(prompt.indexOf("- batch-1 alpha/M1 → alpha-fix1")).toBeLessThan(prompt.indexOf(FOOTER_MARK))
    }),
  )

  scenario(
    "(d) a latched implementor's prompt gets its footer as the latch opens, at the share of that moment",
    Effect.gen(function* () {
      const heavy = HeavyHostTest.host(64, 0)
      const kept: Array<LatchAsk & { readonly child: string }> = []
      const held = yield* start({ heavy, pool: HELD, kept })
      const latched = yield* held.call("subagent", { agent: "implementor", description: "implementor alpha r1", prompt: "go" })
      expect(latched.refused).toBe(false)
      expect(latched.input.sessionID).toBe("ses_latched1")
      // The latch keeps the prompt as asked; the share it would have had now (32) is not the one it opens with.
      expect(kept.map((ask) => ask.subagent.prompt)).toEqual(["go"])
      heavy.working = 6
      const later = yield* start({ heavy })
      expect(yield* later.open(kept[0]!)).toEqual([{ outcome: "opened" }])
      expect(later.ran.map((input) => input.prompt)).toEqual([withFooter(`${SPAWNED}\ngo`, footerOf("implementor", shareOf(64, 6), 64))])
      expect(later.ran.map((input) => input.prompt)).toEqual([`${SPAWNED}\ngo\n\n${footerOf("implementor", 8, 64)}`])
      expect(heavy.asked.at(-1)).toEqual(Option.some("ses_latched1"))
    }),
  )

  scenario(
    "a planner's and a worker's prompt are unchanged, byte for byte, started or latched",
    Effect.gen(function* () {
      const heavy = HeavyHostTest.host(12, 0)
      const prompt = "Plan it.\n\n  Keep the trailing space. "
      const plugin = yield* start({ heavy, sessions: { root: {}, kid: { parentID: "root", agent: "worker" } } })
      expect((yield* plugin.call("subagent", { agent: "planner", description: "planner alpha r1", prompt })).input.prompt).toBe(prompt)
      expect((yield* plugin.call("subagent", { agent: "worker", description: "Survey the call sites", prompt })).input.prompt).toBe(prompt)
      expect((yield* plugin.call("subagent", { description: "Survey the call sites", prompt })).input.prompt).toBe(prompt)
      expect((yield* plugin.call("subagent", { sessionID: "kid", prompt })).input.prompt).toBe(prompt)
      const kept: Array<LatchAsk & { readonly child: string }> = []
      const held = yield* start({ heavy, pool: HELD, kept })
      yield* held.call("subagent", { agent: "planner", description: "planner beta r1", prompt })
      const later = yield* start({ heavy })
      yield* later.open(kept[0]!)
      expect(later.ran.map((input) => input.prompt)).toEqual([`${SPAWNED}\n${prompt}`])
      expect(heavy.asked).toEqual([])
    }),
  )

  scenario(
    "with the host's reading failing, the footer takes the host's cores and no agent working, and the start goes on",
    Effect.gen(function* () {
      const heavy = { ...HeavyHostTest.host(12, 5), failing: Option.some("loadavg does not read") }
      const plugin = yield* start({ heavy })
      const called = yield* plugin.call("subagent", { agent: "implementor", description: "implementor alpha r1", prompt: "go" })
      expect(called.refused).toBe(false)
      expect(called.input.prompt).toBe(`go\n\n${footerOf("implementor", 6, 12)}`)
    }),
  )
})

describe("the heavy agents working (filestore/heavy-agents.ts)", () => {
  const log = [
    `{"kind":"call","at":"2026-11-04T14:00:00.000Z","sessionID":"root","callID":"a","from":"build","agent":"implementor","reason":"kept","child":"one"}`,
    `{"kind":"call","at":"2026-11-04T14:30:00.000Z","sessionID":"root","callID":"b","from":"build","agent":"implementor","reason":"kept","child":"two"}`,
    `{"kind":"call","at":"2026-11-04T14:45:00.000Z","sessionID":"other","callID":"c","from":"build","agent":"verifier","reason":"kept","child":"three"}`,
    `{"kind":"call","at":"2026-11-04T14:50:00.000Z","sessionID":"other","callID":"d","from":"build","agent":"implementor","reason":"kept","child":"ended"}`,
  ].join("\n")
  const count = working(Effect.succeed(log), (sessionID) => Effect.succeed(sessionID !== "ended"))

  scenario(
    "counts the heavy children of the log whose session still works, never the one asking; a start past twelve hours is not read",
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      expect(yield* count(Option.none())).toBe(3)
      expect(yield* count(Option.some("two"))).toBe(2)
      // Twelve hours before 02:20 is 14:20: the 14:00 start is no longer read.
      yield* TestClock.setTime(Date.UTC(2026, 10, 5, 2, 20))
      expect(yield* count(Option.none())).toBe(2)
    }).pipe(Effect.provide(TestClock.layer())),
  )

  scenario(
    "a log that does not read fails, for the footer to take the host's cores alone",
    Effect.gen(function* () {
      const unread = working(Effect.fail(new HostUnread({ reason: "no log" })), () => Effect.succeed(true))
      expect(yield* Effect.flip(unread(Option.none()))).toEqual(new HostUnread({ reason: "no log" }))
    }),
  )
})
