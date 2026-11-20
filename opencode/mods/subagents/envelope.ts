// A background notice's envelope: how OpenCode wraps what a shell, a
// subagent, a code-mode job, an image or a video job answered, in the
// synthetic message that tells the session it ended. The one reader of it
// every plugin, sim and test shares; nothing else parses the tags. Plain
// TypeScript, as the subagents fence asks; sim/envelopes.ts reads it out of
// JSON for the sims and tests.
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

type Attribute = readonly [name: string, value: string]

const attributesOf = (written: string): ReadonlyArray<Attribute> =>
  [...written.matchAll(ATTRIBUTE)].map((match): Attribute => [match[1]!, match[2]!])

interface Span {
  readonly start: number
  readonly end: number
}

/**
 * Where the closing tag of the `name` element opened before `from` is (none or one). The host writes a body raw, with
 * no escaping, and its own tags each on a line of their own, so only a tag at a line's start counts, as `OPEN` counts
 * one: a body that names a tag mid-line (a grep of a file that says `<shell>`) is text. A body may still hold the tag
 * at a line's start: a whole notice it quotes nests, counted by depth; a closing tag alone on a line (a shell that
 * printed one) cannot be told from the host's but by place, and the host's is the last before the next notice, so the
 * envelope ends at the last closing tag before an opening tag that follows it at depth 0 (the next notice in the same
 * text), else the last in the text. Ambiguous only where a body prints a stray closing tag and then an opening one.
 */
function closing(text: string, name: string, from: number): ReadonlyArray<Span> {
  const tags = new RegExp(`(?<=^|\\n)<(/?)${name}(?=[\\s>])(?:"[^"]*"|[^>"])*>`, "g")
  tags.lastIndex = from
  let depth = 1
  let last: ReadonlyArray<Span> = []
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    if (match[1] !== "/" && depth === 0) break
    if (match[1] === "/") {
      depth = Math.max(0, depth - 1)
      last = [{ start: match.index, end: match.index + match[0].length }]
    } else depth += 1
  }
  return last
}

type Head = Pick<Envelope, "kind" | "form" | "attributes">

/** What an opening tag says (none or one): its kind, form and attributes; none for a `<background-result>` that names no kind. */
function headOf(name: string, written: ReadonlyArray<Attribute>): ReadonlyArray<Head> {
  if (name !== TAG) return [{ kind: name, form: "kind", attributes: Object.fromEntries(written) }]
  const rest = Object.fromEntries(written.filter(([key]) => key !== "kind"))
  return written.flatMap(([key, kind]): ReadonlyArray<Head> => {
    if (key !== "kind") return []
    return [{ kind, form: "background-result", attributes: rest }]
  })
}

/** The envelope an opening tag starts (none or one). */
function readAt(text: string, match: RegExpExecArray): ReadonlyArray<Envelope> {
  const name = match[1]!
  const open = match.index + match[0].length
  const [close] = closing(text, name, open)
  let body = text.slice(open, close?.start ?? text.length).replace(/^\n/, "")
  // Only a closed envelope wrote a newline before its closing tag.
  if (close) body = body.replace(/\n$/, "")
  const end = close?.end ?? text.length
  return headOf(name, attributesOf(match[2]!)).map((head) => ({ ...head, body, start: match.index, end }))
}

/** The envelopes in `text`, in order, the outer one only where one holds another. */
export function envelopes(text: string): Envelope[] {
  const found: Envelope[] = []
  const open = new RegExp(OPEN)
  for (let match = open.exec(text); match; match = open.exec(text)) {
    for (const read of readAt(text, match)) {
      found.push(read)
      open.lastIndex = read.end
    }
  }
  return found
}

/** The envelopes of `kind` in `text`, in order. */
export const envelopesOf = (text: string, kind: string): Envelope[] => envelopes(text).filter((each) => each.kind === kind)

/** What a notice says the work answered: the body of its first envelope, else all of the text; trimmed. */
export const answered = (text: string): string => (envelopes(text)[0]?.body ?? text).trim()

/** `text` with each envelope of `kind` replaced by its body: the work's answer without the host's tags around it. */
export function unwrap(text: string, kind: string): string {
  let out = ""
  let at = 0
  for (const each of envelopesOf(text, kind)) {
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
  if (form === "background-result") return `<${TAG} kind="${kind}"${written}>\n${body}\n</${TAG}>`
  return `<${kind}${written}>\n${body}\n</${kind}>`
}
