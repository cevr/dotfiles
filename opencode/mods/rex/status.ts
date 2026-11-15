// The tally as a Rex program status record: an OSC 7501 report the showcase
// pane's viewer writes to its own terminal, so Rex shows it in the tab header
// and the session picker and `program_status` returns it. The protocol:
// https://www.superlogical.com/rex/docs/build/program-status.md
import { Option, Schema } from "effect"
import { Base64 } from "effect/encoding"

/** The states a tally may report; `working` stays until the viewer exits, `done` and `error` outlive it. */
export const TallyState = Schema.Literals(["idle", "working", "done", "blocked", "error"])
export type TallyState = typeof TallyState.Type

/** One tally: its line, its state, and a percentage when it has one. */
export const Tally = Schema.Struct({
  msg: Schema.String,
  state: TallyState,
  progress: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
})
export type Tally = typeof Tally.Type

/** The record's id and app: one tally record per showcase pane. */
export const TALLY_ID = "tally"
export const APP = "rex-show"

/** The protocol's cap on a decoded `msg`, in bytes. */
const MSG_BYTES = 2048

const ESC = "\u001b"

/** Whether `char` is a control character (C0, DEL or C1), which the protocol refuses in a `msg`: a report holding one is dropped whole. */
const isControl = (char: string) => {
  const code = char.charCodeAt(0)
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

/** `text` as one line within the protocol's limits: control characters as spaces, cut to 2048 UTF-8 bytes. */
export const oneLine = (text: string): string => {
  const flat = Array.from(text, (char) => Option.match(Option.liftPredicate(char, isControl), { onNone: () => char, onSome: () => " " }))
    .join("")
    .trim()
  const bytes = new TextEncoder().encode(flat)
  if (bytes.length <= MSG_BYTES) return flat
  return new TextDecoder().decode(bytes.slice(0, MSG_BYTES)).replace(/\uFFFD+$/, "")
}

const base64 = (text: string) => Base64.encode(text)

/** The OSC 7501 report of `tally`: its state, id, app, progress when set, and its line. */
export const report = (tally: Tally): string => {
  const progress = Option.match(Option.fromUndefinedOr(tally.progress), { onNone: () => [], onSome: (value) => [`progress=${value}`] })
  const pairs = [`state=${tally.state}`, `id=${TALLY_ID}`, `app=${APP}`, ...progress, `msg=${base64(oneLine(tally.msg))}`]
  return `${ESC}]7501;${pairs.join(":")}${ESC}\\`
}

/** The report that removes the tally record. */
export const clearReport = `${ESC}]7501;state=clear:id=${TALLY_ID}${ESC}\\`
