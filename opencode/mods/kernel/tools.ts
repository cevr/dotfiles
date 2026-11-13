// The tools a cell reaches, as plain values: which ones its permission rules
// leave it, how the model reads them, the words for a tool it does not have,
// and the value a tool's result is to the cell, with each image it returned
// as a marker.
//
// A cell sees the session's tools less the code tools (`kernel` itself and
// code mode's `execute`). Without the runtime it also skips the tools whose
// policy lives in `execute.before` hooks (HOOKED_TOOLS), since a direct
// `execute` skips those hooks.
import { Effect, Schema } from "effect"
import type { Json } from "./frame.ts"
import { firstSentence } from "./summary.ts"

/** A cell's tool call failed; the cell's `await` throws an Error with `message`. */
export class CallFailed extends Schema.TaggedError<CallFailed>()("CallFailed", { message: Schema.String }) {}

/** The words of whatever a call failed with: its message when it has one. */
export const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

/** One permission rule, as agents and sessions carry them. */
export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: string
}

/** Tools a cell never reaches: the kernel itself, and code mode's interpreter. */
export const CODE_TOOLS: ReadonlySet<string> = new Set(["kernel", "execute"])

/**
 * Tools a cell never reaches because their policy lives in `execute.before`
 * hooks a cell's call skips: `subagent` passes orchestrate's role guard, the
 * pace hold and the Sabbath stop there; `shell` (`bash` before the rename)
 * passes the guard that refuses a command that loses work for good. Start
 * agents and run commands with the direct tools.
 */
export const HOOKED_TOOLS: ReadonlySet<string> = new Set(["subagent", "shell", "bash"])

/** OpenCode's permission wildcard: `*` is any text, `?` one character, a trailing ` *` optional. */
export const wildcard = (input: string, pattern: string): boolean => {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"))
}

