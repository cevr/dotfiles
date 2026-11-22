// Which queue items look stale, and the note that asks the agent to check
// them. Pure: the sweep (`fresh.ts`) gathers the facts from the host and
// decides when to send the note; nothing here changes an item. The agent
// alone sets an item done, removes it or restates it.
import { Array as Arr, DateTime, Match, Option, Order, Record as Rec } from "effect"
import type { Item } from "./item.ts"

/** An item untouched this long (and not running in a live subagent, not dated ahead) looks stale. */
export const UNTOUCHED_MS = 6 * 60 * 60_000
/** How long a linked subagent may sit idle, or a needs-you item stand without an open question, before either counts. */
export const GRACE_MS = 30 * 60_000
/** More open items than this and the note asks the agent to collapse them. */
export const CAP = 25
/** The note lists at most this many items; it counts the rest. */
export const LISTED = 15
/** Never two notes to one session within this time. */
export const GAP_MS = 60 * 60_000
/** The same stale items are asked about again only after this time. */
export const REPEAT_MS = 6 * 60 * 60_000

const HOUR_MS = 60 * 60_000

/** A subagent session an item links to, as the host has it. `since` (epoch ms) is when its last run ended. */
export type Linked =
  | { readonly state: "gone" }
  | { readonly state: "busy" }
  | { readonly state: "idle"; readonly since: number; readonly outcome: Option.Option<string> }

/** What the sweep found around one session's queue. */
export interface Facts {
  readonly now: number
  /** When each item was last written or restated (epoch ms), by id; an item with none predates the record. */
  readonly touched: Readonly<Record<string, number>>
  /** The linked subagent sessions the host knows, by session id. */
  readonly linked: ReadonlyMap<string, Linked>
  /** How many of the session's ask_user_async questions are open; none when the questions plugin did not answer. */
  readonly openQuestions: Option.Option<number>
  /** Wake and monitor ids this session had pending earlier that are pending no more. */
  readonly endedWakes: ReadonlySet<string>
  /** The commits the queue names that are not on the default branch past the threshold, each with why (orchestrate's answer); none without it. */
  readonly unlanded: ReadonlyMap<string, string>
  /** The items the last note named that were restated after it: an ask they answered. */
  readonly acknowledged: ReadonlySet<string>
}

/** One item that looks stale, and why. */
export interface Stale {
  readonly id: string
  readonly state: Item["state"]
  readonly text: string
  readonly reason: string
}

/** `2026-11-18 11:30 UTC`. */
const clock = (time: number) => `${DateTime.formatIso(DateTime.makeUnsafe(time)).slice(0, 16).replace("T", " ")} UTC`

const wholeHours = (ms: number) => (ms - (ms % HOUR_MS)) / HOUR_MS

const linkOf = (item: Item, facts: Facts): Option.Option<Linked> =>
  Option.flatMap(Option.fromNullishOr(item.session), (session) => Option.fromNullishOr(facts.linked.get(session)))

/** An item's date, epoch ms, when it has one. */
const dateOf = (item: Item): Option.Option<number> =>
  Option.flatMap(Option.fromNullishOr(item.at), (at) => Option.map(DateTime.make(at), DateTime.toEpochMillis))

const linkedReason = (item: Item, facts: Facts): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(item.session), (session) => {
    if (item.state !== "running" && item.state !== "waiting") return Option.none()
    return Option.flatMap(linkOf(item, facts), (linked) =>
      Match.value(linked).pipe(
        Match.when({ state: "gone" }, () => Option.some(`its session ${session} no longer exists`)),
        Match.when({ state: "idle" }, (idle) =>
          Option.liftPredicate(
            `its session ${session} ended${Option.match(idle.outcome, { onNone: () => "", onSome: (outcome) => ` (${outcome})` })} at ${clock(idle.since)}`,
            () => facts.now - idle.since >= GRACE_MS,
          ),
        ),
        Match.orElse(() => Option.none()),
      ),
    )
  })

const wakeReason = (item: Item, facts: Facts): Option.Option<string> =>
  Option.map(
    Arr.findFirst(`${item.text} ${Option.getOrElse(Option.fromNullishOr(item.detail), () => "")}`.split(/[^A-Za-z0-9]+/), (word) => facts.endedWakes.has(word)),
    (gone) => `the wake or monitor ${gone} it names is no longer pending`,
  )

const unlandedReason = (item: Item, facts: Facts): Option.Option<string> => {
  if (facts.acknowledged.has(item.id)) return Option.none()
  return Arr.findFirst(commitsOf(item), (hash) => Option.map(Option.fromNullishOr(facts.unlanded.get(hash)), (why) => `it names commit ${hash}, ${why}`))
}

const needsYouReason = (item: Item, facts: Facts): Option.Option<string> => {
  if (item.state !== "needs-you" || !Option.contains(facts.openQuestions, 0)) return Option.none()
  const fresh = Option.exists(Rec.get(facts.touched, item.id), (touched) => facts.now - touched < GRACE_MS)
  return Option.liftPredicate("no ask_user_async question of yours is open: it was answered or never asked", () => !fresh)
}

