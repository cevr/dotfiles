// The digest's stored format: one JSONL line per fact a run writes, and the contract the writers append through.
// This is the protocol file other contexts import (`@dotfiles/opencode-digest/event`): the orchestrate plugin
// writes a run, a lane, a step's start, a hand-back, a verdict, a land and a land check; the queue an item's
// change; the questions plugin a question asked, answered or closed; the update's handoff an install's outcome.
//
// A line is `{"_tag":"<Kind>","v":1,"t":<epoch ms>,...}` and at most MAX_LINE bytes: the longest texts are
// halved until it fits (`encodeLine`). A reader decodes each line on its own (`decodeLine`): a field it does not
// know is ignored and a field added later is optional, so an old log decodes under a newer reader and a newer
// line under an older one, its new fields dropped. A line that does not decode is skipped and counted.
import { Array as Arr, Context, Effect, Match, Option, Predicate, Schema } from "effect"

/** The version every line written now carries. A reader takes any version whose fields it can decode. */
export const VERSION = 1

/** A line's most bytes, its newline aside. */
export const MAX_LINE = 4_096

/** A text a line keeps whole up to this many characters; past it, `encodeLine` may halve it to fit. */
export const KEEP_WHOLE = 64

const text = Schema.String
const maybe = Schema.OptionFromOptionalKey
const Version = Schema.Int
const Time = Schema.Finite

/** A queue item's status colour, set by the agent: red is the one a message is ever shown red for. */
export const LEVELS = ["red", "amber", "green"] as const
export const Level = Schema.Literals(LEVELS)
export type Level = typeof Level.Type

/** A unit's verdict in a batch's findings. */
export const UnitVerdict = Schema.Struct({ unit: text, round: Schema.Int, verdict: text })
export type UnitVerdict = typeof UnitVerdict.Type

/** Every fact, by kind. `root` is the root session of the run the fact belongs to. */
export const DigestEvent = Schema.TaggedUnion({
  /** A run's record: its root session, host, repository, run dir and name. */
  Run: { v: Version, t: Time, root: text, host: text, repo: text, dir: maybe(text), name: maybe(text) },
  /** A unit's lane, made or answered, with its one-line purpose. */
  Lane: { v: Version, t: Time, root: text, unit: text, purpose: maybe(text), branch: maybe(text), path: maybe(text) },
  /** A role's step started on a unit (a verifier's on its batch). */
  Start: { v: Version, t: Time, root: text, session: text, role: text, unit: text, round: Schema.Int },
  /** A planner's or implementor's hand-back, with the `Digest:` line it carried. */
  HandBack: { v: Version, t: Time, root: text, session: text, role: text, unit: text, round: Schema.Int, verdict: text, file: maybe(text), digest: maybe(text) },
  /** A verifier's hand-back: its batch (or unit), verdict, `Digest:` line and each unit's verdict in its findings. */
  Verdict: { v: Version, t: Time, root: text, session: text, batch: text, round: Schema.Int, verdict: text, file: maybe(text), digest: maybe(text), units: Schema.Array(UnitVerdict) },
  /** Units landed on the default branch as one push. */
  Land: { v: Version, t: Time, root: text, units: Schema.Array(text), pushed: maybe(text) },
  /** A land's check after the push (the accept check, the post-land step): passed or failed, in its own words. */
  Check: { v: Version, t: Time, root: text, ok: Schema.Boolean, text },
  /** A queue item as it now stands. */
  Item: { v: Version, t: Time, root: text, id: text, text, state: text, owner: text, who: maybe(text), level: maybe(Level), unit: maybe(text) },
  /** A queue item removed. */
  ItemGone: { v: Version, t: Time, root: text, id: text },
  /** A question asked of the owner. */
  Asked: { v: Version, t: Time, root: text, session: text, id: text, question: text, header: maybe(text), options: Schema.Array(text), assume: text },
  /** The owner's answer, and whether it is what the agent assumed. */
  Answered: { v: Version, t: Time, root: text, session: text, id: text, answer: text, matches: Schema.Boolean, question: maybe(text), assume: maybe(text) },
  /** A question closed unanswered: withdrawn, replaced, dropped or dismissed. */
  Closed: { v: Version, t: Time, root: text, session: text, id: text, reason: text },
  /** An install's outcome on a host. */
  Install: { v: Version, t: Time, host: text, outcome: text, build: maybe(text), said: maybe(text), repo: maybe(text) },
  /** Lines a writer could not hand to the log and dropped, counted. */
  Dropped: { v: Version, t: Time, count: Schema.Int },
})
export type DigestEvent = typeof DigestEvent.Type

const Line = Schema.fromJsonString(DigestEvent)
const decodeOne = Schema.decodeUnknownOption(Line)
const toJson = Schema.encodeSync(DigestEvent)
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const bytes = new TextEncoder()

/** How many bytes a text takes in UTF-8. */
export const byteLength = (line: string): number => bytes.encode(line).length

