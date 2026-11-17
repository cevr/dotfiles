// What a request ends as: the files saved, or one failure with its code. The
// failure codes are okra's (`AUTH_MISSING`, `AUTH_EXPIRED`, `GENERATION_FAILED`,
// `NO_IMAGE`, `DECODE_FAILED`, `WRITE_FAILED`, `INVALID_INPUT`), each with the
// fix the skill names. A server's own message reaches the outcome only through
// `detail`: at most 300 characters, every secret the request held cut out.
import { Array as Arr, Option, Schema } from "effect"

export const Code = Schema.Literals([
  "AUTH_MISSING",
  "AUTH_EXPIRED",
  "GENERATION_FAILED",
  "NO_IMAGE",
  "DECODE_FAILED",
  "WRITE_FAILED",
  "INVALID_INPUT",
])
export type Code = typeof Code.Type

/** A request that did not end in an image: its code and a message that names the fix. */
export class ImageFailed extends Schema.TaggedError<ImageFailed>()("ImageFailed", {
  code: Code,
  message: Schema.String,
}) {}

export const fail = (code: Code, message: string) => new ImageFailed({ code, message })
export const invalid = (message: string) => fail("INVALID_INPUT", message)

/** The longest server message an outcome carries. */
export const DETAIL_LIMIT = 300

const REDACTED = "[redacted]"

/** Credentials by shape, for a secret the request never named (a server echoing another header). */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[^\s"',;]+/giu,
  /\bsk-[A-Za-z0-9_-]{8,}/gu,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/gu,
]

/** `text` with each of `secrets` and anything shaped like a credential cut out. */
export const redact = (text: string, secrets: ReadonlyArray<string>): string => {
  const named = Arr.reduce(
    Arr.filter(secrets, (secret) => secret.length >= 4),
    text,
    (out, secret) => out.split(secret).join(REDACTED),
  )
  return Arr.reduce(CREDENTIAL_PATTERNS, named, (out, pattern) => out.replace(pattern, REDACTED))
}

/** A server's message as an outcome may carry it: redacted, then cut to `DETAIL_LIMIT`. */
export const detail = (text: string, secrets: ReadonlyArray<string>): string => {
  const clean = redact(text, secrets).trim()
  if (clean.length === 0) return "no error detail in response"
  if (clean.length <= DETAIL_LIMIT) return clean
  return `${clean.slice(0, DETAIL_LIMIT)}…`
}

/** One saved file and the dimensions read from its bytes, when they could be. */
export const Saved = Schema.Struct({
  path: Schema.String,
  width: Schema.OptionFromOptionalKey(Schema.Int),
  height: Schema.OptionFromOptionalKey(Schema.Int),
})
export interface Saved extends Schema.Schema.Type<typeof Saved> {}

/** A request that ended in images: the route it took, the files and a note on the size when the backend chose another. */
export const Outcome = Schema.Struct({
  route: Schema.String,
  saved: Schema.Array(Saved),
  note: Schema.OptionFromOptionalKey(Schema.String),
})
export interface Outcome extends Schema.Schema.Type<typeof Outcome> {}

const sizeOf = (saved: Saved) =>
  Option.match(Option.all([saved.width, saved.height]), {
    onNone: () => saved.path,
    onSome: ([width, height]) => `${saved.path} (${width}x${height})`,
  })

/** The outcome in words: what the end letter says. */
export const words = (outcome: Outcome): string => {
  const lines = [`Saved via ${outcome.route}:`, ...Arr.map(outcome.saved, (saved) => `- ${sizeOf(saved)}`)]
  const noted = Option.match(outcome.note, { onNone: () => lines, onSome: (note) => [...lines, note] })
  return [...noted, "Read the path to view it."].join("\n")
}

const FIXES: Readonly<Record<Code, string>> = {
  AUTH_MISSING: "Sign in with `codex login` (subscription), or set OPENAI_API_KEY / store a key with `bun cmd/image/key.ts set --stdin` (paid).",
  AUTH_EXPIRED: "Sign in again with `codex login` (subscription), or replace the OpenAI key (paid).",
  GENERATION_FAILED: "Try again later, or change the prompt.",
  NO_IMAGE: "Rephrase the prompt.",
  DECODE_FAILED: "Try again; the backend sent a broken image.",
  WRITE_FAILED: "Pick a path you can write to.",
  INVALID_INPUT: "Fix the input and call again.",
}

/** A failure in words: its code, its message and what to do. */
export const failureWords = (route: string, failed: ImageFailed): string =>
  [`[${failed.code}] ${failed.message}`, `Route: ${route}.`, FIXES[failed.code]].join("\n")
