// When a turn ended, as the row under it reads, without rendering: the time in
// the owner's zone (`9:12 PM ET`), then the host's own when its clock reads
// another offset (the workbox runs on UTC: `9:12 PM ET · 02:12 UTC`), with the
// date first once the turn is older than the owner's today (`Nov 16 9:12 PM ET`).
import { Option, Predicate, Schema } from "effect"
import type { MessageTime } from "./session.ts"

/** The owner's zone when the prime plugin's `zone` option names none. */
export const OWNER_ZONE = "America/New_York"

/** One part of `at` (ms) as `zone` formats it with `options`. */
const part = (zone: string, at: number, type: Intl.DateTimeFormatPartTypes, options: Intl.DateTimeFormatOptions) =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).formatToParts(at).find((each) => each.type === type)), (found) => found.value),
    () => zone,
  )

/** A zone's short name at `at`: the generic one where it is short (`ET`, `PT`), else the standard one (`UTC`, `GMT+5:30`). */
const zoneLabel = (zone: string, at: number) =>
  Option.getOrElse(
    Option.liftPredicate(part(zone, at, "timeZoneName", { timeZoneName: "shortGeneric" }), (generic) => /^[A-Z]{1,4}$/.test(generic)),
    () => part(zone, at, "timeZoneName", { timeZoneName: "short" }),
  )

/** The zone's offset from UTC at `at`, as `longOffset` writes it (`GMT-05:00`). */
const offset = (zone: string, at: number) => part(zone, at, "timeZoneName", { timeZoneName: "longOffset" })

/** The calendar day of `at` in `zone`. */
const day = (zone: string, at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)

/**
 * The row's text for a turn that ended at `ended` (ms), read at `now` (ms), in
 * the owner's zone `owner` and the host's zone `host` (IANA names).
 */
export function turnTime(ended: number, now: number, owner: string, host: string): string {
  const date = Option.match(Option.liftPredicate(ended, () => day(owner, ended) !== day(owner, now)), {
    onNone: () => "",
    onSome: (at) => `${new Intl.DateTimeFormat("en-US", { timeZone: owner, month: "short", day: "numeric" }).format(at)} `,
  })
  // ICU puts a narrow no-break space before AM/PM; the row reads a plain one.
  const ownerTime = new Intl.DateTimeFormat("en-US", { timeZone: owner, hour: "numeric", minute: "2-digit", hour12: true }).format(ended).replaceAll("\u202f", " ")
  const shown = `${date}${ownerTime} ${zoneLabel(owner, ended)}`
  if (offset(owner, ended) === offset(host, ended)) return shown
  const hostTime = new Intl.DateTimeFormat("en-GB", { timeZone: host, hour: "2-digit", minute: "2-digit", hour12: false }).format(ended)
  return `${shown} · ${hostTime} ${zoneLabel(host, ended)}`
}

/**
 * The row under a step that ended its turn: none while a retry is pending (the
 * turn goes on), else its time from the step's completion, or its start when an
 * interrupted step has none.
 */
export const turnEnd = (step: { readonly time: MessageTime; readonly retry?: unknown }, now: number, owner: string, host: string): Option.Option<string> =>
  Option.map(
    Option.liftPredicate(step, (each) => Predicate.isUndefined(each.retry)),
    (each) => turnTime(Option.getOrElse(Option.fromNullishOr(each.time.completed), () => each.time.created), now, owner, host),
  )

/** The row as a frame's line reads it: `turnTime`'s text, right-aligned. */
export const TURN_TIME_ROW = /^ +(?:[A-Z][a-z]{2} \d{1,2} )?\d{1,2}:\d{2} [AP]M [A-Z][A-Za-z+\-:\d]*(?: · \d{2}:\d{2} [A-Z][A-Za-z+\-:\d]*)?$/

/** A frame's line with the row, whose wall time differs from run to run, as `<turn-time>`; any other line as it is. */
export const maskTurnTime = (line: string): string => line.replace(TURN_TIME_ROW, "<turn-time>")

/** As `maskTurnTime`, but the mask keeps the row's right edge: a row drawn anywhere but the right reads differently. */
export const maskTurnTimeInPlace = (line: string): string => line.replace(TURN_TIME_ROW, (row) => "<turn-time>".padStart(row.length))

/** The host's own zone: TZ when set, else the system's. */
export const hostZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

const Options = Schema.Struct({ zone: Schema.String })

/** The owner's zone from the prime plugin's options: `zone` when it names a zone this host knows, else `OWNER_ZONE`. */
export const ownerZone = (options: { readonly zone?: unknown }): string =>
  Option.getOrElse(
    Schema.decodeUnknownOption(Options)(options).pipe(
      Option.map((decoded) => decoded.zone),
      Option.filter((zone) => Option.isSome(Option.liftThrowable(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }))())),
    ),
    () => OWNER_ZONE,
  )
