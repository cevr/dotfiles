/**
 * The tools a kernel cell may call, and the call itself. A cell sees the
 * session's tools as its agent and session permissions leave them, less the
 * code tools (`kernel` itself and code mode's `execute`). A call decodes the
 * input against the tool's schema, runs the tool's own `execute` with the
 * kernel call's context, so the tool asks for permission and stops on abort as
 * it does for a direct call, and returns the result's value as code mode does.
 *
 * Two bridges. When the kernel is the agent's runtime (the fork's
 * `options.runtime`), a call goes through `context.runtime.call`: the
 * registry runs it with its `execute.before`/`execute.after` hooks, so every
 * tool is reachable, `subagent` included. Otherwise a call runs the tool's own
 * `execute` and skips those hooks, so tools whose policy lives there are left
 * out (HOOKED_TOOLS).
 *
 * @module
 */
import type { Plugin } from "@opencode/plugin"
import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import type { Json, Listing } from "./protocol.ts"

/** A registered tool as the plugin API lists it. */
export type HostTool = Awaited<ReturnType<Plugin.Context["tool"]["list"]>>[number]
/** The context a tool's `execute` runs with: the kernel call's own. */
export type HostContext = Parameters<HostTool["execute"]>[1]
/** What the registry hands the kernel while it is the agent's runtime. */
export type Runtime = NonNullable<HostContext["runtime"]>
/** One tool the runtime reaches, with its input as JSON Schema. */
export type RuntimeTool = Runtime["tools"][number]

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

/** The tools a cell may call under `rules`, keyed by id. */
export const callable = (tools: ReadonlyArray<HostTool>, rules: ReadonlyArray<Rule>): ReadonlyMap<string, HostTool> =>
  new Map(
    tools
      .filter(
        (tool) =>
          !CODE_TOOLS.has(tool.id) &&
          !HOOKED_TOOLS.has(tool.id) &&
          !whollyDisabled(tool.options?.permission ?? tool.id, rules),
      )
      .map((tool) => [tool.id, tool] as const),
  )

/** What the worker lists for `tools.list()`. */
export const listing = (tools: ReadonlyMap<string, HostTool>): ReadonlyArray<Listing> =>
  [...tools.values()].map((tool) => ({ id: tool.id, description: tool.description }))

type Standard = {
  readonly "~standard": {
    readonly validate: (value: unknown) => unknown
  }
}

const isStandard = (schema: unknown): schema is Standard =>
  typeof schema === "object" && schema !== null && "~standard" in schema

type StandardResult = { readonly value?: unknown; readonly issues?: ReadonlyArray<{ readonly message: string }> }

/** A JSON Schema as a codec, the way the registry builds one; undefined when it cannot. */
const jsonSchemaCodec = (schema: JsonSchema.JsonSchema): Schema.Codec<unknown> | undefined => {
  try {
    const draft =
      (typeof schema.$schema === "string" && schema.$schema.includes("draft-07")) || "definitions" in schema
        ? JsonSchema.fromSchemaDraft07(schema)
        : JsonSchema.fromSchemaDraft2020_12(schema)
    return Schema.make<Schema.Codec<unknown>>(SchemaRepresentation.fromJsonSchemaDocument(draft).ast)
  } catch {
    return undefined
  }
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The input decoded against the tool's schema, as the registry decodes it before `execute`. */
export const decodeInput = async (tool: HostTool, input: unknown): Promise<unknown> => {
  const schema = tool.input
  if (isStandard(schema)) {
    const result = (await schema["~standard"].validate(input)) as StandardResult
    if (result.issues) throw new Error(`Invalid input for ${tool.id}: ${result.issues.map((issue) => issue.message).join("; ")}`)
    return result.value
  }
  const codec = Schema.isSchema(schema) ? (schema as Schema.Codec<unknown>) : jsonSchemaCodec(schema as JsonSchema.JsonSchema)
  if (codec === undefined) return input
  return Schema.decodeUnknownPromise(codec)(input).catch((cause: unknown) => {
    throw new Error(`Invalid input for ${tool.id}: ${message(cause)}`)
  })
}

/** A tool result as code mode gives it: its output, encoded, else its text parts joined, else null. */
export const resultValue = async (tool: HostTool, result: Awaited<ReturnType<HostTool["execute"]>>): Promise<Json> => {
  let value: unknown
  if (result.output !== undefined) {
    value = Schema.isSchema(tool.output) ? await Schema.encodeUnknownPromise(tool.output)(result.output) : result.output
  } else {
    const parts = typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : (result.content ?? [])
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    value = text === "" ? null : text
  }
  // Through JSON, so the cell gets plain data and an undefined field is dropped as it would be on the wire.
  const text = JSON.stringify(value)
  return text === undefined ? null : (JSON.parse(text) as Json)
}

/** Runs tool `id` for a cell; an unknown id names the tools the cell has. */
export const callTool = async (tools: ReadonlyMap<string, HostTool>, id: string, input: unknown, context: HostContext): Promise<Json> => {
  const tool = tools.get(id)
  if (!tool) throw new Error(`${id} is not a tool here. Tools: ${[...tools.keys()].sort().join(", ") || "none"}`)
  const decoded = await decodeInput(tool, input)
  return resultValue(tool, await tool.execute(decoded, context))
}

/** A tool result as a cell gets it: its output through JSON, else its text parts joined, else null. */
const plainResult = (result: Awaited<ReturnType<Runtime["call"]>>): Json => {
  let value: unknown = result.output
  if (value === undefined) {
    const parts = typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : (result.content ?? [])
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    value = text === "" ? null : text
  }
  const text = JSON.stringify(value)
  return text === undefined ? null : (JSON.parse(text) as Json)
}

/** A cell's tools while the kernel is the runtime: every other tool, run by the registry with its hooks. */
export const runtimeTools = (runtime: Runtime) => {
  const tools = runtime.tools.filter((tool) => !CODE_TOOLS.has(tool.name))
  const names = new Set(tools.map((tool) => tool.name))
  return {
    listing: tools.map((tool): Listing => ({ id: tool.name, description: tool.description })),
    call: async (id: string, input: unknown): Promise<Json> => {
      if (!names.has(id)) throw new Error(`${id} is not a tool here. Tools: ${[...names].sort().join(", ") || "none"}`)
      return plainResult(await runtime.call(id, input))
    },
  }
}

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
export const catalog = (tools: ReadonlyArray<RuntimeTool>): string =>
  tools
    .filter((tool) => !CODE_TOOLS.has(tool.name))
    .map((tool) => {
      const path = /^[A-Za-z_$][\w$]*$/.test(tool.name) ? `tools.${tool.name}` : `tools[${JSON.stringify(tool.name)}]`
      return `### ${path}(input: ${typeOf(tool.input)})\n${tool.description.trim()}`
    })
    .join("\n\n")
