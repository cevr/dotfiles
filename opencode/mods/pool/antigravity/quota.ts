// Antigravity's quota as Google's Code Assist backend answers it, read the way
// T3 Code reads it (pingdotgg/t3code apps/server/src/provider/antigravityUsageLimits.ts
// at 55085df2): `v1internal:retrieveUserQuotaSummary` answers groups of
// buckets, each `bucketId`, `window` (`5h` or `weekly`), `remainingFraction`
// and `resetTime`; older accounts answer only `v1internal:fetchAvailableModels`,
// each model's `quotaInfo` (a window of unstated length) and `weeklyQuotaInfo`.
// Every window is optional: a bucket this does not recognise, a disabled one
// or one with no fraction is no reading, which the pool shows as unknown,
// never as unlimited. Pure: no request, no clock.
import { Array as Arr, DateTime, Match, Option, Schema } from "effect"

/** A window's length: the 5-hour window, the weekly one, or a model's quota of unstated length. */
export const Span = Schema.Literals(["5h", "7d", "quota"])
export type Span = typeof Span.Type

/** The quota groups Antigravity meters apart. */
export const GEMINI = "gemini"
export const SHARED = "claude-gpt"

/** One window of one quota group as read: the share used (0 to 1) and, when Google says it, its reset (epoch ms). */
export const Window = Schema.Struct({
  group: Schema.String,
  label: Schema.String,
  span: Span,
  used: Schema.Finite,
  resetAt: Schema.optionalKey(Schema.Finite),
})
export type Window = typeof Window.Type

const Bucket = Schema.Struct({
  bucketId: Schema.NonEmptyString,
  window: Schema.optionalKey(Schema.String),
  remainingFraction: Schema.optionalKey(Schema.Finite),
  resetTime: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  disabled: Schema.optionalKey(Schema.Boolean),
})
type Bucket = typeof Bucket.Type

/** The summary's shape, its items left loose so one malformed bucket costs only itself. */
export const Summary = Schema.Struct({
  groups: Schema.optionalKey(Schema.Array(Schema.Struct({ displayName: Schema.optionalKey(Schema.String), buckets: Schema.optionalKey(Schema.Array(Schema.Unknown)) }))),
  buckets: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})
export type Summary = typeof Summary.Type

const Quota = Schema.Struct({ remainingFraction: Schema.optionalKey(Schema.Finite), resetTime: Schema.optionalKey(Schema.String) })
type Quota = typeof Quota.Type

const ModelEntry = Schema.Struct({
  modelProvider: Schema.optionalKey(Schema.String),
  quotaInfo: Schema.optionalKey(Schema.Unknown),
  weeklyQuotaInfo: Schema.optionalKey(Schema.Unknown),
})

/** The per-model answer's shape, each model left loose. */
export const Models = Schema.Struct({ models: Schema.Record(Schema.String, Schema.Unknown) })
export type Models = typeof Models.Type

export const decodeSummary = Schema.decodeUnknownOption(Summary)
export const decodeModels = Schema.decodeUnknownOption(Models)
const decodeBucket = Schema.decodeUnknownOption(Bucket)
const decodeQuota = Schema.decodeUnknownOption(Quota)
const decodeModel = Schema.decodeUnknownOption(ModelEntry)

const MINUTE = 60_000
const SPAN_MS = { "5h": 5 * 60 * MINUTE, "7d": 7 * 24 * 60 * MINUTE } as const
/** A reset this close to a whole window after the request is the rolling reset of a bucket nobody touched. */
const UNTOUCHED_TOLERANCE_MS = MINUTE

const instant = (text: Option.Option<string>): Option.Option<number> =>
  Option.flatMap(text, (value) => Option.map(DateTime.make(value), DateTime.toEpochMillis))

const used = (remaining: number) => 1 - Math.max(0, Math.min(1, remaining))

const nonEmpty = (text: Option.Option<string>) => Option.filter(Option.map(text, (value) => value.trim()), (value) => value !== "")

/** A bucket's group, by T3's families: Argon and Carbon apart from Gemini, `3p-` the shared Claude and GPT quota. */
const groupOf = (bucket: Bucket, display: Option.Option<string>): { readonly id: string; readonly label: string } => {
  const named = (fallback: string) => Option.getOrElse(display, () => fallback)
  return Match.value(bucket.bucketId).pipe(
    Match.when((id) => id.startsWith("gemini-argon-"), () => ({ id: "gemini-argon", label: named("Gemini Argon") })),
    Match.when((id) => id.startsWith("gemini-carbon-"), () => ({ id: "gemini-carbon", label: named("Gemini Carbon") })),
    Match.when((id) => id.startsWith("gemini-"), () => ({ id: GEMINI, label: "Gemini" })),
    Match.when((id) => id.startsWith("3p-"), () => ({ id: SHARED, label: "Claude & GPT (shared)" })),
    Match.orElse((id) => ({ id: named(id), label: named(id) })),
  )
}

const spanOf = (window: Option.Option<string>): Option.Option<"5h" | "7d"> =>
  Option.flatMap(window, (name) =>
    Match.value(name).pipe(
      Match.when("5h", () => Option.some<"5h" | "7d">("5h")),
      Match.when("weekly", () => Option.some<"5h" | "7d">("7d")),
      Match.orElse(() => Option.none<"5h" | "7d">()),
    ),
  )

