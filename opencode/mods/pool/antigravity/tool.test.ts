// The `antigravity` tool's words over a source that holds a reading: what the
// orchestrator reads before it starts agy panes, and what a pane's limit records.
import { describe } from "bun:test"
import { Array as Arr, Effect, Option, Ref } from "effect"
import { expect, it } from "effect-bun-test"
import { fromLocalState, fromReport, openDecisionAt, resolveGroup } from "./fleet.ts"
import { checkStartGate } from "./gate.ts"
import { parsePaneLimits } from "./limit.ts"
import type { Source } from "./source.ts"
import { EMPTY, Event, evolve, type State } from "./state.ts"
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
  report: Effect.map(Ref.get(state), (now) => fromLocalState("mac", now, NOW, true)),
  open: (group) =>
    Effect.map(Ref.get(state), (now) => {
      const merged = fromReport(fromLocalState("mac", now, NOW, true), NOW)
      const wanted = Option.map(group, (named) => Option.getOrElse(resolveGroup(named), () => named))
      return GROUPS.flatMap((name) =>
        Option.toArray(
          Option.map(
            Option.liftPredicate(name, (one) => Option.getOrElse(Option.map(wanted, (named) => named === one), () => true)),
            (one) => {
              const open = openDecisionAt(merged, NOW, one)
              return { group: one, label: one, answer: open.answer, open }
            },
          ),
        ),
      )
    }),
  record: (text, group) =>
    Effect.gen(function* () {
      const first = Arr.head(parsePaneLimits(text, NOW))
      if (Option.isNone(first)) return Option.none()
      const seen = first.value
      const resolved = Option.orElse(seen.group, () => group)
      yield* Ref.update(state, (now) => {
        const base = { seenAt: NOW, key: seen.key }
        const withReset = Option.match(seen.resetAt, { onNone: () => base, onSome: (at) => ({ ...base, resetAt: at }) })
        const withGroup = Option.match(resolved, { onNone: () => withReset, onSome: (g) => ({ ...withReset, group: g }) })
        return evolve(now, Event.cases.LimitSeen.make({ limit: withGroup }))
      })
      return Option.some(seen)
    }),
  clear: () => Effect.void,
  read: (consent) =>
    Effect.gen(function* () {
      yield* Ref.update(asked, (count) => count + Number(consent))
      return { note: "Read now.", lines: statusLines(yield* Ref.get(state), NOW) }
    }),
  gate: (query) =>
    Effect.map(Ref.get(state), (now) =>
      checkStartGate({
        merged: fromReport(fromLocalState("mac", now, NOW, true), NOW),
        ownBusy: [],
        peerBusy: [],
        now: NOW,
        query,
      }),
    ),
  heartbeat: () => Effect.void,
  release: () => Effect.void,
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

  it.effect("open names each group's answer; a spent window holds its group until its reset; model resolves to its group", () =>
    withSource((source) =>
      Effect.gen(function* () {
        const all = yield* answer(Option.some(source), { action: "open" })
        expect(all).toMatch(/^gemini: open/m)
        expect(all).toMatch(/^claude-gpt: limited until /m)
        const byModel = yield* answer(Option.some(source), { action: "open", model: "anthropic/claude-opus-4-6#high" })
        expect(byModel).toMatch(/^claude-gpt: limited until /)
        expect(byModel).not.toContain("gemini")
      }),
    ),
  )

  it.effect("a pane's limit is recorded with its reset; other text records nothing; future `at` is refused", () =>
    withSource((source) =>
      Effect.gen(function* () {
        expect(yield* answer(Option.some(source), { action: "limit", text: "Individual quota reached. Resets in 1h8m38s." })).toStartWith("Recorded: limited until ")
        expect(yield* answer(Option.some(source), { action: "limit", text: "all good" })).toBe("That text is no Antigravity quota limit: nothing recorded.")
        // TestClock starts at 0, so at = 60_000 is strictly in the future on this host's clock.
        const refused = yield* answer(Option.some(source), { action: "limit", text: "Individual quota reached. Resets in 45m.", at: 60_000 })
        expect(refused).toStartWith("Refused:")
        expect(refused).toContain("in the future")
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
