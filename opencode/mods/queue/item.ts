// One entry of the queue: what the agent says runs, waits, is scheduled,
// comes next, needs the owner, or is done; whose it is; for work in a
// subagent, that subagent's session; and where it sits in the plan: the items
// it waits on (`after`) and what follows each of its outcomes (`on`). The
// `queue` tool takes items as the agent writes them (ItemInput, all text but
// the links); `itemOf` checks one and gives the Item the queue stores, or says
// what is wrong with it.
import { Array as Arr, Effect, Option, Result, Schema } from "effect"

/** What an item is doing, in the order the sidebar groups them. */
export const STATES = ["needs-you", "running", "waiting", "scheduled", "next", "done"] as const
export const State = Schema.Literals(STATES)
export type State = typeof State.Type

/** Whose the work is: this agent's, or another session's or agent's (named by `who`). */
export const OWNERS = ["mine", "other"] as const
export const Owner = Schema.Literals(OWNERS)
export type Owner = typeof Owner.Type

/** At most this many `after` ids and `on` outcomes on one item. */
export const MAX_LINKS = 8
/** An outcome's name and what follows it stay this short. */
export const MAX_OUTCOME = 24
export const MAX_NEXT = 80
/** At most this many answer choices on one item, as ask_user_async allows; a label stays this short. */
export const MAX_CHOICES = 4
export const MAX_LABEL = 60

/** An answer the agent offers the owner for an item: a label to pick, and what it means. */
export const Choice = Schema.Struct({ label: Schema.String, description: Schema.optionalKey(Schema.String) })
export type Choice = typeof Choice.Type

