// The `antigravity` tool's words over a source that holds a reading: what the
// orchestrator reads before it starts agy panes, and what a pane's limit records.
import { describe } from "bun:test"
import { Effect, Option, Ref } from "effect"
import { expect, it } from "effect-bun-test"
import { parseLimit } from "./limit.ts"
import type { Source } from "./source.ts"
import { answerAt, EMPTY, Event, evolve, type State } from "./state.ts"
import { statusLines } from "./text.ts"
import { answer } from "./tool.ts"

const NOW = Date.parse("2026-11-24T20:00:00Z")
const HOUR = 3_600_000
const GROUPS = ["gemini", "claude-gpt"]

const reading = evolve(
  evolve(EMPTY, Event.cases.Attempted.make({ id: "r", at: NOW, keychain: false })),
  Event.cases.Read.make({
    attempt: "r",
    at: NOW,
    windows: [
      { group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: NOW + HOUR },
      { group: "gemini", label: "Gemini", span: "7d", used: 0.4, resetAt: NOW + 50 * HOUR },
      { group: "claude-gpt", label: "Claude & GPT (shared)", span: "5h", used: 1, resetAt: NOW + 2 * HOUR },
      { group: "claude-gpt", label: "Claude & GPT (shared)", span: "7d", used: 0.5, resetAt: NOW + 90 * HOUR },
    ],
  }),
)

/** A source over `state` at NOW: reads change nothing, a limit is recorded as the real source records it. */
const fake = (state: Ref.Ref<State>, asked: Ref.Ref<number>): Source => ({
  lines: Effect.map(Ref.get(state), (now) => statusLines(now, NOW)),
  open: (group) =>
    Effect.map(Ref.get(state), (now) =>
      GROUPS.flatMap((name) =>
        Option.toArray(
          Option.map(
            Option.liftPredicate(name, (one) => Option.getOrElse(Option.map(group, (named) => named === one), () => true)),
            (one) => ({ group: one, label: one, answer: answerAt(now, NOW, one) }),
          ),
        ),
      ),
    ),
  record: (text) =>
    Effect.gen(function* () {
      const limit = parseLimit(text, NOW)
      yield* Option.match(limit, {
        onNone: () => Effect.void,
        onSome: (seen) =>
          Ref.update(state, (now) =>
            evolve(now, Event.cases.LimitSeen.make({ limit: Option.match(seen.resetAt, { onNone: () => ({ seenAt: NOW }), onSome: (at) => ({ seenAt: NOW, resetAt: at }) }) })),
          ),
      })
      return limit
    }),
  clear: () => Effect.void,
  read: (consent) =>
    Effect.gen(function* () {
      yield* Ref.update(asked, (count) => count + Number(consent))
      return { note: "Read now.", lines: statusLines(yield* Ref.get(state), NOW) }
    }),
})

const withSource = <A,>(body: (source: Source, asked: Ref.Ref<number>) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const asked = yield* Ref.make(0)
    return yield* body(fake(yield* Ref.make(reading), asked), asked)
  })

describe("antigravity tool", () => {
  it.effect("with the option off it says so and reads nothing", () =>
    Effect.map(answer(Option.none(), { action: "status" }), (text) => expect(text).toContain("not read on this host")),
  )

  it.effect("open names each group's answer; a spent window holds its group until its reset", () =>
    withSource((source) =>
      Effect.map(answer(Option.some(source), { action: "open" }), (text) => {
        expect(text).toMatch(/^gemini: open/m)
        expect(text).toMatch(/^claude-gpt: limited until /m)
      }),
    ),
  )

  it.effect("a pane's limit is recorded with its reset; other text records nothing", () =>
    withSource((source) =>
      Effect.gen(function* () {
        expect(yield* answer(Option.some(source), { action: "limit", text: "Individual quota reached. Resets in 1h8m38s." })).toStartWith("Recorded: limited until ")
        expect(yield* answer(Option.some(source), { action: "limit", text: "all good" })).toBe("That text is no Antigravity quota limit: nothing recorded.")
      }),
    ),
  )

  it.effect("read passes the consent only when given, then shows the note and the rows", () =>
    withSource((source, asked) =>
      Effect.gen(function* () {
        const text = yield* answer(Option.some(source), { action: "read" })
        expect(yield* Ref.get(asked)).toBe(0)
        expect(yield* answer(Option.some(source), { action: "read", consent: true })).toStartWith("Read now.")
        expect(yield* Ref.get(asked)).toBe(1)
        expect(text).toContain("Gemini")
      }),
    ),
  )
})
