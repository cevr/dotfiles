import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import * as Story from "@dotfiles/decider/story"
import { InvalidItem, type Item, UnknownState } from "./item.ts"
import { commandOf, DuplicateItem, explain, PatchQueue, Queue, QueueChanged, SetQueue, UnclearChange, UnknownItem } from "./queue.ts"

const story = Story.make(Queue)
const NOW = "2026-11-04T15:00:00Z"
const LATER = "2026-11-04T15:05:00Z"

const pool: Item = { id: "pool", text: "Sidebar pool worker", state: "running", owner: "mine", session: "ses_pool" }
const panes: Item = { id: "panes", text: "Close old Claude panes", state: "needs-you", owner: "mine" }
const had = QueueChanged.make({ items: [pool, panes] })

describe("SetQueue", () => {
  test("replaces the list, defaulting owner to mine and keeping text on one line", () =>
    Effect.runPromise(
      story(
        Story.given(had),
        Story.clock(NOW),
        Story.when(
          SetQueue.make({
            items: [
              { id: "token", text: "pool-token\n  check", state: "scheduled", at: "2026-11-04T22:07:00+00:00" },
              { id: "manna", text: "manna brainstorm", state: "waiting", owner: "other", who: "wC:p6" },
            ],
          }),
        ),
        Story.then(
          QueueChanged.make({
            items: [
              { id: "token", text: "pool-token check", state: "scheduled", owner: "mine", at: "2026-11-04T22:07:00.000Z" },
              { id: "manna", text: "manna brainstorm", state: "waiting", owner: "other", who: "wC:p6" },
            ],
          }),
        ),
      ),
    ))

  test("the same list again records nothing", () =>
    Effect.runPromise(story(Story.given(had), Story.when(SetQueue.make({ items: [pool, panes] })), Story.then())))

  test("rejects an unknown state, naming the item and the state", () =>
    Effect.runPromise(
      story(
        Story.when(SetQueue.make({ items: [{ id: "x", text: "X", state: "blocked" }] })),
        Story.rejected(new UnknownState({ id: "x", state: "blocked" })),
      ),
    ))

  test("rejects two items with one id", () =>
    Effect.runPromise(
      story(
        Story.when(SetQueue.make({ items: [{ id: "x", text: "X", state: "next" }, { id: "x", text: "Y", state: "next" }] })),
        Story.rejected(new DuplicateItem({ id: "x" })),
      ),
    ))

  for (const [input, reason] of [
    [{ id: "has space", text: "X", state: "next" }, "id must be a short slug: letters, digits, . _ : -, at most 48"],
    [{ id: "x", text: " \n", state: "next" }, "text is required (one line)"],
    [{ id: "x", text: "X" }, "state is required: one of needs-you, running, waiting, scheduled, next, done"],
    [{ id: "x", text: "X", state: "next", owner: "theirs" }, 'owner must be mine or other, not "theirs"'],
    [{ id: "x", text: "X", state: "scheduled" }, "a scheduled item needs at (ISO 8601)"],
    [{ id: "x", text: "X", state: "next", at: "tomorrow" }, 'at must be an ISO 8601 date-time, not "tomorrow"'],
  ] as const)
    test(`rejects an invalid item: ${reason}`, () =>
      Effect.runPromise(
        story(Story.when(SetQueue.make({ items: [input] })), Story.rejected(new InvalidItem({ id: input.id === "has space" ? "has space" : "x", reason }))),
      ))
})

