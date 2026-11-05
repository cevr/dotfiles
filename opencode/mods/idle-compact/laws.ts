// What every implementation of the Sessions contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option, type Scope } from "effect"
import { CompactionRefused, Sessions, SessionUnreadable } from "./service.ts"

/** One message of a session's context. */
export type WorldMessage =
  | { readonly kind: "user" }
  | {
      readonly kind: "request"
      readonly startedAt: number
      readonly input: number
      readonly read: number
      readonly write: number
      readonly providerID: string
      readonly modelID: string
      /** The agent it ran under; `build` when absent. */
      readonly agent?: string
    }
  | { readonly kind: "compaction" }

export interface WorldSession {
  /** Where it runs; `/work`, in no workspace, when absent. */
  readonly directory?: string
  readonly workspaceID?: string
  readonly parentID?: string
  readonly title?: string
  readonly running?: boolean
  readonly messages?: ReadonlyArray<WorldMessage>
}

/** The host's state the implementation is set up with. */
export interface World {
  /** The location the implementation serves, as one copy of the plugin: `/work`, in no workspace. */
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  readonly sessions: Readonly<Record<string, WorldSession>>
  readonly models: ReadonlyArray<{
    readonly providerID: string
    readonly modelID: string
    readonly window: number
    readonly ttl?: string
    /** USD per million tokens, as the catalog lists them; absent when it lists none. */
    readonly cost?: { readonly input: number; readonly output: number; readonly read: number; readonly write: number }
    /** The catalog cannot be read for it, or for its provider. */
    readonly unreadable?: boolean
  }>
  /** The agents the host knows, with their own cache lifetime (`request.settings.cacheTTL`); any other cannot be read. */
  readonly agents: Readonly<Record<string, { readonly cacheTTL?: string }>>
  /** Sessions whose compaction the host refuses. */
  readonly refuse?: ReadonlyArray<string>
}

/** An implementation over a world, and the compactions it started. */
export interface Bench {
  readonly layer: Layer.Layer<Sessions>
  readonly compacted: () => ReadonlyArray<string>
}

const request = (
  startedAt: number,
  tokens: { input: number; read: number; write: number },
  providerID = "anthropic",
  modelID = "claude-x",
  agent?: string,
) => ({ kind: "request", startedAt, ...tokens, providerID, modelID, ...(agent === undefined ? {} : { agent }) }) as const

const WORLD: World = {
  location: { directory: "/work" },
  sessions: {
    idle: { title: "Idle", messages: [{ kind: "user" }, request(1_000, { input: 2_000, read: 70_000, write: 3_000 })] },
    compacted: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }), { kind: "compaction" }] },
    again: { messages: [{ kind: "compaction" }, request(5_000, { input: 10, read: 0, write: 8_000 }, "openai", "gpt-5.6")] },
    fresh: { messages: [{ kind: "user" }] },
    turn: { running: true, messages: [request(1_000, { input: 10, read: 90_000, write: 0 })] },
    parent: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 })] },
    worker: { parentID: "parent", title: "worker", running: true },
    done: { parentID: "parent", title: "done" },
    configured: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "anthropic", "claude-long")] },
    unknown: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "acme", "acme-1")] },
    refused: { messages: [] },
    resumed: {
      messages: [
        { kind: "compaction" },
        { kind: "user" },
        request(5_000, { input: 10, read: 0, write: 40_000 }),
        { kind: "user" },
        request(9_000, { input: 10, read: 40_000, write: 9_000 }),
      ],
    },
    priced: { messages: [request(1_000, { input: 10, read: 150_000, write: 0 }, "anthropic", "claude-priced")] },
    // An orchestration role's own five minutes on a model configured for an hour.
    role: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "anthropic", "claude-long", "verifier")] },
    // The same agent on models that configure no lifetime: the provider's default stays.
    roleDefault: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "openai", "gpt-5.6", "verifier")] },
    roleClaude: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "anthropic", "claude-x", "verifier")] },
    // An agent the host cannot read, on a configured model.
    ghost: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "anthropic", "claude-long", "ghost")] },
    // A model whose catalog or provider read fails, and one the catalog does not have, on Anthropic.
    unreadable: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "anthropic", "claude-unreadable")] },
    lost: { messages: [request(1_000, { input: 10, read: 90_000, write: 0 }, "anthropic", "claude-lost")] },
    // The same location written with a trailing separator; another directory; this directory in a workspace.
    trailing: { directory: "/work/", messages: [] },
    elsewhere: { directory: "/other", messages: [request(1_000, { input: 10, read: 90_000, write: 0 })] },
    workspace: { directory: "/work", workspaceID: "wrk_1", messages: [] },
  },
  models: [
    { providerID: "anthropic", modelID: "claude-x", window: 200_000 },
    { providerID: "anthropic", modelID: "claude-long", window: 1_000_000, ttl: "1h" },
    { providerID: "openai", modelID: "gpt-5.6", window: 400_000 },
    { providerID: "anthropic", modelID: "claude-priced", window: 1_000_000, ttl: "1h", cost: { input: 4, output: 20, read: 0.2, write: 5 } },
    { providerID: "anthropic", modelID: "claude-unreadable", window: 1_000_000, ttl: "1h", unreadable: true },
  ],
  agents: { build: {}, verifier: { cacheTTL: "5m" } },
  refuse: ["refused"],
}

