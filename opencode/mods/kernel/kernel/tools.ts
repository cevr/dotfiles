// The tools a cell reaches, as plain values: which ones its permission rules
// leave it, how the model reads them, the words for a tool it does not have,
// and the value a tool's result is to the cell.
//
// A cell sees the session's tools less the code tools (`kernel` itself and
// code mode's `execute`). Without the runtime it also skips the tools whose
// policy lives in `execute.before` hooks (HOOKED_TOOLS), since a direct
// `execute` skips those hooks.
import { Effect, Schema } from "effect"
import type { Json } from "./frame.ts"

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
 * pace hold and the Sabbath stop there. Start agents with the direct tool.
 */
export const HOOKED_TOOLS: ReadonlySet<string> = new Set(["subagent"])

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

/** The tools a cell reaches, as the model reads them in the kernel's description. */
export const catalog = (tools: ReadonlyArray<Reached>): string =>
  reachable(tools)
    .map((tool) => {
      const path = /^[A-Za-z_$][\w$]*$/.test(tool.name) ? `tools.${tool.name}` : `tools[${JSON.stringify(tool.name)}]`
      return `### ${path}(input: ${typeOf(tool.input)})\n${tool.description.trim()}`
    })
    .join("\n\n")

/** One part of a tool result's content: only text parts carry words for a cell. */
export interface ContentPart {
  readonly type: string
  readonly text?: string
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
