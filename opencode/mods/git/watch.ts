// A session's watch on one pull request: the PrWatch aggregate. The session
// asks to hear when the request turns green, gets a review, or changes at all
// (`until`); the per-machine watcher reads the request and hands each read to
// `decide` as Observe. It records Noticed, with the lines the notice says,
// when a change matters to the watch, and the watch ends once what it waited
// for came (green: the checks pass; reviewed: a review or a new decision) or
// the request merged or closed. Checks are told only when they settle (pass or
// fail), never when they start again. Any other difference is Seen, kept silently
// so the next read is compared with the newest one.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { groups, type Report, RepoName, short, spoken, verdict } from "./report.ts"

/** What a watch waits for. */
export const Until = Schema.Literals(["green", "reviewed", "changed"])
export type Until = typeof Until.Type

/** A pull request by its repository and number. */
export const PrRef = Schema.Struct({ repo: RepoName, number: Schema.Number })
export type PrRef = typeof PrRef.Type

/** `owner/name#123`. */
export const refText = (ref: PrRef): string => `${ref.repo}#${ref.number}`

/** What a watch compares between two reads of a request. */
export const Summary = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  /** OPEN, CLOSED or MERGED. */
  state: Schema.String,
  head: Schema.String,
  verdict: Schema.Literals(["none", "pass", "fail", "pending"]),
  /** The failing checks' names. */
  failing: Schema.Array(Schema.String),
  decision: Schema.optionalKey(Schema.String),
  /** Each reviewer's latest review, `alice approved`. */
  reviews: Schema.Array(Schema.String),
  threads: Schema.Number,
  mergeable: Schema.String,
})
export type Summary = typeof Summary.Type

export const summaryOf = (report: Report): Summary => ({
  title: report.title,
  url: report.url,
  state: report.state,
  head: report.head,
  verdict: verdict(report.checks),
  failing: groups(report.checks).fail.map((check) => check.name),
  ...(report.reviewDecision === undefined ? {} : { decision: report.reviewDecision }),
  reviews: report.reviews.map((review) => `${review.author} ${spoken(review.state)}`),
  threads: report.threads.length,
  mergeable: report.mergeable,
})

export const Watch = Schema.Struct({
  sessionID: Schema.String,
  repo: RepoName,
  number: Schema.Number,
  until: Until,
  note: Schema.optionalKey(Schema.String),
  /** When it was set, epoch ms. */
  since: Schema.Number,
  /** The newest read it was compared with. */
  last: Summary,
})
export type Watch = typeof Watch.Type

// ── Events ──

export const Watched = Schema.TaggedStruct("Watched", { watch: Watch })
export interface Watched extends Schema.Schema.Type<typeof Watched> {}
export const Unwatched = Schema.TaggedStruct("Unwatched", {})
export interface Unwatched extends Schema.Schema.Type<typeof Unwatched> {}
export const Seen = Schema.TaggedStruct("Seen", { last: Summary })
export interface Seen extends Schema.Schema.Type<typeof Seen> {}
export const Noticed = Schema.TaggedStruct("Noticed", {
  last: Summary,
  /** What changed, a line each. */
  lines: Schema.Array(Schema.String),
  /** Whether the watch ends with this notice. */
  ended: Schema.Boolean,
})
export interface Noticed extends Schema.Schema.Type<typeof Noticed> {}
export type WatchEvent = Watched | Unwatched | Seen | Noticed

// ── Commands ──

/** Watch a request from its read now; a second Start replaces the first. */
export const Start = Schema.TaggedStruct("Start", {
  sessionID: Schema.String,
  repo: RepoName,
  number: Schema.Number,
  until: Until,
  note: Schema.optionalKey(Schema.String),
  read: Summary,
})
export interface Start extends Schema.Schema.Type<typeof Start> {}
export const Stop = Schema.TaggedStruct("Stop", {})
export interface Stop extends Schema.Schema.Type<typeof Stop> {}
export const Observe = Schema.TaggedStruct("Observe", { read: Summary })
export interface Observe extends Schema.Schema.Type<typeof Observe> {}
export type WatchCommand = Start | Stop | Observe

/** Start refused: what the watch would wait for is already so. */
export class AlreadyThere extends Schema.TaggedError<AlreadyThere>()("AlreadyThere", {
  ref: Schema.String,
  /** What already holds: `its checks pass`, `it is merged`. */
  reason: Schema.String,
}) {}

export type WatchState = Watch | undefined

const ended = (state: string) => state === "MERGED" || state === "CLOSED"

/** Why `until` already holds for `read`, if it does. */
const already = (until: Until, read: Summary): string | undefined => {
  if (ended(read.state)) return `it is ${spoken(read.state)}`
  if (until === "green" && read.verdict === "pass") return "its checks pass"
  return undefined
}

const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => left.length === right.length && left.every((each, index) => each === right[index])

/** One difference between two reads, and which watches it matters to. */
interface Change {
  readonly line: string
  readonly matters: ReadonlyArray<Until>
  /** Whether a watch waiting for `until` ends on it. */
  readonly ends: ReadonlyArray<Until>
}

