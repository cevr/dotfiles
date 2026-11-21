// The page's view: what `/view.json` answers, a pure function of the page (messages.ts), the owner's marks
// (marks.ts), the time and the zone. The page renders it and decides nothing: the order, the pinning, the cut
// before "earlier", Later, unread and every time label are here, where a test reaches them.
//
// - A project's inbox: its open needs-you messages pinned on top, the oldest question first; then the rest newest
//   first. At most LIMIT rows show before "earlier", and a pinned message is never behind it.
// - Later: the messages set aside and not yet back (marks.ts `standing`), newest first.
// - The timeline: the history in SPAN_HOURS wall-clock spans of the zone (12 AM, 6 AM, 12 PM, 6 PM), at most
//   HISTORY_DAYS back, each labelled; the project's messages as marks in time order, a pinned one at its own time too.
import { Array as Arr, Option, Order, Schema } from "effect"
import { lastRead, type Marks, standing } from "./marks.ts"
import { Message, type Page, ProjectLevel } from "./messages.ts"
import { clock, hourLabel, hourOf, spanStarts, startOfDay, weekday, weekdayLong, when } from "./zone.ts"

/** Rows shown before "earlier". */
export const LIMIT = 7
/** A timeline span's length, in hours. */
export const SPAN_HOURS = 6
/** How far back the timeline goes. */
export const HISTORY_DAYS = 30
/** The view's format, for the page. */
export const VIEW_VERSION = 1

const DAY_MS = 86_400_000
const maybe = Schema.OptionFromOptionalKey

/** A message as the page shows it. */
export const ViewMessage = Schema.Struct({
  ...Message.fields,
  unread: Schema.Boolean,
  pinned: Schema.Boolean,
  /** When a message in Later comes back. */
  returnsAt: maybe(Schema.Finite),
  /** Its time as text, AM/PM. */
  when: Schema.String,
})
export type ViewMessage = typeof ViewMessage.Type

/** A mark on the timeline. */
export const TimeMark = Schema.Struct({ id: Schema.String, t: Schema.Finite, unread: Schema.Boolean, red: Schema.Boolean })
export type TimeMark = typeof TimeMark.Type

export const ViewProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  defaultName: Schema.String,
  where: Schema.String,
  level: ProjectLevel,
  headline: Schema.String,
  /** Unread messages in the inbox. */
  unread: Schema.Int,
  /** Open questions and needs-you items, in the inbox or Later. */
  needs: Schema.Int,
  inbox: Schema.Array(ViewMessage),
  /** How many inbox rows show before "earlier". */
  cut: Schema.Int,
  later: Schema.Array(ViewMessage),
  /** Every message's mark, oldest first. */
  marks: Schema.Array(TimeMark),
})
export type ViewProject = typeof ViewProject.Type

export const Span = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  /** The hour it starts: `6 AM`. */
  label: Schema.String,
  /** The day's short name on a span that starts a day, and on the first span. */
  day: maybe(Schema.String),
  /** The span in words, for its card: `Friday, 6 AM to 12 PM`. */
  name: Schema.String,
})
export type Span = typeof Span.Type

export const View = Schema.Struct({
  v: Schema.Int,
  now: Schema.Finite,
  zone: Schema.String,
  nowLabel: Schema.String,
  lastRead: maybe(Schema.Finite),
  lastReadLabel: maybe(Schema.String),
  /** His first visit; absent before it (the page records it). */
  since: maybe(Schema.Finite),
  projects: Schema.Array(ViewProject),
  spans: Schema.Array(Span),
})
export type View = typeof View.Type

/** The view as the JSON `/view.json` answers. */
export const encodeView = Schema.encodeSync(Schema.fromJsonString(View))

interface Placed {
  readonly t: number
  readonly id: string
  readonly pinned: boolean
}

const byId = Order.mapInput(Order.String, (each: Placed) => each.id)
const pinnedFirst = Order.mapInput(Order.Boolean, (each: Placed) => !each.pinned)
const oldestPinned = Order.mapInput(Order.Number, (each: Placed) => Option.getOrElse(Option.liftPredicate(each.t, () => each.pinned), () => -each.t))

/** The inbox order: pinned (open needs-you) first, oldest first; then the rest newest first; ties by id. */
export const inboxOrder = <M extends Placed>(messages: ReadonlyArray<M>): ReadonlyArray<M> => Arr.sort(messages, Order.combineAll([pinnedFirst, oldestPinned, byId]))

