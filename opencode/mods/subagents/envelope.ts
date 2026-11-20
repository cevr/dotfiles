// A background notice's envelope: how OpenCode wraps what a shell, a
// subagent, a code-mode job, an image or a video job answered, in the
// synthetic message that tells the session it ended. The one reader of it
// every plugin, sim and test shares; nothing else parses the tags.
//
// Two forms, both read, since a stored session keeps the notices it got:
// - a tag per kind, up to upstream e51247f626:
//   `<shell id="…" state="…" command="…">\n<body>\n</shell>`, likewise
//   `<subagent sessionID="…" state="…" description="…">`, `<codemode id="…" state="…">`,
//   `<image id="…" state="…">`, `<video id="…" state="…">`;
// - one tag for every kind since (packages/core/src/session/background-result.ts):
//   `<background-result kind="shell" id="…" state="…" command="…">\n<body>\n</background-result>`.
// The body is the fork's as before (a shell's handle, a subagent's answer).
import { Array as Arr, Option, Predicate, Record, Schema } from "effect"

/** The kinds of background work a notice reports. */
export const KINDS = ["shell", "subagent", "codemode", "image", "video"] as const
export type Kind = (typeof KINDS)[number]

/** The one tag of the current form. */
export const TAG = "background-result"

/** The form an envelope is in: a tag per kind (`kind`) or the one `<background-result>` tag. */
export type Form = "kind" | "background-result"

export interface Envelope {
  /** The work it reports: the old form's tag, the new form's `kind` attribute. */
  readonly kind: string
  readonly form: Form
  /** Its attributes but `kind`, as written. */
  readonly attributes: Readonly<Record<string, string>>
  /** What the work answered, without the newline after the opening tag and before the closing one. */
  readonly body: string
  /** Where it starts and ends in the text read; an envelope with no closing tag runs to the text's end. */
  readonly start: number
  readonly end: number
}

const NAMES = [TAG, ...KINDS].join("|")
// An opening tag at a line's start, as OpenCode writes one (prose that names a tag mid-line is not one): a name, then
// attributes whose quoted values may hold `>` or a newline (a shell's command).
const OPEN = new RegExp(`(?<=^|\\n)<(${NAMES})(?=[\\s>])((?:"[^"]*"|[^>"])*)>`, "g")
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g

const attributesOf = (written: string): Record<string, string> =>
  Record.fromEntries(Arr.map([...written.matchAll(ATTRIBUTE)], (match): readonly [string, string] => [match[1]!, match[2]!]))

interface Span {
  readonly start: number
  readonly end: number
}

/** Where the closing tag of the `name` element opened before `from` is, counting the same name nested inside. */
function closing(text: string, name: string, from: number): Option.Option<Span> {
  const tags = new RegExp(`<(/?)${name}(?=[\\s>])(?:"[^"]*"|[^>"])*>`, "g")
  tags.lastIndex = from
  let depth = 1
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    if (match[1] === "/") depth -= 1
    else depth += 1
    if (depth === 0) return Option.some({ start: match.index, end: match.index + match[0].length })
  }
  return Option.none()
}

type Head = Pick<Envelope, "kind" | "form" | "attributes">

/** What an opening tag says: its kind, form and attributes; none for a `<background-result>` that names no kind. */
function headOf(name: string, written: Record<string, string>): Option.Option<Head> {
  if (name !== TAG) return Option.some({ kind: name, form: "kind", attributes: written })
  return Option.map(Record.get(written, "kind"), (kind): Head => ({ kind, form: "background-result", attributes: Record.remove(written, "kind") }))
}

/** The envelope an opening tag starts, or none for a `<background-result>` that names no kind. */
function readAt(text: string, match: RegExpExecArray): Option.Option<Envelope> {
  const name = match[1]!
  const open = match.index + match[0].length
  const close = closing(text, name, open)
  const { body, end } = Option.match(close, {
    onNone: () => ({ body: text.slice(open).replace(/^\n/, ""), end: text.length }),
    onSome: (span) => ({ body: text.slice(open, span.start).replace(/^\n/, "").replace(/\n$/, ""), end: span.end }),
  })
  return Option.map(headOf(name, attributesOf(match[2]!)), (head) => ({ ...head, body, start: match.index, end }))
}

/** The envelopes in `text`, in order, the outer one only where one holds another. */
export function envelopes(text: string): Envelope[] {
  const found: Envelope[] = []
  const open = new RegExp(OPEN)
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const read = readAt(text, match)
    if (Option.isSome(read)) {
      found.push(read.value)
      open.lastIndex = read.value.end
    }
  }
  return found
}

/** The first envelope of `kind` in `text`. */
export const envelope = (text: string, kind: string): Option.Option<Envelope> => Arr.findFirst(envelopes(text), (each) => each.kind === kind)

/** What a notice says the work answered: the body of its first envelope, else all of the text; trimmed. */
export const answered = (text: string): string =>
  Option.match(Arr.head(envelopes(text)), { onNone: () => text, onSome: (found) => found.body }).trim()

/** `text` with each envelope of `kind` replaced by its body: the work's answer without the host's tags around it. */
export function unwrap(text: string, kind: string): string {
  let out = ""
  let at = 0
  for (const each of envelopes(text)) {
    if (each.kind === kind) {
      out += text.slice(at, each.start) + each.body
      at = each.end
    }
  }
  return out + text.slice(at)
}

/** An envelope as OpenCode writes it in `form`; `attributes` in order, `kind` left out (the kind names it). */
export function render(form: Form, kind: string, attributes: Readonly<Record<string, string>>, body: string): string {
  const written = Object.entries(attributes)
    .filter(([name]) => name !== "kind")
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("")
  if (form === "background-result") return `<${TAG} kind="${kind}"${written}>\n${body}\n</${TAG}>`
  return `<${kind}${written}>\n${body}\n</${kind}>`
}

/** The envelopes in every string a JSON value holds (a model request, a session's context). */
export function envelopesIn(value: Schema.Json): Envelope[] {
  if (Predicate.isString(value)) return envelopes(value)
  if (isJsonArray(value)) return value.flatMap((each) => envelopesIn(each))
  if (isJsonObject(value)) return Object.values(value).flatMap((each) => envelopesIn(each))
  return []
}

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Arr.isArray(value)
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value) && !Arr.isArray(value)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** The envelopes in a JSON text's strings; none in text that is not JSON. */
export const envelopesInJson = (serialized: string): Envelope[] =>
  Option.match(decodeJson(serialized), { onNone: () => [], onSome: envelopesIn })