const ALL: ReadonlyArray<Until> = ["green", "reviewed", "changed"]

/** What changed from `before` to `after`, in the order a notice says it. */
export const changes = (before: Summary, after: Summary): ReadonlyArray<Change> => {
  const found: Array<Change> = []
  if (after.state !== before.state)
    found.push({ line: spoken(after.state === "OPEN" ? "REOPENED" : after.state), matters: ALL, ends: ended(after.state) ? ALL : [] })
  if (after.head !== before.head) found.push({ line: `new head ${short(after.head)} (was ${short(before.head)})`, matters: ["changed"], ends: [] })
  const failing = after.failing.length > 0 ? `: ${after.failing.join(", ")}` : ""
  // Only a conclusion is told: checks that start running again, or go back to none, are kept silently.
  if (after.verdict !== before.verdict) {
    if (after.verdict === "pass" || after.verdict === "fail")
      found.push({
        line: `checks ${before.verdict} → ${after.verdict}${failing}`,
        matters: ["green", "changed"],
        ends: after.verdict === "pass" ? ["green"] : [],
      })
  } else if (after.verdict === "fail" && !same(after.failing, before.failing))
    found.push({ line: `checks still fail${failing}`, matters: ["green", "changed"], ends: [] })
  if ((after.decision ?? "") !== (before.decision ?? ""))
    found.push({
      line: `review: ${spoken(before.decision ?? "none")} → ${spoken(after.decision ?? "none")}`,
      matters: ["reviewed", "changed"],
      ends: ["reviewed"],
    })
  const added = after.reviews.filter((review) => !before.reviews.includes(review))
  if (added.length > 0) found.push({ line: `new review: ${added.join(", ")}`, matters: ["reviewed", "changed"], ends: ["reviewed"] })
  if (after.threads !== before.threads)
    found.push({ line: `unresolved threads: ${before.threads} → ${after.threads}`, matters: ["reviewed", "changed"], ends: [] })
  // GitHub says UNKNOWN while it works mergeability out after a push: not a change to tell.
  if (after.mergeable !== before.mergeable && after.mergeable !== "UNKNOWN" && before.mergeable !== "UNKNOWN")
    found.push({ line: `mergeable: ${spoken(before.mergeable)} → ${spoken(after.mergeable)}`, matters: ["changed"], ends: [] })
  return found
}

const differs = (left: Summary, right: Summary) => JSON.stringify(left) !== JSON.stringify(right)

export const PrWatch: Decider<WatchState, WatchCommand, WatchEvent, AlreadyThere> = {
  initial: undefined,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "Start": {
        const ref = refText(command)
        const reason = already(command.until, command.read)
        if (reason !== undefined) return Effect.fail(new AlreadyThere({ ref, reason }))
        const watch: Watch = {
          sessionID: command.sessionID,
          repo: command.repo,
          number: command.number,
          until: command.until,
          ...(command.note === undefined ? {} : { note: command.note }),
          since: now,
          last: command.read,
        }
        return Effect.succeed([Watched.make({ watch })])
      }
      case "Stop":
        return Effect.succeed(state === undefined ? [] : [Unwatched.make({})])
      case "Observe": {
        if (state === undefined || !differs(state.last, command.read)) return Effect.succeed([])
        const told = changes(state.last, command.read).filter((change) => change.matters.includes(state.until))
        if (told.length === 0) return Effect.succeed([Seen.make({ last: command.read })])
        return Effect.succeed([
          Noticed.make({
            last: command.read,
            lines: told.map((change) => change.line),
            ended: told.some((change) => change.ends.includes(state.until)),
          }),
        ])
      }
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "Watched":
        return event.watch
      case "Unwatched":
        return undefined
      case "Seen":
        return state === undefined ? state : { ...state, last: event.last }
      case "Noticed":
        return state === undefined || event.ended ? undefined : { ...state, last: event.last }
    }
  },
}

/** The notice a session reads: the request, what changed, its note and whether the watch goes on. */
export const noticeText = (watch: Watch, noticed: Noticed, detail?: string): string =>
  [
    `PR watch · ${refText(watch)} ${noticed.last.title}`,
    noticed.last.url,
    ...noticed.lines.map((line) => `- ${line}`),
    ...(detail === undefined ? [] : ["", detail]),
    ...(watch.note === undefined ? [] : ["", `note: ${watch.note}`]),
    "",
    noticed.ended ? "The watch ended." : `Still watching (until ${watch.until}); pr({ action: "unwatch" }) stops it.`,
  ].join("\n")

/** The notice's one-line description, the `◈` row the TUI draws. */
export const noticeTitle = (watch: Watch, noticed: Noticed): string => `PR ${refText(watch)}: ${noticed.lines[0] ?? "changed"}`

/** A watch as `pr({ action: "list" })` names it. */
export const watchLine = (watch: Watch): string =>
  `${refText(watch)} ${watch.last.title} · until ${watch.until} · checks ${watch.last.verdict}${watch.note === undefined ? "" : ` · note: ${watch.note}`}`
