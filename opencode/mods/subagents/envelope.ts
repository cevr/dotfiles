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
  Object.fromEntries([...written.matchAll(ATTRIBUTE)].map((match) => [match[1]!, match[2]!]))

/** Where the closing tag of the `name` element opened before `from` starts and ends, counting the same name nested inside. */
function closing(text: string, name: string, from: number): { readonly start: number; readonly end: number } | undefined {
  const tags = new RegExp(`<(/?)${name}(?=[\\s>])(?:"[^"]*"|[^>"])*>`, "g")
  tags.lastIndex = from
  let depth = 1
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    depth += match[1] ? -1 : 1
    if (depth === 0) return { start: match.index, end: match.index + match[0].length }
  }
  return undefined
}

/** The envelopes in `text`, in order, the outer one only where one holds another. */
export function envelopes(text: string): Envelope[] {
  const found: Envelope[] = []
  OPEN.lastIndex = 0
  for (let match = OPEN.exec(text); match; match = OPEN.exec(text)) {
    const name = match[1]!
    const written = attributesOf(match[2] ?? "")
    const { kind, ...rest } = written
    const form: Form = name === TAG ? "background-result" : "kind"
    const of = form === "kind" ? name : kind
    if (of === undefined) continue
    const attributes = form === "kind" ? written : rest
    const open = match.index + match[0].length
    const close = closing(text, name, open)
    const inner = text.slice(open, close?.start ?? text.length).replace(/^\n/, "")
    const body = close ? inner.replace(/\n$/, "") : inner
    const end = close?.end ?? text.length
    found.push({ kind: of, form, attributes, body, start: match.index, end })
    OPEN.lastIndex = end
  }
  return found
}

/** The first envelope in `text`, of `kind` when one is named. */
export function envelope(text: string, kind?: string): Envelope | undefined {
  return envelopes(text).find((each) => kind === undefined || each.kind === kind)
}

/** What a notice says the work answered: the body of its first envelope, else all of the text; trimmed. */
export function answered(text: string): string {
  return (envelope(text)?.body ?? text).trim()
}

/** `text` with each envelope of `kind` replaced by its body: the work's answer without the host's tags around it. */
export function unwrap(text: string, kind: string): string {
  let out = ""
  let at = 0
  for (const each of envelopes(text)) {
    if (each.kind !== kind) continue
    out += text.slice(at, each.start) + each.body
    at = each.end
  }
  return out + text.slice(at)
}

/** An envelope as OpenCode writes it in `form`; `attributes` in order, `kind` left out (the kind names it). */
export function render(form: Form, kind: string, attributes: Readonly<Record<string, string>>, body: string): string {
  const written = Object.entries(attributes)
    .filter(([name]) => name !== "kind")
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("")
  return form === "background-result"
    ? `<${TAG} kind="${kind}"${written}>\n${body}\n</${TAG}>`
    : `<${kind}${written}>\n${body}\n</${kind}>`
}

/** The envelopes in every string a value holds (a model request, a session's context, as JSON values). */
export function envelopesIn(value: unknown): Envelope[] {
  if (typeof value === "string") return envelopes(value)
  if (Array.isArray(value)) return value.flatMap(envelopesIn)
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(envelopesIn)
  return []
}
