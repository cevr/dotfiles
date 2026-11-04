// The story runner on a toy counter: it passes a story whose steps account
// for every outcome, and fails one that leaves an event or a rejection
// unasserted or asserts the wrong one.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { fold, type Decider } from "./decider.ts"
import * as Story from "./story.ts"

const Added = Schema.TaggedStruct("Added", { amount: Schema.Number, at: Schema.Number })
type Added = typeof Added.Type
class TooMuch extends Schema.TaggedError<TooMuch>()("TooMuch", { total: Schema.Number }) {}
interface Add {
  readonly _tag: "Add"
  readonly amount: number
}

/** A counter that refuses to pass 10, and stamps each addition with the time. */
const Counter: Decider<number, Add, Added, TooMuch> = {
  initial: 0,
  decide: (total, command, now) =>
    total + command.amount > 10
      ? Effect.fail(new TooMuch({ total }))
      : Effect.succeed(command.amount === 0 ? [] : [Added.make({ amount: command.amount, at: now })]),
  evolve: (total, event) => total + event.amount,
}
const Count = { initial: 0, evolve: (count: number) => count + 1 }

const story = Story.make(Counter)
const add = (amount: number): Add => ({ _tag: "Add", amount })
const failure = (...steps: Parameters<typeof story>) =>
  Effect.runPromise(Effect.exit(story(...steps))).then((exit) =>
    Exit.isFailure(exit) ? String(exit.cause) : "passed",
  )

describe("a story", () => {
  test("passes when its steps account for every outcome", () =>
    Effect.runPromise(
      story(
        Story.given(Added.make({ amount: 4, at: 0 })),
        Story.clock("2026-01-02T09:00:00Z"),
        Story.when(add(5)),
        Story.then(Added.make({ amount: 5, at: Date.parse("2026-01-02T09:00:00Z") })),
        Story.when(add(0)),
        Story.then(),
        Story.state(9),
        Story.view(Count, 2),
        Story.when(add(2)),
        Story.rejected(new TooMuch({ total: 9 })),
      ),
    ))

  test("fails on an unasserted event, a wrong event or a wrong state", async () => {
    expect(await failure(Story.when(add(1)))).toContain("unasserted events")
    expect(await failure(Story.when(add(1)), Story.then(Added.make({ amount: 2, at: 0 })))).toContain("then: expected")
    expect(await failure(Story.when(add(1)), Story.then(Added.make({ amount: 1, at: 0 })), Story.state(2))).toContain("state: expected")
    expect(await failure(Story.when(add(1)), Story.then(Added.make({ amount: 1, at: 0 })), Story.view(Count, 3))).toContain("view: expected")
  })

  test("fails on an unasserted or wrong rejection, or a rejection asserted where none came", async () => {
    expect(await failure(Story.when(add(11)))).toContain("unasserted rejection")
    expect(await failure(Story.when(add(11)), Story.when(add(1)))).toContain("the last rejection is unasserted")
    expect(await failure(Story.when(add(11)), Story.rejected(new TooMuch({ total: 1 })))).toContain("rejected: expected")
    expect(await failure(Story.when(add(1)), Story.rejected(new TooMuch({ total: 0 })))).toContain("was not rejected")
  })

  test("its clock never goes back", async () => {
    expect(await failure(Story.clock(10), Story.clock(5))).toContain("clock: 5 is before 10")
    expect(await failure(Story.clock("not a time"))).toContain("clock: not a time")
  })
})

test("fold starts from the initial state, or the one given", () => {
  const events = [Added.make({ amount: 2, at: 0 }), Added.make({ amount: 3, at: 0 })]
  expect(fold(Counter, events)).toBe(5)
  expect(fold(Counter, events, 10)).toBe(15)
})
