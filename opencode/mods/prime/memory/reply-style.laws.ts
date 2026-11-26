// What every ReplyStyles owes, as a shared test suite. Each implementation's
// test beside it runs the suite over its Layer.
import { describe, expect } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { ReplyStyles } from "../reply-style.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

/** `fresh` gives a new, empty store for each case. */
export const replyStylesLaws = (name: string, fresh: () => Layer.Layer<ReplyStyles>) => {
  const check = (title: string, body: Effect.Effect<void, never, ReplyStyles>) => effectTest(title, body.pipe(Effect.provide(fresh())), hangGuard("unit-law"))
  describe(`${name} keeps the ReplyStyles laws`, () => {
    check(
      "a session keeps nothing until asked; keep keeps the first text and answers it ever after",
      Effect.gen(function* () {
        const styles = yield* ReplyStyles
        expect(yield* styles.kept("ses_a")).toEqual(Option.none())
        expect(yield* styles.keep("ses_a", "first")).toBe("first")
        expect(yield* styles.keep("ses_a", "second")).toBe("first")
        expect(yield* styles.kept("ses_a")).toEqual(Option.some("first"))
      }),
    )
    check(
      "an empty text is kept as a decision too: none, for good",
      Effect.gen(function* () {
        const styles = yield* ReplyStyles
        expect(yield* styles.keep("ses_a", "")).toBe("")
        expect(yield* styles.keep("ses_a", "late")).toBe("")
        expect(yield* styles.kept("ses_a")).toEqual(Option.some(""))
      }),
    )
    check(
      "sessions keep apart; forget drops one session's entry only",
      Effect.gen(function* () {
        const styles = yield* ReplyStyles
        yield* styles.keep("ses_a", "a")
        yield* styles.keep("ses_b", "b")
        yield* styles.forget("ses_a")
        expect(yield* styles.kept("ses_a")).toEqual(Option.none())
        expect(yield* styles.kept("ses_b")).toEqual(Option.some("b"))
      }),
    )
  })
}
