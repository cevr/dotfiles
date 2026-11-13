// What every implementation of the RequestLog and PingLog contracts owes, as
// shared test suites. Each implementation's test beside it runs the suite over
// its Layer. Bun test bridge: no Effect test runner is installed, so each case
// runs over its fresh Layer with Effect.runPromise.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import type { PingLine } from "./keepalive.ts"
import type { Kept, LedgerLine } from "./request-log.ts"
import { PingLog, RequestLog } from "./service.ts"

/** A ping that was answered: its usage and limits. */
const answered: PingLine = {
  at: 1,
  host: "mac",
  sessionID: "ses_1",
  agent: Option.some("worker"),
  model: "anthropic/claude-x",
  login: Option.some("cred-a"),
  ping: 1,
  gapMs: 270_000,
  ttlMs: 300_000,
  status: Option.some(200),
  error: Option.none(),
  input: 3,
  read: 90_000,
  write: 0,
  output: 1,
  limits: { "anthropic-ratelimit-unified-5h-utilization": "0.4" },
}

/** A ping that got no answer, from a session with no agent or login named. */
const unanswered: PingLine = {
  ...answered,
  at: 2,
  agent: Option.none(),
  login: Option.none(),
  status: Option.none(),
  error: Option.some("network down"),
  read: 0,
  output: 0,
  limits: {},
}

/** Runs the laws over a fresh, empty ping log from `make`; a scoped Layer's scope closes after each case. */
export const pingLogLaws = <E>(name: string, make: () => Layer.Layer<PingLog, E>) =>
  describe(`${name} owes the PingLog laws`, () => {
    test("lines read back whole, in the order they were appended; an empty log reads none", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const log = yield* PingLog
          expect(yield* log.read).toEqual([])
          const lines = [answered, unanswered, { ...answered, at: 3, ping: 2 }]
          for (const each of lines) yield* log.append(each)
          expect(yield* log.read).toEqual(lines)
        }).pipe(Effect.provide(make())),
      ))
  })

const line = (at: number, cause: LedgerLine["cause"]): LedgerLine => ({
  at,
  host: "mac",
  sessionID: "ses_1",
  messageID: `msg_${at}`,
  kind: "primary",
  agent: "build",
  model: "anthropic/claude-x",
  ttlMs: 3_600_000,
  prompt: 10_000,
  read: 0,
  write: 10_000,
  cause,
  ...(cause === "prefix" ? { change: { segment: "system[1] ¶4", offsetTokens: 3_100, head: "Today is Friday" } } : {}),
})

/** Runs the laws over a fresh, empty log from `make`. */
export const requestLogLaws = (name: string, make: () => Layer.Layer<RequestLog>) =>
  describe(`${name} owes the RequestLog laws`, () => {
    const run = <A, E>(effect: Effect.Effect<A, E, RequestLog>) => Effect.runPromise(effect.pipe(Effect.provide(make())))

    test("an empty log reads no line", async () => {
      expect(await run(Effect.gen(function* () { return yield* (yield* RequestLog).read }))).toEqual([])
    })

    test("lines read back whole, in the order they were appended", async () => {
      const lines = [line(1, "first"), line(2, "prefix"), line(3, "expired")]
      const read = await run(
        Effect.gen(function* () {
          const log = yield* RequestLog
          for (const each of lines) yield* log.append(each)
          return yield* log.read
        }),
      )
      expect(read).toEqual(lines)
    })

    test("a session's kept request reads back whole, the newest in place of the one before; another session's is none", async () => {
      const kept = (at: number): Kept => ({
        sent: {
          at,
          kind: "primary",
          agent: "build",
          model: "anthropic/claude-x",
          login: "cred-a",
          ttlMs: 3_600_000,
          segments: [
            { label: "tool shell", hash: "h1", chars: 40 },
            { label: "system[1] ¶1", hash: "h2", chars: 120, head: "Follow the rules." },
          ],
        },
        tokens: { prompt: 10_000, read: 9_000, write: 1_000 },
        compacted: false,
      })
      const [none, newest, other] = await run(
        Effect.gen(function* () {
          const log = yield* RequestLog
          const none = yield* log.last("ses_1")
          yield* log.keep("ses_1", kept(1))
          yield* log.keep("ses_1", kept(2))
          return [none, yield* log.last("ses_1"), yield* log.last("ses_2")] as const
        }),
      )
      expect(Option.isNone(none)).toBe(true)
      expect(Option.getOrUndefined(newest)).toEqual(kept(2))
      expect(Option.isNone(other)).toBe(true)
    })
  })
