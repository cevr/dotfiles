// The pool's pace over a stand-in for the pool's RPC: the laws, and the
// answers that fail open (no pool, a timeout, a failure, an answer that is
// not a pace), each saying why.
import { expect, test } from "bun:test"
import { Effect, Fiber, Option } from "effect"
import { it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import { poolPaceLaws } from "../laws.ts"
import { PoolPace } from "../service.ts"
import * as OpenCodePoolPace from "./pool-pace.ts"

poolPaceLaws("OpenCode's PoolPace", (world) =>
  OpenCodePoolPace.layer(
    ({ providerID }) =>
      Object.hasOwn(world, providerID) ? Effect.succeed(world[providerID]) : Effect.fail(new Error(`no pool for ${providerID}`)),
    ({ providerID }) => (Object.hasOwn(world, providerID) ? Effect.succeed({}) : Effect.fail(new Error(`no pool for ${providerID}`))),
  ),
)

const told = () => Effect.succeed({})

it.effect("a negotiated launch is one call, fails closed on an outage, and only an absent pool fails open", () => Effect.gen(function* () {
  const calls: Array<unknown> = []
  const ask: OpenCodePoolPace.Ask = () => Effect.sync(() => { calls.push("quote"); return { ok: true, measured: true, reason: "room" } })
  const tell: OpenCodePoolPace.Tell = () => Effect.sync(() => { calls.push("started"); return {} })
  const reserve: OpenCodePoolPace.Reserve = (input) => Effect.sync(() => { calls.push(input); return { ok: true, measured: true, reason: "reserved" } })
  const launch = PoolPace.use((pool) => pool.reserveLaunch("anthropic", "claude-opus-5-5#high", "parent", "one"))
  const on = (query: OpenCodePoolPace.Ask, reservation: OpenCodePoolPace.Reserve) => {
    const plugin = OpenCodePoolPace.layer(query, tell, Option.some(reservation))
    return launch.pipe(Effect.provide(plugin))
  }
  const allowed = (reply: import("../pace.ts").PaceReply) => reply._tag === "Answered" && reply.pace.ok
  expect(allowed(yield* on(ask, reserve))).toBe(true)
  expect(calls).toEqual([{ providerID: "anthropic", model: "claude-opus-5-5", sessionID: "parent", launchID: "one" }])
  const unavailable: OpenCodePoolPace.Reserve = () => Effect.fail({ type: "rpc.internal", message: "store down" })
  expect(allowed(yield* on(ask, unavailable))).toBe(false)
  expect(calls).toHaveLength(1)
  const absent = () => Effect.fail({ type: "rpc.method_not_found", message: "old plugin" })
  expect((yield* on(ask, absent))._tag).toBe("FailedOpen")
  expect(calls.slice(1)).toEqual(["started"])
  expect((yield* on(absent, absent))._tag).toBe("FailedOpen")
}))

/** The reply of a pool whose `pace` method is `ask`. */
const replyOf = (ask: OpenCodePoolPace.Ask) =>
  PoolPace.use((pool) => pool.pace("anthropic")).pipe(Effect.provide(OpenCodePoolPace.layer(ask, told)))

test("the pool is asked of a start's model by its bare id, however it is named, and of the provider alone when none is", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Array<unknown> = []
      const ask: OpenCodePoolPace.Ask = (input) => Effect.sync(() => asked.push(input)).pipe(Effect.as({ ok: true, measured: false, reason: "room" }))
      const pool = OpenCodePoolPace.layer(ask, told)
      yield* PoolPace.use((pace) =>
        Effect.all([
          pace.pace("anthropic", "claude-fable-5-2"),
          pace.pace("anthropic", "anthropic/claude-fable-5-2#high"),
          pace.pace("anthropic", "claude-opus-5-5#max"),
          pace.pace("anthropic"),
          pace.pace("anthropic", "claude-opus-5-5", "ses_parent"),
        ]),
      ).pipe(Effect.provide(pool))
      expect(asked).toEqual([
        { providerID: "anthropic", model: "claude-fable-5-2" },
        { providerID: "anthropic", model: "claude-fable-5-2" },
        { providerID: "anthropic", model: "claude-opus-5-5" },
        { providerID: "anthropic" },
        { providerID: "anthropic", model: "claude-opus-5-5", sessionID: "ses_parent" },
      ])
    }),
  ))

test("a measured answer is the pool's own", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* replyOf(() => Effect.succeed({ ok: true, measured: true, reason: "weekly pace 20% of 57%" }))).toEqual({
        _tag: "Answered",
        pace: { ok: true, measured: true, reason: "weekly pace 20% of 57%" },
      })
    }),
  ))

test("no pool plugin fails open, saying so", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* replyOf(() => Effect.fail({ type: "rpc.unavailable", message: "no plugin answers dotfiles-opencode.pool" }))).toEqual({
        _tag: "FailedOpen",
        why: "no pool: rpc.unavailable (no plugin answers dotfiles-opencode.pool)",
      })
      expect(yield* replyOf(() => Effect.fail({ type: "rpc.method_not_found", message: "" }))).toEqual({
        _tag: "FailedOpen",
        why: "no pool: rpc.method_not_found",
      })
    }),
  ))

test("a failed ask fails open with its error, and a defect with its message", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* replyOf(() => Effect.fail({ type: "rpc.internal", message: "logins unavailable" }))).toEqual({
        _tag: "FailedOpen",
        why: "error: rpc.internal: logins unavailable",
      })
      expect(yield* replyOf(() => Effect.fail(new Error("socket closed")))).toEqual({ _tag: "FailedOpen", why: "error: socket closed" })
      expect(yield* replyOf(() => Effect.die("broken"))).toEqual({ _tag: "FailedOpen", why: "defect: broken" })
    }),
  ))

test("an answer that is not a pace fails open, quoting it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* replyOf(() => Effect.succeed({ ok: "yes" }))).toEqual({ _tag: "FailedOpen", why: 'undecodable: {"ok":"yes"}' })
      expect(yield* replyOf(() => Effect.succeed(undefined))).toEqual({ _tag: "FailedOpen", why: "undecodable: undefined" })
    }),
  ))

test("a pool that does not answer in 8 seconds fails open as a timeout", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reply = yield* Effect.forkChild(replyOf(() => Effect.never))
      yield* TestClock.adjust("8 seconds")
      expect(yield* Fiber.join(reply)).toEqual({ _tag: "FailedOpen", why: "timeout: no answer in 8 seconds" })
    }).pipe(Effect.provide(TestClock.layer())),
  ))