/** The owner's answer to an item, sent to the agent at `at` (epoch ms); the agent's next write of the item clears it. */
export const Answered = Schema.Struct({ answer: Schema.String, at: Schema.Number })
export type Answered = typeof Answered.Type

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
  /** The ids of the items this one waits on. */
  after: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What follows each outcome, in the order written: `{ accepted: "land" }`, an item's id or a few words. */
  on: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The answers the owner may pick when they press the item; the Queue tab offers its own when there are none. */
  choices: Schema.optionalKey(Schema.Array(Choice)),
  doneAt: Schema.optionalKey(Schema.Number),
  /** The owner's last answer, sent and not yet followed by a write of the item; only the queue sets it. */
  answered: Schema.optionalKey(Answered),
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
  after: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Ids of the items this one waits on, e.g. ['impl-r1']. [] clears." }),
  on: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "What follows each outcome: an item id or a few words, e.g. {accepted: 'land', changes: 'fix round 2', failed: 'tell owner'}. {} clears.",
  }),
  choices: Schema.optional(Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) }))).annotate({
    description: `At most ${MAX_CHOICES} answers the owner can pick when they press the item; they may also type their own. [] clears.`,
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

/** A link written as one line: runs of whitespace become one space. */
const pairOf = ([outcome, next]: readonly [string, string]): readonly [string, string] => [oneLine(outcome), oneLine(next)]

/** `after` as stored: one line each, no blanks, no repeats, not the item itself. */
const afterOf = (id: string, ids: ReadonlyArray<string>): Result.Result<ReadonlyArray<string>, InvalidItem> => {
  const kept = [...new Set(ids.values().map(oneLine).filter((each) => each !== "" && each !== id))]
  if (kept.length > MAX_LINKS) return Result.fail(new InvalidItem({ id, reason: `after names at most ${MAX_LINKS} items` }))
  return Result.succeed(kept)
}

/** `on` as stored, in the order written: each outcome and what follows it on one line, both short. */
const onOf = (id: string, on: Readonly<Record<string, string>>): Result.Result<Readonly<Record<string, string>>, InvalidItem> => {
  const outcomes = Object.entries(on)
    .values()
    .map(pairOf)
    .filter(([outcome, next]) => outcome !== "" && next !== "")
    .toArray()
  if (outcomes.length > MAX_LINKS) return Result.fail(new InvalidItem({ id, reason: `on names at most ${MAX_LINKS} outcomes` }))
  const long = Arr.findFirst(outcomes, ([outcome, next]) => [...outcome].length > MAX_OUTCOME || [...next].length > MAX_NEXT)
  if (Option.isSome(long))
    return Result.fail(new InvalidItem({ id, reason: `on "${long.value[0]}": keep an outcome to ${MAX_OUTCOME} characters and what follows to ${MAX_NEXT}` }))
  return Result.succeed(Object.fromEntries(outcomes))
}

/**
 * The choices of the item `input` describes over `previous`: as written, each
 * label and description on one line, else as they were; none is left out, so
 * `[]` clears them. At most MAX_CHOICES, each with a short label of its own.
 */
export const choicesOf = (
  id: string,
  input: Pick<ItemInput, "choices">,
  previous: Option.Option<{ readonly choices?: ReadonlyArray<Choice> }>,
): Result.Result<Option.Option<ReadonlyArray<Choice>>, InvalidItem> =>
  Option.match(Option.fromNullishOr(input.choices), {
    onNone: () => Result.succeed(Option.flatMapNullishOr(previous, (item) => item.choices)),
    onSome: (written) => Result.map(checkedChoices(id, written.map(choiceOf)), (choices) => Option.liftPredicate(choices, Arr.isReadonlyArrayNonEmpty)),
  })

/** A choice as stored: its label and description on one line, a blank description left out. */
const choiceOf = (choice: { readonly label: string; readonly description?: string }): Choice =>
  Option.match(Option.fromNullishOr(field(choice.description)), {
    onNone: () => ({ label: oneLine(choice.label) }),
    onSome: (description) => ({ label: oneLine(choice.label), description }),
  })

/** Choices within the limits: at most MAX_CHOICES, each with a short label of its own. */
const checkedChoices = (id: string, choices: ReadonlyArray<Choice>): Result.Result<ReadonlyArray<Choice>, InvalidItem> => {
  const invalid = (reason: string) => Result.fail(new InvalidItem({ id, reason }))
  if (choices.length > MAX_CHOICES) return invalid(`choices holds at most ${MAX_CHOICES}`)
  if (choices.some((choice) => choice.label === "")) return invalid("a choice has no label")
  const long = Arr.findFirst(choices, (choice) => [...choice.label].length > MAX_LABEL)
  if (Option.isSome(long)) return invalid(`choice "${long.value.label}": keep a label to ${MAX_LABEL} characters`)
  const labels = choices.map((choice) => choice.label.toLowerCase())
  if (labels.some((label, at) => labels.indexOf(label) !== at)) return invalid("two choices share a label")
  return Result.succeed(choices)
}

/** An item's links: the items it waits on, and what follows each of its outcomes. */
export interface Links {
  readonly after?: ReadonlyArray<string>
  readonly on?: Readonly<Record<string, string>>
}

/**
 * The links of the item `input` describes over `previous` (the stored item,
 * when patching): `after` and `on` as written, else as they were; an empty
 * one is left out, so `[]` and `{}` clear them.
 */
export const linksOf = (id: string, input: Pick<ItemInput, "after" | "on">, previous: Option.Option<Links>): Result.Result<Links, InvalidItem> =>
  Result.gen(function* () {
    const after = yield* Option.match(Option.fromNullishOr(input.after), {
      onNone: () => Result.succeed(Option.getOrElse(Option.flatMapNullishOr(previous, (item) => item.after), Arr.empty)),
      onSome: (ids) => afterOf(id, ids),
    })
    const on = yield* Option.match(Option.fromNullishOr(input.on), {
      onNone: () => Result.succeed(Option.getOrElse(Option.flatMapNullishOr(previous, (item) => item.on), () => ({}))),
      onSome: (outcomes) => onOf(id, outcomes),
    })
    return {
      ...Arr.match(after, { onEmpty: () => ({}), onNonEmpty: (ids) => ({ after: ids }) }),
      ...Arr.match(Object.keys(on), { onEmpty: () => ({}), onNonEmpty: () => ({ on }) }),
    }
  })

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
    const links = yield* Effect.fromResult(linksOf(id, input, Option.fromNullishOr(previous)))
    const choices = yield* Effect.fromResult(choicesOf(id, input, Option.fromNullishOr(previous)))
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
      ...links,
      ...Option.match(choices, { onNone: () => ({}), onSome: (kept) => ({ choices: kept }) }),
      ...(doneAt === undefined ? {} : { doneAt }),
    }
  })

/** `item` with the owner's `answer` recorded as sent at `now`, until the agent next writes the item. */
export const answeredOf = (item: Item, answer: string, now: number): Item => ({ ...item, answered: { answer, at: now } })
