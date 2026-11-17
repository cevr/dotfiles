// The subscription route's completion rule, ported from okra's
// `completeImage`: the response is a server-sent event stream read to its end;
// the first `response.output_item.done` whose item is a completed (or
// status-less) `image_generation_call` with a result wins, and later ones are
// ignored. `generating` items never count. A null result is an empty image; no
// image at all is NO_IMAGE, unless the stream said why it failed. A payload
// that is not the expected JSON fails the whole response.
//
// `decodeBase64` reads base64 loosely, as `Uint8Array.fromBase64` does in
// okra: whitespace skipped, a missing pad accepted.
import { Array as Arr, Option, Result, Schema } from "effect"
import { fail, type ImageFailed } from "./outcome.ts"

const Item = Schema.Struct({
  type: Schema.String,
  status: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const Event = Schema.Struct({
  type: Schema.String,
  item: Schema.optionalKey(Item),
  message: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(
    Schema.Struct({ error: Schema.optionalKey(Schema.NullOr(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))) }),
  ),
})
type Event = typeof Event.Type

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

export const SCHEMA_MISMATCH = "response does not match the expected schema"

/** The data payload of each event in `text`, in order; `[DONE]` and empty events left out. */
export const payloads = (text: string): ReadonlyArray<string> =>
  Arr.filter(
    Arr.map(text.replaceAll("\r\n", "\n").split("\n\n"), (event) =>
      Arr.map(
        Arr.filter(event.split("\n"), (line) => line.startsWith("data:")),
        (line) => line.slice(5).replace(/^ /u, ""),
      ).join("\n"),
    ),
    (payload) => payload !== "" && payload !== "[DONE]",
  )

/** What the events so far decided: the image's base64 once found, and the reason the stream gave for failing. */
interface Scan {
  readonly found: Option.Option<Result.Result<string, ImageFailed>>
  readonly reason: Option.Option<string>
}

const imageOf = (event: Event): Option.Option<Result.Result<string, ImageFailed>> =>
  Option.flatMap(
    Option.filter(
      Option.fromNullishOr(event.item),
      (item) =>
        event.type === "response.output_item.done" &&
        item.type === "image_generation_call" &&
        Option.match(Option.fromNullishOr(item.status), { onNone: () => true, onSome: (status) => status === "completed" }),
    ),
    (item) =>
      Option.map(Option.fromUndefinedOr(item.result), (result) =>
        Option.match(Option.fromNullOr(result), {
          onNone: () => Result.fail(fail("NO_IMAGE", "Backend returned an empty image result.")),
          onSome: (base64) => Result.succeed(base64),
        }),
      ),
  )

const reasonOf = (event: Event): Option.Option<string> => {
  if (event.type === "error") return Option.fromNullishOr(event.message)
  if (event.type !== "response.failed") return Option.none()
  return Option.flatMap(
    Option.flatMap(Option.fromNullishOr(event.response), (response) => Option.fromNullishOr(response.error)),
    (error) => Option.fromNullishOr(error.message),
  )
}

const step = (scan: Scan, event: Event): Scan => ({
  found: Option.orElse(scan.found, () => imageOf(event)),
  reason: Option.orElse(scan.reason, () => reasonOf(event)),
})

/** The image's base64 from a whole event stream, or why there is none. */
export const completeImage = (text: string): Result.Result<string, ImageFailed> => {
  const events = Arr.map(payloads(text), (payload) => decodeEvent(payload))
  if (Arr.some(events, Option.isNone)) return Result.fail(fail("GENERATION_FAILED", `Image generation failed: ${SCHEMA_MISMATCH}`))
  const scan = Arr.reduce(Arr.getSomes(events), { found: Option.none(), reason: Option.none() } satisfies Scan, step)
  return Option.getOrElse(scan.found, () =>
    Result.fail(
      Option.match(scan.reason, {
        onNone: () => fail("NO_IMAGE", "Backend returned no image. Try rephrasing the prompt."),
        onSome: (reason) => fail("GENERATION_FAILED", `Image generation failed: ${reason}`),
      }),
    ),
  )
}

const pad = (text: string) => {
  if (text.includes("=")) return text
  if (text.length % 4 === 2) return `${text}==`
  if (text.length % 4 === 3) return `${text}=`
  return text
}

/** Loose base64 as bytes; `who` names the backend in the failure. */
export const decodeBase64 = (text: string, who: string): Result.Result<Uint8Array, ImageFailed> =>
  Result.try({
    try: () => Uint8Array.fromBase64(pad(text.replace(/[ \t\n\r\f]/gu, ""))),
    catch: () => fail("DECODE_FAILED", `${who} returned invalid base64 image data`),
  })