/** As the registry decides: the last rule for `action` denies it for every resource. */
export const whollyDisabled = (action: string, rules: ReadonlyArray<Rule>): boolean => {
  const rule = rules.findLast((item) => wildcard(action, item.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

/** A tool the registry lists: its id, and the permission that gates it when it is not the id. */
export interface Registered {
  readonly id: string
  readonly permission?: string | undefined
}

/** The registry's tools a cell may call under `rules`, keyed by id. */
export const callable = <T extends Registered>(tools: ReadonlyArray<T>, rules: ReadonlyArray<Rule>): ReadonlyMap<string, T> =>
  new Map(
    tools
      .filter(
        (tool) => !CODE_TOOLS.has(tool.id) && !HOOKED_TOOLS.has(tool.id) && !whollyDisabled(tool.permission ?? tool.id, rules),
      )
      .map((tool) => [tool.id, tool] as const),
  )

/** What a cell's call of a tool it does not have answers. */
export const notATool = (id: string, names: Iterable<string>) => `${id} is not a tool here. Tools: ${[...names].sort().join(", ") || "none"}`

/** One tool the runtime reaches, with its input as JSON Schema. */
export interface Reached {
  readonly name: string
  readonly description: string
  readonly input: unknown
}

/** The runtime's tools a cell reaches: all but the code tools. */
export const reachable = <T extends Reached>(tools: ReadonlyArray<T>): ReadonlyArray<T> =>
  tools.filter((tool) => !CODE_TOOLS.has(tool.name))

type Schemaish = { readonly [key: string]: unknown }
const isRecord = (value: unknown): value is Schemaish => typeof value === "object" && value !== null && !Array.isArray(value)

/** A JSON Schema as a short TypeScript-like type, enough to call the tool by. */
export const typeOf = (schema: unknown, depth = 0): string => {
  if (!isRecord(schema)) return "unknown"
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  if ("const" in schema) return JSON.stringify(schema.const)
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined
  if (union) return union.map((item) => typeOf(item, depth)).join(" | ")
  const type = Array.isArray(schema.type) ? schema.type.filter((item) => item !== "null") : [schema.type]
  const named = type.map((item) => {
    if (item === "integer" || item === "number") return "number"
    if (item === "string" || item === "boolean" || item === "null") return String(item)
    if (item === "array") return `${typeOf(schema.items, depth)}[]`
    if (item === "object" || isRecord(schema.properties)) {
      if (!isRecord(schema.properties) || depth > 2) return "object"
      const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
      const fields = Object.entries(schema.properties).map(
        ([key, value]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${typeOf(value, depth + 1)}`,
      )
      return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`
    }
    return "unknown"
  })
  return named.join(" | ") || "unknown"
}

/** How a tool differs in a cell: its input there, its line in the catalog, and the note its docs add. */
export interface InACell {
  readonly input: string
  readonly line: string
  readonly note: string
}

/**
 * How a tool differs in a cell from what its own description says: the shell
 * tool only runs commands there, and acts on a shell through its handle's
 * methods (worker/shell-handle.ts); the subagent tool resolves to a handle
 * whose methods wait on and stop the subagent (worker/subagent-handle.ts).
 */
export const IN_A_CELL: Readonly<Record<string, InACell>> = {
  shell: {
    input: "{ command: string, workdir?: string, timeout?: number, description?: string, background?: boolean }",
    line: "Runs a command and resolves to a live handle whose methods (.wait, .kill, .refresh, .read) act on that shell.",
    note: "In a cell, `tools.shell({ command, workdir?, timeout?, description?, background? })` only runs a command, and resolves to a live handle: `.id`, `.state`, `.exitCode`, `.signal`, `.runtimeMs`, `.output`, `.next`, and methods that act on that shell, update the handle in place and resolve to it: `.refresh()` (its state now), `.read({ offset?, lines? })`, `.wait(ms?)` (up to 10 min by default), `.kill()`. `.output` is the command's output the handle has seen, newest last: a method adds what is new, so after `await h.wait()` it holds the output from the start; `.read` with an offset or lines puts what it asked for there instead. `await tools.shell.handle(id)` builds one for a shell this session started, and `await tools.shell.list()` one for each of them (with `.description` and `.command`). Example: `const h = await tools.shell({ command: 'bun dev', background: true }); await h.wait(500); await h.kill()`. A kernel restart keeps a handle's data but not its methods, so rebuild it with `tools.shell.handle(h.id)`. The tool's other actions (check, wait, kill, list) are these methods in a cell: an input naming one throws, naming the method.",
  },
  subagent: {
    input: "{ agent: string, description: string, prompt: string, model?: string, sessionID?: string }",
    line: "Starts a subagent in the background and resolves to a live handle whose methods (.wait, .stop, .read, .refresh) act on it.",
    note: "In a cell, `tools.subagent({ agent, description, prompt, model?, sessionID? })` starts a subagent in the background (or, with a sessionID, sends one more work) and resolves to a live handle: `.sessionID`, `.description`, `.agent`, `.state` (running, done, stopped, failed), `.message` (its last message, as the latest method read it), `.note` (what the latest method did), and methods that update the handle in place and resolve to it: `.wait(ms?)` (up to 10 min by default, until it goes idle; `.message` is then its final message, and `.note` says when it still runs), `.stop()` (ends its turn, its background shells and queued prompts, and its own subagents'; you hear once that it was cancelled, never that it finished; a second stop changes nothing), `.read()` and `.refresh()` (its state now and its last message). `await tools.subagent.handle(sessionID)` builds one for a subagent of this session, and `await tools.subagent.list()` one for each. Example: `const h = await tools.subagent({ agent: 'worker', description: 'probe', prompt: '…' }); await h.wait(60_000); if (h.state === 'running') await h.stop()`. A kernel restart keeps a handle's data but not its methods, so rebuild it with `tools.subagent.handle(h.sessionID)`. The `subagents` tool does the same outside a cell.",
  },
}

/** A tool's full words in a cell, as `tools.docs(name)` gives them: its description, then how it differs in a cell. */
export const docsOf = (name: string, description: string): string => {
  const note = IN_A_CELL[name]?.note
  return note === undefined ? description.trim() : `${description.trim()}\n\n${note}`
}

/** How a cell reaches a tool: `tools.read`, or `tools["mcp-search"]` for a name that is not an identifier. */
export const pathOf = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`)

const byName = <T extends { readonly name: string }>(left: T, right: T) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

/**
 * The tools a cell reaches, as the model reads them in the kernel's
 * description: one line each, sorted by name, with its input and the first
 * sentence of its description. The rest is in `tools.docs(name)`.
 */
export const catalog = (tools: ReadonlyArray<Reached>): string =>
  [...reachable(tools)]
    .sort(byName)
    .map((tool) => {
      const cell = IN_A_CELL[tool.name]
      return `- ${pathOf(tool.name)}(input: ${cell?.input ?? typeOf(tool.input)}): ${cell?.line ?? firstSentence(tool.description)}`
    })
    .join("\n")

/** One part of a tool result's content: text, or a file (`uri` a data URI or a link). */
export interface ContentPart {
  readonly type: string
  readonly text?: string
  readonly mime?: string
  readonly uri?: string
  readonly name?: string
}

/** A result's text parts joined, else null: what a result without an output is to a cell. */
export const textOf = (content: string | ReadonlyArray<ContentPart> | undefined): string | null => {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? [])
  const text = parts.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n")
  return text === "" ? null : text
}

/**
 * A value as a cell gets it: through JSON, so it is plain data and an
 * undefined field is dropped as it would be on the wire. A value JSON cannot
 * write is null; one it refuses (a BigInt, a cycle) fails the call.
 */
export const plain = (value: unknown): Effect.Effect<Json, CallFailed> =>
  Effect.try({
    try: (): Json => {
      const text = JSON.stringify(value)
      return text === undefined ? null : JSON.parse(text)
    },
    catch: (cause) => new CallFailed({ message: messageOf(cause) }),
  })

// ── Images in a tool's result ──

/** What a marker tells the cell to do to see the image. */
export const IMAGE_NOTE = "not shown; call attach(path) to see it"

/**
 * What a cell gets in place of an image a tool returned (the read tool's image
 * output, a file part of a result's content): its type and, when the result
 * named one, its path. The base64 would only be text to the model, and over
 * about 1 MiB it would not fit the reply frame.
 */
export interface ImageMarker {
  readonly type: "image"
  readonly mime: string
  readonly name?: string
  readonly note: typeof IMAGE_NOTE
}

type JsonRecord = { readonly [key: string]: Json }
const isJsonRecord = (value: Json): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value)

/** An image inline in a result: an image type with base64 content (the read tool's output) or a data URI (a file part). */
const isInlineImage = (value: JsonRecord): boolean =>
  typeof value.mime === "string" &&
  value.mime.startsWith("image/") &&
  ((value.encoding === "base64" && typeof value.content === "string") || (typeof value.uri === "string" && value.uri.startsWith("data:")))

/** The path an image came from: its name, else its link as a path (a `file:` URL) or as it is; a data URI names none. */
const imageName = (value: JsonRecord): string | undefined => {
  if (typeof value.name === "string" && value.name !== "") return value.name
  if (typeof value.uri !== "string" || value.uri.startsWith("data:")) return undefined
  if (!value.uri.startsWith("file:")) return value.uri
  try {
    return decodeURIComponent(new URL(value.uri).pathname)
  } catch {
    return value.uri
  }
}

/** `value` with every image inline in it, at any depth, replaced by its marker. */
export const withoutImages = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(withoutImages)
  if (!isJsonRecord(value)) return value
  if (isInlineImage(value)) {
    const name = imageName(value)
    const marker: ImageMarker = { type: "image", mime: String(value.mime), ...(name === undefined ? {} : { name }), note: IMAGE_NOTE }
    return { ...marker }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutImages(item)]))
}

/**
 * A result without an output as a cell gets it: its text, as `textOf`, unless
 * its content holds an image; then the content as a list, text parts as
 * `{ type: "text", text }`, each image as its marker, any other file as its
 * type and name without its data.
 */
export const contentValue = (content: string | ReadonlyArray<ContentPart> | undefined): unknown => {
  const parts = typeof content === "string" || content === undefined ? [] : content
  const image = (part: ContentPart) => part.type === "file" && part.mime?.startsWith("image/") === true
  if (!parts.some(image)) return textOf(content)
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text ?? "" }
    if (image(part)) return part
    return { type: part.type, ...(part.mime === undefined ? {} : { mime: part.mime }), ...(part.name === undefined ? {} : { name: part.name }) }
  })
}

/** A tool's result as a cell gets it: its output, else its content, as plain data with each image a marker. */
export const cellValue = (result: { readonly output?: unknown; readonly content?: string | ReadonlyArray<ContentPart> }): Effect.Effect<Json, CallFailed> =>
  plain(result.output === undefined ? contentValue(result.content) : result.output).pipe(Effect.map(withoutImages))
