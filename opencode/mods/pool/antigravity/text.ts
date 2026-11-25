// Antigravity's rows as the owner and an agent read them: in the /pool pane,
// in `pool_push` status and in the `antigravity` tool's answers. Use is the
// share of a window used out of 100% (usage-text.ts), times are the house
// format (decider/notification-time.ts), and an unknown window says why.
import { Array as Arr, Match, Option } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { used } from "../usage-text.ts"
import type { Span } from "./quota.ts"
import { Answer, answerAt, groupsOf, type Shown, type State, type Why, windowAt } from "./state.ts"

const SPAN_NAME = { "5h": "5-hour", "7d": "weekly", quota: "quota" } as const satisfies { readonly [K in Span]: string }

/** Why nothing, or not all, can be said, in words. */
export const whyText = (why: Why): string =>
  Match.value(why).pipe(
    Match.tagsExhaustive({
      NotRead: () => "not read yet",
      NoSignIn: () => "no Antigravity sign-in on this host: sign in with agy",
      NotReadableHere: () => "sign-in not readable here",
      SignInExpired: () => "sign-in expired: start an Antigravity turn",
      KeychainRefused: ({ outcome }) => `the keychain read ${Match.value(outcome).pipe(Match.when("denied", () => "was denied"), Match.when("failed", () => "failed"), Match.orElse(() => "timed out"))}: not tried again until asked (antigravity action read)`,
      KeychainNotAsked: () => "no sign-in file: the keychain is read only once asked (antigravity action read)",
      RequestFailed: ({ why: reason, status }) =>
        `Google's quota read ${Match.value(reason).pipe(
          Match.when("refused", () => "was refused"),
          Match.when("rate-limited", () => "was rate limited"),
          Match.when("timed-out", () => "timed out"),
          Match.when("unreachable", () => "could not reach Google"),
          Match.when("malformed", () => "answered nothing readable"),
          Match.orElse(() => "failed"),
        )}${Option.match(Option.fromUndefinedOr(status), { onNone: () => "", onSome: (code) => ` (${code})` })}`,
      NoQuota: () => "Google answered no quota this reads",
      HostRefused: ({ host }) => `a request to ${host} was refused: not a Google host`,
      WindowUnknown: ({ span }) => `the ${SPAN_NAME[span]} window is unknown`,
      FullWithoutReset: ({ span }) => `the ${SPAN_NAME[span]} window is full, its reset unknown`,
    }),
  )

const sinceText = (since: Option.Option<number>) =>
  Option.match(since, { onNone: () => "no limit seen ever", onSome: (at) => `no limit seen since ${formatNotificationTime(at)}` })

/**
 * An answer in words: `open` (measured), `limited until <time>`, `limited,
 * reset unknown`, `not measured (no limit seen since <time or ever>)` or
 * `unknown: <why>`.
 */
export const answerText = (answer: Answer): string =>
  Match.value(answer).pipe(
    Match.tagsExhaustive({
      Open: () => "open",
      Limited: ({ until, by }) => `limited until ${formatNotificationTime(until)}${Match.value(by).pipe(Match.when("limit", () => " (a pane's limit)"), Match.orElse(() => ""))}`,
      LimitedResetUnknown: ({ seenAt }) => `limited, reset unknown (a pane's limit at ${formatNotificationTime(seenAt)})`,
      Unmeasured: ({ why, since }) => `not measured (${sinceText(Option.fromUndefinedOr(since))}): ${whyText(why)}`,
      Unknown: ({ why }) => `unknown: ${whyText(why)}`,
    }),
  )

/** The answer to "is it open now": an unmeasured group is usable, never called open. */
export const openText = (answer: Answer): string =>
  Answer.match(answer, {
    Open: () => "open (measured)",
    Limited: () => answerText(answer),
    LimitedResetUnknown: () => answerText(answer),
    Unmeasured: ({ since }) => `usable: yes, unmeasured (${sinceText(Option.fromUndefinedOr(since))})`,
    Unknown: () => answerText(answer),
  })

/** One window's row: `  5h 23% used of 100% · reset <time>`, or `  7d unknown: <why>`. */
export const windowText = (span: Span, shown: Shown): string =>
  Match.value(shown).pipe(
    Match.tagsExhaustive({
      Known: ({ window }) =>
        `  ${span} ${used(window.used)} · ${Option.match(Option.fromUndefinedOr(window.resetAt), { onNone: () => "no reset given", onSome: (at) => `reset ${formatNotificationTime(at)}` })}`,
      Unknown: ({ why }) => `  ${span} unknown: ${whyText(why)}`,
    }),
  )

const readLine = (state: State, now: number): string => {
  const read = Option.map(Option.fromUndefinedOr(state.reading), (reading) => `read ${formatNotificationTime(reading.at)}`)
  const failed = Option.map(Option.fromUndefinedOr(state.failure), (failure) => `last read ${formatNotificationTime(failure.at)}: ${whyText(failure.why)}`)
  const parts = [...Option.toArray(read), ...Option.toArray(failed)]
  const next = Match.value(state.nextReadAt > now).pipe(
    Match.when(true, () => `next read ${formatNotificationTime(state.nextReadAt)}`),
    Match.orElse(() => "next read due now"),
  )
  return `  ${parts.join(" · ") || "not read yet"} · ${next}`
}

/** The model groups the last reading named, so a pane can go to the group with room. */
const reportedLine = (state: State): ReadonlyArray<string> =>
  Option.toArray(
    Option.map(Option.fromUndefinedOr(state.reading), (reading) => {
      const groups = [...new Set(reading.windows.map((window) => window.label))]
      return `  groups Antigravity reported: ${groups.join(", ") || "none"}`
    }),
  )

/** Each group's newest pane limit: `  last limit seen <time> on <group>, resets <time>`. */
const limitLine = (state: State): ReadonlyArray<string> =>
  Option.getOrElse(Option.fromUndefinedOr(state.limits), () => []).map((limit) => {
    const reset = Option.match(Option.fromUndefinedOr(limit.resetAt), { onNone: () => "no reset given", onSome: (at) => `resets ${formatNotificationTime(at)}` })
    const label = Option.getOrElse(
      Option.map(Arr.findFirst(groupsOf(state), (group) => group.id === limit.group), (group) => group.label),
      () => limit.group,
    )
    return `  last limit seen ${formatNotificationTime(limit.seenAt)} on ${label}, ${reset}`
  })

/**
 * Antigravity's rows at `now`: each group with its answer and its 5-hour and
 * weekly windows (a window of unstated length too, when read), then when it
 * was read and the last limit a pane showed.
 */
export const statusLines = (state: State, now: number): ReadonlyArray<string> => [
  ...groupsOf(state).flatMap((group) => {
    const spans: ReadonlyArray<Span> = ["5h", "7d"]
    const quota = windowAt(state, now, group.id, "quota")
    const extra = Match.value(quota).pipe(Match.tag("Known", () => [windowText("quota", quota)]), Match.orElse(() => []))
    return [
      `antigravity / ${group.label} · ${answerText(answerAt(state, now, group.id))}`,
      ...spans.map((span) => windowText(span, windowAt(state, now, group.id, span))),
      ...extra,
    ]
  }),
  readLine(state, now),
  ...reportedLine(state),
  ...limitLine(state),
]