describe("PatchQueue", () => {
  test("changes an item by id, keeping the fields left out, and appends a new one", () =>
    Effect.runPromise(
      story(
        Story.given(had),
        Story.clock(NOW),
        Story.when(PatchQueue.make({ upsert: [{ id: "panes", state: "done" }, { id: "daily", text: "Merge workers, run daily", state: "next" }], remove: [] })),
        Story.then(
          QueueChanged.make({
            items: [pool, { ...panes, state: "done", doneAt: Date.parse(NOW) }, { id: "daily", text: "Merge workers, run daily", state: "next", owner: "mine" }],
          }),
        ),
      ),
    ))

  test("done keeps its first stamp; leaving done drops it; an empty string clears a field", () =>
    Effect.runPromise(
      story(
        Story.given(QueueChanged.make({ items: [{ ...panes, state: "done", doneAt: Date.parse(NOW) }, pool] })),
        Story.clock(LATER),
        Story.when(PatchQueue.make({ upsert: [{ id: "panes", text: "Closed the old panes" }, { id: "pool", state: "next", session: "" }], remove: [] })),
        Story.then(
          QueueChanged.make({
            items: [
              { ...panes, text: "Closed the old panes", state: "done", doneAt: Date.parse(NOW) },
              { id: "pool", text: "Sidebar pool worker", state: "next", owner: "mine" },
            ],
          }),
        ),
        Story.when(PatchQueue.make({ upsert: [{ id: "panes", state: "next" }], remove: [] })),
        Story.then(
          QueueChanged.make({
            items: [
              { ...panes, text: "Closed the old panes", state: "next" },
              { id: "pool", text: "Sidebar pool worker", state: "next", owner: "mine" },
            ],
          }),
        ),
      ),
    ))

  test("removes by id", () =>
    Effect.runPromise(story(Story.given(had), Story.when(PatchQueue.make({ upsert: [], remove: ["pool"] })), Story.then(QueueChanged.make({ items: [panes] })))))

  test("a new item needs text and state", () =>
    Effect.runPromise(
      story(
        Story.given(had),
        Story.when(PatchQueue.make({ upsert: [{ id: "new", state: "next" }], remove: [] })),
        Story.rejected(new InvalidItem({ id: "new", reason: "text is required (one line)" })),
      ),
    ))

  test("rejects removing an id the queue does not hold, listing what it holds", () =>
    Effect.runPromise(
      story(
        Story.given(had),
        Story.when(PatchQueue.make({ upsert: [], remove: ["pool", "gone"] })),
        Story.rejected(new UnknownItem({ ids: ["gone"], known: ["pool", "panes"] })),
      ),
    ))

  test("rejects an id upserted and removed at once", () =>
    Effect.runPromise(
      story(
        Story.given(had),
        Story.when(PatchQueue.make({ upsert: [{ id: "pool", state: "done" }], remove: ["pool"] })),
        Story.rejected(new DuplicateItem({ id: "pool" })),
      ),
    ))
})

describe("commandOf", () => {
  test("set is a SetQueue; upsert and remove a PatchQueue", () => {
    expect(Effect.runSync(commandOf({ set: [] }))).toEqual(SetQueue.make({ items: [] }))
    expect(Effect.runSync(commandOf({ remove: ["x"] }))).toEqual(PatchQueue.make({ upsert: [], remove: ["x"] }))
  })

  test("nothing, or set with a patch, is unclear", () => {
    expect(Effect.runSyncExit(commandOf({}))).toEqual(Exit.fail(new UnclearChange({ reason: "give set, or upsert and/or remove" })))
    expect(Effect.runSyncExit(commandOf({ set: [], remove: [] }))).toEqual(
      Exit.fail(new UnclearChange({ reason: "give either set, or upsert and remove; not both" })),
    )
  })
})

describe("explain", () => {
  test("says what to do about each rejection", () => {
    expect(explain(new UnknownState({ id: "x", state: "blocked" }))).toBe(
      'Item "x": unknown state "blocked". Use one of: needs-you, running, waiting, scheduled, next, done.',
    )
    expect(explain(new UnknownItem({ ids: ["gone"], known: ["pool"] }))).toBe('No item "gone" to remove. The queue holds: pool.')
    expect(explain(new InvalidItem({ id: "x", reason: "text is required (one line)" }))).toBe('Item "x": text is required (one line).')
  })
})
