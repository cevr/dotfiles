// One entry of the queue: what the agent says runs, waits, is scheduled,
// comes next, needs the owner, or is done; whose it is; and, for work in a
// subagent, that subagent's session. The `queue` tool takes items as the
// agent writes them (ItemInput, all text); `itemOf` checks one and gives the
// Item the queue stores, or says what is wrong with it.
import { Effect, Schema } from "effect"

/** What an item is doing, in the order the sidebar groups them. */
export const STATES = ["needs-you", "running", "waiting", "scheduled", "next", "done"] as const
export const State = Schema.Literals(STATES)
export type State = typeof State.Type

/** Whose the work is: this agent's, or another session's or agent's (named by `who`). */
export const OWNERS = ["mine", "other"] as const
export const Owner = Schema.Literals(OWNERS)
export type Owner = typeof Owner.Type

/** An item as the queue stores it. `doneAt` (epoch ms) is when it became done; the queue sets it. */
export const Item = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  state: State,
  owner: Owner,
  who: Schema.optionalKey(Schema.String),
  /** ISO 8601, for a scheduled or dated item. */
  at: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  /** The subagent session doing this work; the sidebar shows its live state instead of `state`. */
  session: Schema.optionalKey(Schema.String),
  doneAt: Schema.optionalKey(Schema.Number),
})
export type Item = typeof Item.Type

/**
 * An item as the agent writes it. Every field is text so that a wrong value
 * reaches `itemOf`, which names it, rather than a schema error. `text` and
 * `state` may be left out only when patching an item that exists.
 */
export const ItemInput = Schema.Struct({
  id: Schema.String.annotate({ description: "A short stable slug you choose, e.g. 'pool-worker'. Patch and remove name items by it." }),
  text: Schema.optional(Schema.String).annotate({ description: "One line saying what it is." }),
  state: Schema.optional(Schema.String).annotate({ description: `One of: ${STATES.join(", ")}.` }),
  owner: Schema.optional(Schema.String).annotate({ description: "mine (default) or other: another session or agent's work." }),
  who: Schema.optional(Schema.String).annotate({ description: "For owner other: whose it is (a session, pane or agent)." }),
  at: Schema.optional(Schema.String).annotate({ description: "ISO 8601 date-time; required for scheduled, allowed on any dated item." }),
  detail: Schema.optional(Schema.String).annotate({ description: "A few words: a pane, a session id, what it waits on." }),
  session: Schema.optional(Schema.String).annotate({
    description: "The subagent session id doing this work (from the subagent tool's result). The sidebar then shows that session's live state; do not copy its status.",
  }),
})
export type ItemInput = typeof ItemInput.Type

/** An item `itemOf` cannot accept, and why. */
export class InvalidItem extends Schema.TaggedError<InvalidItem>()("InvalidItem", { id: Schema.String, reason: Schema.String }) {}

/** An item whose state is not one of STATES. */
export class UnknownState extends Schema.TaggedError<UnknownState>()("UnknownState", { id: Schema.String, state: Schema.String }) {}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/

/** Text on one line: runs of whitespace, newlines included, become one space. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

const isState = (value: string): value is State => (STATES as ReadonlyArray<string>).includes(value)
const isOwner = (value: string): value is Owner => (OWNERS as ReadonlyArray<string>).includes(value)

/** An optional text field, on one line; empty counts as absent. */
const field = (value: string | undefined): string | undefined => {
  const line = value === undefined ? "" : oneLine(value)
  return line === "" ? undefined : line
}

/**
 * The item `input` describes, over `previous` (the stored item with its id,
 * when patching): fields `input` leaves out keep their value. Becoming done
 * stamps `doneAt` with `now`; staying done keeps the first stamp.
 */
export const itemOf = (input: ItemInput, previous: Item | undefined, now: number): Effect.Effect<Item, InvalidItem | UnknownState> =>
  Effect.gen(function* () {
    const id = input.id.trim()
    if (!SLUG.test(id)) return yield* new InvalidItem({ id: input.id, reason: "id must be a short slug: letters, digits, . _ : -, at most 48" })
    const text = input.text === undefined ? previous?.text : oneLine(input.text)
    if (text === undefined || text === "") return yield* new InvalidItem({ id, reason: "text is required (one line)" })
    const stateText = input.state?.trim() ?? previous?.state
    if (stateText === undefined) return yield* new InvalidItem({ id, reason: `state is required: one of ${STATES.join(", ")}` })
    if (!isState(stateText)) return yield* new UnknownState({ id, state: stateText })
    const ownerText = input.owner?.trim() ?? previous?.owner ?? "mine"
    if (!isOwner(ownerText)) return yield* new InvalidItem({ id, reason: `owner must be mine or other, not "${ownerText}"` })
    const kept = {
      who: field(input.who ?? previous?.who),
      detail: field(input.detail ?? previous?.detail),
      session: field(input.session ?? previous?.session),
    }
    let at = field(input.at ?? previous?.at)
    if (at !== undefined) {
      const time = Date.parse(at)
      if (!Number.isFinite(time)) return yield* new InvalidItem({ id, reason: `at must be an ISO 8601 date-time, not "${at}"` })
      at = new Date(time).toISOString()
    }
    if (stateText === "scheduled" && at === undefined) return yield* new InvalidItem({ id, reason: "a scheduled item needs at (ISO 8601)" })
    const doneAt = stateText !== "done" ? undefined : previous?.state === "done" && previous.doneAt !== undefined ? previous.doneAt : now
    return {
      id,
      text,
      state: stateText,
      owner: ownerText,
      ...(kept.who === undefined ? {} : { who: kept.who }),
      ...(at === undefined ? {} : { at }),
      ...(kept.detail === undefined ? {} : { detail: kept.detail }),
      ...(kept.session === undefined ? {} : { session: kept.session }),
      ...(doneAt === undefined ? {} : { doneAt }),
    }
  })