const check = <A, E>(bench: (world: World) => Effect.Effect<Bench, never, Scope.Scope>, body: (made: Bench) => Effect.Effect<A, E, Sessions>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const made = yield* bench(WORLD)
        return yield* body(made).pipe(Effect.provide(made.layer))
      }),
    ),
  )

const facts = (sessionID: string) =>
  Effect.gen(function* () {
    return yield* (yield* Sessions).facts(sessionID)
  })

/** `bench` makes a fresh implementation over a world of sessions, their context and the model catalog. */
export const sessionsLaws = (name: string, bench: (world: World) => Effect.Effect<Bench, never, Scope.Scope>) =>
  describe(`${name} keeps the Sessions laws`, () => {
    test("an idle main session's last request: its start, its prompt with cache reads and writes, its cache lifetime and window", () =>
      check(bench, () =>
        Effect.gen(function* () {
          const idle = yield* facts("idle")
          expect(idle.child).toBe(false)
          expect(idle.running).toBe(false)
          expect(idle.busy).toEqual([])
          expect(idle.compacted).toBe(false)
          expect(Option.getOrUndefined(idle.last)).toEqual({
            startedAt: 1_000,
            prompt: 75_000,
            cached: true,
            ttl: Option.some(5 * 60_000),
            window: Option.some(200_000),
          })
        }),
      ))

    test("a compaction after the last request reads as compacted; a request after the compaction does not", () =>
      check(bench, () =>
        Effect.gen(function* () {
          expect((yield* facts("compacted")).compacted).toBe(true)
          const again = yield* facts("again")
          expect(again.compacted).toBe(false)
          expect(Option.map(again.last, (last) => [last.startedAt, last.prompt, last.ttl])).toEqual(
            Option.some([5_000, 8_010, Option.some(30 * 60_000)]),
          )
          expect(Option.isNone((yield* facts("fresh")).last)).toBe(true)
        }),
      ))

    test("the first request after a compaction is told apart from later ones: it only loaded the summary", () =>
      check(bench, () =>
        Effect.gen(function* () {
          expect((yield* facts("again")).onSummary).toBe(true)
          expect((yield* facts("resumed")).onSummary).toBe(false)
          expect((yield* facts("idle")).onSummary).toBe(false)
          expect((yield* facts("compacted")).onSummary).toBe(false)
        }),
      ))

    test("a request on a model the catalog prices carries its prices, Anthropic's told; an unpriced one carries none", () =>
      check(bench, () =>
        Effect.gen(function* () {
          expect(Option.map((yield* facts("priced")).last, (last) => last.price)).toEqual(
            Option.some({ rates: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }], anthropic: true }),
          )
          expect(Option.map((yield* facts("idle")).last, (last) => last.price)).toEqual(Option.some(undefined))
        }),
      ))

    test("a running execution, a running subagent and a subagent's own session are told", () =>
      check(bench, () =>
        Effect.gen(function* () {
          expect((yield* facts("turn")).running).toBe(true)
          expect((yield* facts("parent")).busy).toEqual(["subagent worker"])
          expect((yield* facts("done")).child).toBe(true)
        }),
      ))

    test("a configured cache.ttl wins over the provider's default; an unknown provider has none", () =>
      check(bench, () =>
        Effect.gen(function* () {
          expect(Option.flatMap((yield* facts("configured")).last, (last) => last.ttl)).toEqual(Option.some(60 * 60_000))
          const unknown = yield* facts("unknown")
          expect(Option.flatMap(unknown.last, (last) => last.ttl)).toEqual(Option.none())
          expect(Option.flatMap(unknown.last, (last) => last.window)).toEqual(Option.none())
        }),
      ))

    test("the lifetime is the one the request got: the model's or provider's configured one, replaced by its agent's own only when one is configured", () =>
      check(bench, () =>
        Effect.gen(function* () {
          const ttl = (sessionID: string) => Effect.map(facts(sessionID), (read) => Option.flatMap(read.last, (last) => last.ttl))
          expect(yield* ttl("role")).toEqual(Option.some(5 * 60_000))
          expect(yield* ttl("roleDefault")).toEqual(Option.some(30 * 60_000))
          expect(yield* ttl("roleClaude")).toEqual(Option.some(5 * 60_000))
          expect(yield* ttl("configured")).toEqual(Option.some(60 * 60_000))
        }),
      ))

    test("a lifetime that cannot be read is unresolved, not the provider's default: the catalog, the provider or the agent fails, or the catalog lost the model", () =>
      check(bench, () =>
        Effect.gen(function* () {
          for (const sessionID of ["unreadable", "lost", "ghost"]) {
            const last = Option.getOrUndefined((yield* facts(sessionID)).last)
            expect(last?.ttl).toEqual(Option.none())
            expect(last?.unresolved).toBeString()
            expect(last?.prompt).toBe(90_010)
          }
          expect(Option.getOrUndefined((yield* facts("configured")).last)?.unresolved).toBeUndefined()
        }),
      ))

    test("a session the host cannot read fails SessionUnreadable naming it", () =>
      check(bench, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(facts("gone"))
          expect(error).toBeInstanceOf(SessionUnreadable)
          expect(error.sessionID).toBe("gone")
        }),
      ))

    test("compact starts the host's compaction; a refusal fails CompactionRefused naming the session", () =>
      check(bench, (made) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions
          yield* sessions.compact("idle")
          expect(made.compacted()).toEqual(["idle"])
          const error = yield* Effect.flip(sessions.compact("refused"))
          expect(error).toBeInstanceOf(CompactionRefused)
          expect(error.sessionID).toBe("refused")
        }),
      ))

    test("recent lists the main sessions of its location only", () =>
      check(bench, () =>
        Effect.gen(function* () {
          const recent = yield* (yield* Sessions).recent
          expect(recent).toContain("idle")
          expect(recent).toContain("trailing")
          expect(recent).not.toContain("worker")
          expect(recent).not.toContain("done")
          expect(recent).not.toContain("elsewhere")
          expect(recent).not.toContain("workspace")
        }),
      ))

    test("it serves the sessions of its own location: the same directory, however written, in the same workspace", () =>
      check(bench, () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.serves("idle")).toBe(true)
          expect(yield* sessions.serves("worker")).toBe(true)
          expect(yield* sessions.serves("trailing")).toBe(true)
          expect(yield* sessions.serves("elsewhere")).toBe(false)
          expect(yield* sessions.serves("workspace")).toBe(false)
          const error = yield* Effect.flip(sessions.serves("gone"))
          expect(error).toBeInstanceOf(SessionUnreadable)
          expect(error.sessionID).toBe("gone")
        }),
      ))
  })
