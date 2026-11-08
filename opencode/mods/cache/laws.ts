// What every implementation of the RequestLog contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import type { Kept, LedgerLine } from "./request-log.ts"
import { RequestLog } from "./service.ts"

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