/** A text cut to `max` characters, its last one an ellipsis; whole when it fits. */
export const clip = (value: string, max: number): string => {
  const chars = [...value]
  if (chars.length <= max) return value
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`
}

/** How far a line is cut: texts to `text` characters, lists to `items` entries. */
interface Cut {
  readonly text: number
  readonly items: number
}

const isJsonObject = (json: Schema.Json): json is Schema.JsonObject => Predicate.isObject(json) && !Arr.isArray(json)

/** A JSON value cut: every text to `cut.text` characters, every list to its first `cut.items`. */
const shrink = (json: Schema.Json, cut: Cut): Schema.Json =>
  Match.value(json).pipe(
    Match.when(Predicate.isString, (value) => clip(value, cut.text)),
    Match.when(Arr.isArray, (values: ReadonlyArray<Schema.Json>) => values.slice(0, cut.items).map((each) => shrink(each, cut))),
    Match.when(isJsonObject, (record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, shrink(value, cut)]))),
    Match.orElse((other) => other),
  )

/** The longest text in a JSON value, in characters, and its longest list. */
const extent = (json: Schema.Json): Cut =>
  Match.value(json).pipe(
    Match.when(Predicate.isString, (value): Cut => ({ text: [...value].length, items: 0 })),
    Match.when(Arr.isArray, (values: ReadonlyArray<Schema.Json>): Cut => widest([{ text: 0, items: values.length }, ...values.map(extent)])),
    Match.when(isJsonObject, (record): Cut => widest(Object.values(record).map(extent))),
    Match.orElse((): Cut => ({ text: 0, items: 0 })),
  )

const widest = (cuts: ReadonlyArray<Cut>): Cut => ({ text: Math.max(0, ...cuts.map((each) => each.text)), items: Math.max(0, ...cuts.map((each) => each.items)) })

/**
 * The next cut of a line that does not fit: its texts over KEEP_WHOLE halved; with none, its lists halved; with
 * neither, every text halved; none once nothing is left to cut.
 */
const nextCut = (now: Cut): Option.Option<Cut> => {
  if (now.text > KEEP_WHOLE) return Option.some({ text: Math.max(KEEP_WHOLE, Math.floor(now.text / 2)), items: now.items })
  if (now.items > 1) return Option.some({ text: now.text, items: Math.floor(now.items / 2) })
  if (now.text > 1) return Option.some({ text: Math.floor(now.text / 2), items: now.items })
  return Option.none()
}

/** The line of a JSON value, cut (`nextCut`) until it is at most MAX_LINE bytes. */
const fitted = (json: Schema.Json): string => {
  const line = jsonText(json)
  if (byteLength(line) <= MAX_LINE) return line
  return Option.match(nextCut(extent(json)), { onNone: () => line, onSome: (cut) => fitted(shrink(json, cut)) })
}

/**
 * An event as one line, no newline, at most MAX_LINE bytes: its texts are halved, the longest first, until it
 * fits; past that its lists, and last its short texts. Ids, tags and times stay whole in any line a run writes.
 */
export const encodeLine = (event: DigestEvent): string => fitted(toJson(event))

/** A line as its event; none for a line that is not one (torn, foreign or of a kind this reader does not know). */
export const decodeLine = (line: string): Option.Option<DigestEvent> => decodeOne(line)

/** What a log's text reads as: its events in order, and how many of its non-blank lines did not decode. */
export interface Decoded {
  readonly events: ReadonlyArray<DigestEvent>
  readonly bad: number
}

/** A log's text, line by line: each line that decodes, and a count of those that do not (a torn last line too). */
export const decodeLines = (log: string): Decoded => {
  const lines = log.split("\n").filter((line) => line.trim() !== "")
  const events = lines.flatMap((line) => Option.toArray(decodeLine(line)))
  return { events, bad: lines.length - events.length }
}

/** The `Digest:` line of a hand-back, a request or findings: its text after `Digest:`; none when it has none in its first lines. */
export const digestLineOf = (said: string): Option.Option<string> =>
  Arr.findFirst(said.split("\n").slice(0, 8), (line) => /^[\s>*_`]*digest:/i.test(line)).pipe(
    Option.map((line) => line.replace(/^[\s>*_`]*digest:[*_`]*\s*/i, "").replace(/[*_`]+\s*$/, "").trim()),
    Option.filter((said) => said !== ""),
  )

// ── The log, as the writers reach it ──

/**
 * The digest's log as a writer sees it: `append` hands one event on and never fails, so a fact the digest
 * misses never fails the call that made it. One event is one line.
 */
export class DigestLog extends Context.Service<
  DigestLog,
  {
    readonly append: (event: DigestEvent) => Effect.Effect<void>
  }
>()("dotfiles-opencode/digest/DigestLog") {}

/** A log that keeps nothing: for a host with no digest. */
export const silent = DigestLog.of({ append: () => Effect.void })

/**
 * The digest plugin's RPC, which owns the log file on its host: `append({ line })` writes one encoded line.
 * Another plugin reaches it with `ctx.rpc(DIGEST)`, through `opencode/rpc-log.ts`.
 */
export const DIGEST = {
  id: "dotfiles-opencode.digest",
  methods: {
    append: { input: { type: "object", properties: { line: { type: "string" } }, required: ["line"] }, output: { type: "object" } },
  },
  events: {},
} as const

/** What the RPC's `append` takes. */
export const AppendInput = Schema.Struct({ line: Schema.String })
export type AppendInput = typeof AppendInput.Type
