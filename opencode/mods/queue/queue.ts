// The Queue aggregate: one session's list of items, which the agent replaces
// whole (SetQueue) or patches by id (PatchQueue). A change records the list it
// leads to (QueueChanged); a change that leaves the list as it is records
// nothing. The store keeps the folded state with a revision the sidebar polls.
// Also the queue's RPC, which the sidebar reads.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { InvalidItem, Item, ItemInput, itemOf, UnknownState } from "./item.ts"

export interface QueueState {
  readonly items: ReadonlyArray<Item>
}

/** Replace the whole list. */
export const SetQueue = Schema.TaggedStruct("SetQueue", { items: Schema.Array(ItemInput) })
export interface SetQueue extends Schema.Schema.Type<typeof SetQueue> {}

/** Add or change items by id (fields left out keep their value), and remove items by id. */
export const PatchQueue = Schema.TaggedStruct("PatchQueue", { upsert: Schema.Array(ItemInput), remove: Schema.Array(Schema.String) })
export interface PatchQueue extends Schema.Schema.Type<typeof PatchQueue> {}

export type Command = SetQueue | PatchQueue

/** The list a change led to. */
export const QueueChanged = Schema.TaggedStruct("QueueChanged", { items: Schema.Array(Item) })
export interface QueueChanged extends Schema.Schema.Type<typeof QueueChanged> {}

/** Two items of one change share an id. */
export class DuplicateItem extends Schema.TaggedError<DuplicateItem>()("DuplicateItem", { id: Schema.String }) {}

/** A patch removes ids the queue does not hold. */
export class UnknownItem extends Schema.TaggedError<UnknownItem>()("UnknownItem", { ids: Schema.Array(Schema.String), known: Schema.Array(Schema.String) }) {}

/** The tool's input asks for no change, or for a set and a patch at once. */
export class UnclearChange extends Schema.TaggedError<UnclearChange>()("UnclearChange", { reason: Schema.String }) {}

export type Rejection = InvalidItem | UnknownState | DuplicateItem | UnknownItem | UnclearChange

/** The tool's input: a whole new list, or a patch. */
export const QueueInput = Schema.Struct({
  set: Schema.optional(Schema.Array(ItemInput)).annotate({ description: "Replace the whole queue with these items." }),
  upsert: Schema.optional(Schema.Array(ItemInput)).annotate({
    description: "Add these items, or change the items with these ids (fields you leave out keep their value; an empty string clears one).",
  }),
  remove: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Remove the items with these ids." }),
})
export type QueueInput = typeof QueueInput.Type

/** The command the tool's input asks for. */
export const commandOf = (input: QueueInput): Effect.Effect<Command, UnclearChange> => {
  const patching = input.upsert !== undefined || input.remove !== undefined
  if (input.set !== undefined && patching) return Effect.fail(new UnclearChange({ reason: "give either set, or upsert and remove; not both" }))
  if (input.set !== undefined) return Effect.succeed(SetQueue.make({ items: input.set }))
  if (!patching) return Effect.fail(new UnclearChange({ reason: "give set, or upsert and/or remove" }))
  return Effect.succeed(PatchQueue.make({ upsert: input.upsert ?? [], remove: input.remove ?? [] }))
}

const duplicate = (ids: ReadonlyArray<string>) => ids.find((id, index) => ids.indexOf(id) !== index)

const same = (left: ReadonlyArray<Item>, right: ReadonlyArray<Item>) => JSON.stringify(left) === JSON.stringify(right)

const changed = (state: QueueState, items: ReadonlyArray<Item>): ReadonlyArray<QueueChanged> =>
  same(state.items, items) ? [] : [QueueChanged.make({ items })]

export const Queue: Decider<QueueState, Command, QueueChanged, Rejection> = {
  initial: { items: [] },
  decide: (state, command, now) =>
    Effect.gen(function* () {
      const byId = new Map(state.items.map((item) => [item.id, item]))
      if (command._tag === "SetQueue") {
        const items = yield* Effect.forEach(command.items, (input) => itemOf(input, byId.get(input.id.trim()), now))
        const twice = duplicate(items.map((item) => item.id))
        if (twice !== undefined) return yield* new DuplicateItem({ id: twice })
        return changed(state, items)
      }
      const upserted = yield* Effect.forEach(command.upsert, (input) => itemOf(input, byId.get(input.id.trim()), now))
      const twice = duplicate(upserted.map((item) => item.id))
      if (twice !== undefined) return yield* new DuplicateItem({ id: twice })
      const removed = command.remove.map((id) => id.trim())
      const missing = removed.filter((id) => !byId.has(id))
      if (missing.length > 0) return yield* new UnknownItem({ ids: missing, known: [...byId.keys()] })
      const clash = upserted.find((item) => removed.includes(item.id))
      if (clash !== undefined) return yield* new DuplicateItem({ id: clash.id })
      const updates = new Map(upserted.map((item) => [item.id, item]))
      const kept = state.items.filter((item) => !removed.includes(item.id)).map((item) => updates.get(item.id) ?? item)
      const added = upserted.filter((item) => !byId.has(item.id))
      return changed(state, [...kept, ...added])
    }),
  evolve: (_state, event) => ({ items: event.items }),
}

/** What the agent reads when its change is refused. */
export const explain = (rejection: Rejection): string => {
  switch (rejection._tag) {
    case "InvalidItem":
      return `Item "${rejection.id}": ${rejection.reason}.`
    case "UnknownState":
      return `Item "${rejection.id}": unknown state "${rejection.state}". Use one of: needs-you, running, waiting, scheduled, next, done.`
    case "DuplicateItem":
      return `Item "${rejection.id}" appears twice in one change.`
    case "UnknownItem":
      return `No item ${rejection.ids.map((id) => `"${id}"`).join(", ")} to remove. The queue holds: ${rejection.known.join(", ") || "nothing"}.`
    case "UnclearChange":
      return `Nothing changed: ${rejection.reason}.`
  }
}

// ── The RPC the sidebar reads ──

/** The queue's RPC: `get` answers a session's queue and its revision, which goes up with every change. */
export const QUEUE = {
  id: "dotfiles-opencode.queue",
  methods: {
    get: { input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] }, output: { type: "object" } },
  },
  events: {},
} as const

/** A session's queue as stored and as `get` answers it. A session with no queue is revision 0 with no items. */
export const Snapshot = Schema.Struct({ revision: Schema.Number, items: Schema.Array(Item) })
export type Snapshot = typeof Snapshot.Type

export const EMPTY: Snapshot = { revision: 0, items: [] }