/** How many rows show before "earlier": LIMIT, or every pinned one when there are more. */
export const cutOf = (messages: ReadonlyArray<{ readonly pinned: boolean }>): number => Math.min(messages.length, Math.max(LIMIT, messages.filter((each) => each.pinned).length))

/** The end of span `at`: the next one's start, or now for the last. */
const endOf = (starts: ReadonlyArray<number>, at: number, now: number): number => Option.getOrElse(Arr.get(starts, at + 1), () => now)

/** The end of a span in words: its hour, or `now (3:04 PM)` for the last. */
const endWords = (starts: ReadonlyArray<number>, at: number, now: number, zone: string): string =>
  Option.match(Arr.get(starts, at + 1), { onNone: () => `now (${clock(now, zone)})`, onSome: (end) => hourLabel(end, zone) })

/** The timeline's spans from `from` to `now` in `zone`, oldest first, labelled. */
export const spansOf = (from: number, now: number, zone: string): ReadonlyArray<Span> => {
  const starts = spanStarts(from, now, SPAN_HOURS, zone)
  return starts.map((start, at) => ({
    start,
    end: endOf(starts, at, now),
    label: hourLabel(start, zone),
    day: Option.liftPredicate(weekday(start, zone), () => at === 0 || hourOf(start, zone) === 0),
    name: `${weekdayLong(start, zone)}, ${hourLabel(start, zone)} to ${endWords(starts, at, now, zone)}`,
  }))
}

/** A message of the page placed for him at `now`. */
const placeOf = (message: Message, marks: Marks, now: number, zone: string): ViewMessage => {
  const stands = standing(marks, message.id, message.t, now)
  return {
    ...message,
    unread: stands._tag === "Inbox" && stands.unread,
    pinned: stands._tag === "Inbox" && message.open,
    returnsAt: Option.map(Option.liftPredicate(stands, (each) => each._tag === "Later"), (each) => each.returnsAt),
    when: when(message.t, now, zone),
  }
}

const newestFirst = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (each: ViewMessage) => each.t),
  Order.mapInput(Order.String, (each: ViewMessage) => each.id),
)
const oldestFirst = Order.combine(
  Order.mapInput(Order.Number, (each: TimeMark) => each.t),
  Order.mapInput(Order.String, (each: TimeMark) => each.id),
)

/** A project of the page as he sees it at `now`. */
const projectOf = (project: Page["projects"][number], marks: Marks, now: number, zone: string): ViewProject => {
  const placed = project.messages.map((message) => placeOf(message, marks, now, zone))
  const inbox = inboxOrder(placed.filter((each) => Option.isNone(each.returnsAt)))
  return {
    id: project.id,
    name: Option.getOrElse(Option.fromUndefinedOr(marks.names.get(project.id)), () => project.name),
    defaultName: project.name,
    where: project.where,
    level: project.level,
    headline: project.headline,
    unread: inbox.filter((each) => each.unread).length,
    needs: placed.filter((each) => each.open).length,
    inbox,
    cut: cutOf(inbox),
    later: Arr.sort(
      placed.filter((each) => Option.isSome(each.returnsAt)),
      newestFirst,
    ),
    marks: Arr.sort(
      placed.map((each) => ({ id: each.id, t: each.t, unread: each.unread, red: each.level === "red" })),
      oldestFirst,
    ),
  }
}

/** Where the timeline starts: the oldest message (at most HISTORY_DAYS back), or today with none. */
const historyFrom = (projects: ReadonlyArray<ViewProject>, now: number, zone: string): number => {
  const times = projects.flatMap((project) => project.marks.map((mark) => mark.t)).filter((t) => t <= now && t >= now - HISTORY_DAYS * DAY_MS)
  return Option.getOrElse(Option.map(Arr.head(times), () => Math.min(...times)), () => startOfDay(now, zone))
}

/** The view of `page` for `marks` at `now` in `zone`. */
export const viewOf = (page: Page, marks: Marks, now: number, zone: string): View => {
  const projects = page.projects.map((project) => projectOf(project, marks, now, zone))
  const read = lastRead(marks)
  return {
    v: VIEW_VERSION,
    now,
    zone,
    nowLabel: `${weekday(now, zone)} ${clock(now, zone)}`,
    lastRead: read,
    lastReadLabel: Option.map(read, (t) => when(t, now, zone)),
    since: marks.since,
    projects,
    spans: spansOf(historyFrom(projects, now, zone), now, zone),
  }
}