/** Its reset, unless it is an untouched bucket's rolling one (a full bucket, no description, a whole window away). */
const resetOf = (bucket: Bucket, span: "5h" | "7d", requestedAt: number, remaining: number): Option.Option<number> => {
  const reset = instant(Option.fromUndefinedOr(bucket.resetTime))
  const untouched =
    remaining === 1 &&
    Option.isNone(Option.fromUndefinedOr(bucket.description)) &&
    Option.exists(reset, (at) => Math.abs(at - requestedAt - SPAN_MS[span]) <= UNTOUCHED_TOLERANCE_MS)
  return Option.filter(reset, () => !untouched)
}

const windowOf = (group: { readonly id: string; readonly label: string }, span: Span, usedShare: number, reset: Option.Option<number>): Window => {
  const base = { group: group.id, label: group.label, span, used: usedShare }
  return Option.match(reset, { onNone: () => base, onSome: (resetAt) => ({ ...base, resetAt }) })
}

const bucketWindow = (bucket: Bucket, display: Option.Option<string>, requestedAt: number): Option.Option<Window> => {
  if (bucket.disabled === true) return Option.none()
  return Option.flatMap(Option.fromUndefinedOr(bucket.remainingFraction), (remaining) =>
    Option.map(spanOf(Option.fromUndefinedOr(bucket.window)), (span) =>
      windowOf(groupOf(bucket, display), span, used(remaining), resetOf(bucket, span, requestedAt, remaining)),
    ),
  )
}

/** A window's key: one reading per group and length. */
export const keyOf = (window: Pick<Window, "group" | "span">) => `${window.group}/${window.span}`

/** The last of each key, in the order first seen. */
/** Of two readings of one window, the more used; the first on a tie. */
const worse = (before: Window, next: Window): Window => Match.value(next.used > before.used).pipe(Match.when(true, () => next), Match.orElse(() => before))

const byKey = (windows: ReadonlyArray<Window>, keep: (before: Window, next: Window) => Window): ReadonlyArray<Window> => {
  const kept = new Map<string, Window>()
  for (const window of windows) {
    const before = Option.fromUndefinedOr(kept.get(keyOf(window)))
    kept.set(keyOf(window), Option.match(before, { onNone: () => window, onSome: (found) => keep(found, window) }))
  }
  return [...kept.values()]
}

/**
 * The windows of a summary requested at `requestedAt` (epoch ms): the groups'
 * buckets, or the top-level ones when no group has any. A bucket of another
 * length than 5 hours or a week is not read.
 */
export const summaryWindows = (summary: Summary, requestedAt: number): ReadonlyArray<Window> => {
  const groups = Option.getOrElse(Option.fromUndefinedOr(summary.groups), () => [])
  const listed = groups.filter((group) => Option.getOrElse(Option.fromUndefinedOr(group.buckets), () => []).length > 0)
  const top = [{ displayName: "", buckets: Option.getOrElse(Option.fromUndefinedOr(summary.buckets), () => []) }]
  const items = Arr.match(listed, { onEmpty: () => top, onNonEmpty: (some) => some }).flatMap((group) =>
    Option.getOrElse(Option.fromUndefinedOr(group.buckets), () => []).flatMap((item) =>
      Option.toArray(decodeBucket(item)).map((bucket) => ({ bucket, display: nonEmpty(Option.fromUndefinedOr(group.displayName)) })),
    ),
  )
  return byKey(
    items.flatMap(({ bucket, display }) => Option.toArray(bucketWindow(bucket, display, requestedAt))),
    // Two buckets of one group and span: the more used one holds, so a full one is never hidden behind one with room.
    worse,
  )
}

const modelGroup = (id: string, provider: Option.Option<string>): Option.Option<{ readonly id: string; readonly label: string }> => {
  const is = (name: string, prefix: string) => Option.contains(provider, name) || id.startsWith(prefix)
  if (is("MODEL_PROVIDER_GOOGLE", "gemini-")) return Option.some({ id: GEMINI, label: "Gemini" })
  if (is("MODEL_PROVIDER_ANTHROPIC", "claude-") || is("MODEL_PROVIDER_OPENAI", "gpt-")) return Option.some({ id: SHARED, label: "Claude & GPT (shared)" })
  return Option.none()
}

const quotaWindow = (group: { readonly id: string; readonly label: string }, span: Span, quota: Quota): Option.Option<Window> =>
  Option.map(Option.fromUndefinedOr(quota.remainingFraction), (remaining) =>
    windowOf(group, span, used(remaining), instant(Option.fromUndefinedOr(quota.resetTime))),
  )

/**
 * The windows of the per-model answer: each model's weekly quota as its
 * group's week, its other quota as a window of unstated length (no cadence is
 * made up), the most used model's reading for each.
 */
export const modelWindows = (models: Models): ReadonlyArray<Window> =>
  byKey(
    Object.entries(models.models).flatMap(([id, entry]) =>
      Option.toArray(decodeModel(entry)).flatMap((model) =>
        Option.toArray(modelGroup(id, Option.fromUndefinedOr(model.modelProvider))).flatMap((group) => [
          ...Option.toArray(Option.flatMap(decodeQuota(model.quotaInfo), (quota) => quotaWindow(group, "quota", quota))),
          ...Option.toArray(Option.flatMap(decodeQuota(model.weeklyQuotaInfo), (quota) => quotaWindow(group, "7d", quota))),
        ]),
      ),
    ),
    worse,
  )

/** The endpoints' answers in the order asked: the first that reads a window wins it; one that reads only some adds the rest. */
export const firstAnswers = (answers: ReadonlyArray<ReadonlyArray<Window>>): ReadonlyArray<Window> =>
  byKey(Arr.flatten(answers), (before) => before)
