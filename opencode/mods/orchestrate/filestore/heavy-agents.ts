// The heavy agents working on this host, read from the call log the CallLog
// layer writes (call-line.ts; `read` in call-log.ts). The log is the host's,
// every root's on it, so two roots each count the other's agents. Each
// implementor or verifier start (a `call` line; a latch that opened writes one
// too) names its child, on the line itself or on its call's `done` line; a
// child counts while its session still works, as the host answers. A start
// older than `MAX_AGE` is not read, so a session the host can no longer answer
// for is not counted for ever.
import { Array as Arr, DateTime, Effect, Option, Schema } from "effect"
import { isHeavy } from "../heavy.ts"
import type { HostUnread } from "../service.ts"

/** How far back a start is read: no implementor or verifier round runs this long. */
export const MAX_AGE_HOURS = 12

const Started = Schema.Struct({
  kind: Schema.Literal("call"),
  at: Schema.String,
  sessionID: Schema.String,
  callID: Schema.String,
  agent: Schema.String,
  child: Schema.OptionFromOptionalKey(Schema.String),
})

const Done = Schema.Struct({
  kind: Schema.Literal("done"),
  sessionID: Schema.String,
  callID: Schema.String,
  child: Schema.OptionFromOptionalKey(Schema.String),
})

/** A line the count reads: a start or a call's end. Any other line (a latch, a refusal, a partial line) is none. */
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([Started, Done])))

/** What the lines read so far say: the children counted, and the heavy starts still waiting for their `done` line, by call. */
interface Tally {
  readonly children: Set<string>
  readonly waiting: Map<string, number>
}

const keyOf = (line: { readonly sessionID: string; readonly callID: string }) => `${line.sessionID}/${line.callID}`

/** A heavy start at or after `since`: its child counts, or waits for its call's `done` line (a kernel cell's calls share one id). */
const start = (tally: Tally, line: typeof Started.Type, since: string) => {
  if (!isHeavy(line.agent) || line.at < since) return
  if (Option.isSome(line.child)) {
    tally.children.add(line.child.value)
    return
  }
  tally.waiting.set(keyOf(line), Option.getOrElse(Option.fromNullishOr(tally.waiting.get(keyOf(line))), () => 0) + 1)
}

/** A call's end: the child of a heavy start waiting for it counts. */
const done = (tally: Tally, line: typeof Done.Type) => {
  const key = keyOf(line)
  const count = Option.getOrElse(Option.fromNullishOr(tally.waiting.get(key)), () => 0)
  if (count === 0) return
  tally.waiting.set(key, count - 1)
  if (Option.isSome(line.child)) tally.children.add(line.child.value)
}

/**
 * The children of the heavy starts in `text` at or after `since` (an ISO 8601 time, as the log writes `at`), once
 * each, in order. A start's child is its line's, else its call's next `done` line's.
 */
export const heavyChildrenIn = (text: string, since: string): ReadonlyArray<string> => {
  const tally: Tally = { children: new Set(), waiting: new Map() }
  for (const raw of text.split("\n")) {
    const line = decodeLine(raw)
    if (Option.isNone(line)) continue
    if (line.value.kind === "call") start(tally, line.value, since)
    else done(tally, line.value)
  }
  return Arr.fromIterable(tally.children)
}

/**
 * How many heavy agents in the call log `read` gives work now: the children of its starts in the last
 * `MAX_AGE_HOURS` whose session `alive` says still works, `except` not counted.
 */
export const working =
  (read: Effect.Effect<string, HostUnread>, alive: (sessionID: string) => Effect.Effect<boolean>) =>
  (except: Option.Option<string>): Effect.Effect<number, HostUnread> =>
    Effect.gen(function* () {
      const text = yield* read
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: MAX_AGE_HOURS }))
      const children = Arr.filter(heavyChildrenIn(text, since), (child) => !Option.contains(except, child))
      const live = yield* Effect.forEach(children, alive, { concurrency: 8 })
      return Arr.filter(live, Boolean).length
    })
