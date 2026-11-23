// The kept sections in the plugin's storage: the ReplyStyles laws over a
// stand-in storage that keeps JSON as the host's does, then the entry's
// format, a restart that reads it back, and an entry that does not decode.
import { describe, expect } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { replyStylesLaws } from "../memory/reply-style.laws.ts"
import { ReplyStyles } from "../reply-style.ts"
import * as OpenCodeReplyStyles from "./reply-style.ts"

/** Hang guard for the test runner. */
const HANG_GUARD_MS = 30_000
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

/** The host's storage over `entries`: JSON in, JSON out. */
const storage = (entries: Map<string, string>): OpenCodeReplyStyles.Store => ({
  get: (key) => Effect.sync(() => Option.getOrUndefined(Option.map(Option.fromNullishOr(entries.get(key)), fromJson))),
  set: (key, value) => Effect.sync(() => void entries.set(key, toJson(value))),
  remove: (key) => Effect.sync(() => void entries.delete(key)),
})

replyStylesLaws("the plugin's storage", () => OpenCodeReplyStyles.layer(storage(new Map())))

const on = (entries: Map<string, string>) => (body: Effect.Effect<void, never, ReplyStyles>) =>
  body.pipe(Effect.provide(OpenCodeReplyStyles.layer(storage(entries))))

describe("the storage entry", () => {
  effectTest(
    "a kept section is `{ text }` under reply-style:<sessionID>, and a new copy (a restart) answers it",
    Effect.gen(function* () {
      const entries = new Map<string, string>()
      yield* on(entries)(ReplyStyles.use((styles) => Effect.asVoid(styles.keep("ses_a", "S"))))
      expect([...entries]).toEqual([["reply-style:ses_a", '{"text":"S"}']])
      yield* on(entries)(
        Effect.gen(function* () {
          const styles = yield* ReplyStyles
          expect(yield* styles.kept("ses_a")).toEqual(Option.some("S"))
          expect(yield* styles.keep("ses_a", "new words")).toBe("S")
        }),
      )
    }),
    HANG_GUARD_MS,
  )

  effectTest(
    "an entry that does not decode counts as none, and the next keep writes a good one",
    Effect.gen(function* () {
      const entries = new Map([["reply-style:ses_a", '{"words":1}']])
      yield* on(entries)(
        Effect.gen(function* () {
          const styles = yield* ReplyStyles
          expect(yield* styles.kept("ses_a")).toEqual(Option.none())
          expect(yield* styles.keep("ses_a", "S")).toBe("S")
        }),
      )
      expect(entries.get("reply-style:ses_a")).toBe('{"text":"S"}')
    }),
    HANG_GUARD_MS,
  )
})