const untouchedReason = (item: Item, facts: Facts): Option.Option<string> => {
  if (Option.exists(linkOf(item, facts), (linked) => linked.state === "busy")) return Option.none()
  const date = dateOf(item)
  if (Option.exists(date, (at) => at > facts.now)) return Option.none()
  const touched = Rec.get(facts.touched, item.id)
  const since = Order.max(Order.Number)(Option.getOrElse(touched, () => 0), Option.getOrElse(date, () => 0))
  if (facts.now - since < UNTOUCHED_MS) return Option.none()
  if (since === 0) return Option.some("no check time on record")
  const past = Option.match(Option.filter(date, (at) => at === since), { onNone: () => "", onSome: (at) => ` past its time ${clock(at)}` })
  return Option.some(`untouched for ${wholeHours(facts.now - since)} h${past}`)
}

/**
 * The items of a queue that look stale, in the queue's order, each with the
 * first reason that holds: its subagent ended or is gone while it still runs
 * or waits; a wake or monitor it names ended; a needs-you item with no open
 * question; untouched past UNTOUCHED_MS. Done items never are.
 */
export const staleOf = (items: ReadonlyArray<Item>, facts: Facts): ReadonlyArray<Stale> =>
  Arr.flatMap(items, (item): ReadonlyArray<Stale> => {
    if (item.state === "done") return []
    return Option.toArray(
      Option.map(
        Arr.findFirst([linkedReason, wakeReason, unlandedReason, needsYouReason, untouchedReason], (rule) => rule(item, facts)),
        (reason) => ({ id: item.id, state: item.state, text: item.text, reason }),
      ),
    )
  })

/** A word that names a commit: 7 to 40 hex, with a digit and a letter (so neither a hex word nor a number). */
const COMMIT = /\b[0-9a-f]{7,40}\b/g
const isCommit = (word: string): boolean => /\d/.test(word) && /[a-f]/.test(word)

/** An item's words: its text and its detail. */
const wordsOf = (item: Item): string => `${item.text} ${Option.getOrElse(Option.fromNullishOr(item.detail), () => "")}`

/** The commits an item names, in order. */
const commitsOf = (item: Item): ReadonlyArray<string> => Arr.filter([...wordsOf(item).matchAll(COMMIT)].map((match) => match[0]), isCommit)

/** The commits the open items name, once each, in the queue's order: what the sweep asks orchestrate about. */
export const hashesOf = (items: ReadonlyArray<Item>): ReadonlyArray<string> => Arr.dedupe(items.filter((item) => item.state !== "done").flatMap(commitsOf))

/** The items the last note named (its key) that were restated after it was sent. */
export const acknowledgedOf = (sent: Option.Option<Sent>, touched: Readonly<Record<string, number>>): ReadonlySet<string> =>
  new Set(
    Option.match(sent, {
      onNone: () => [],
      onSome: (last) => last.key.split(" ").filter((id) => Option.exists(Rec.get(touched, id), (at) => at > last.at)),
    }),
  )

/** The items not done. */
export const openOf = (items: ReadonlyArray<Item>): number => items.filter((item) => item.state !== "done").length

/** What a note is about: the stale ids and whether the queue is over the cap. Two notes with one key ask the same. */
export const keyOf = (stale: ReadonlyArray<Stale>, open: number, lost: ReadonlyArray<string> = []): string =>
  [...Arr.sort(stale.map((each) => each.id), Order.String), ...lost, ...Arr.filter(["+cap"], () => open > CAP)].join(" ")

/** The last note a session got: when, and what it asked. */
export interface Sent {
  readonly at: number
  readonly key: string
}

/** Whether a note is wanted: something to ask, and not asked within GAP_MS, nor the same ask within REPEAT_MS. */
export const due = (key: string, last: Option.Option<Sent>, now: number): boolean =>
  key !== "" &&
  Option.match(last, {
    onNone: () => true,
    onSome: (sent) => now - sent.at >= GAP_MS && (key !== sent.key || now - sent.at >= REPEAT_MS),
  })

/** The note the session reads: the stale items with why, the cap when passed, and what to do. */
export const noteOf = (stale: ReadonlyArray<Stale>, open: number, lost: ReadonlyArray<string> = []): string => {
  const listed = stale.slice(0, LISTED).map((each) => `- ${each.id} [${each.state}]: ${each.text} (${each.reason})`)
  const more = Arr.filter([`- and ${stale.length - LISTED} more`], () => stale.length > LISTED)
  const heading = Arr.match(stale, {
    onEmpty: () => [],
    onNonEmpty: (all) => [`${Arr.match(Arr.drop(all, 1), { onEmpty: () => "This item looks", onNonEmpty: () => `These ${all.length} items look` })} stale:`],
  })
  const cap = Arr.filter(
    [`Your queue holds ${open} open items, more than ${CAP}: collapse them into a few (one per running agent, wait, dated item and owner decision) and remove what is done or no longer needed.`],
    () => open > CAP,
  )
  return [
    "Queue check: your queue may be out of date. Nothing was changed for you.",
    ...heading,
    ...listed,
    ...more,
    ...lost,
    ...cap,
    "Check each against reality, then set it done, remove it, or restate it with an upsert if it still holds (that marks it checked). For a needs-you item, re-ask with ask_user_async or withdraw the question and update the item.",
  ].join("\n")
}
