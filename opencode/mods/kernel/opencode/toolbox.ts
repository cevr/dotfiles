// The tools of one kernel call, as its cell reaches them. Two bridges.
//
// When the kernel is the agent's runtime (the fork's `options.runtime`), a
// call goes through the runtime: the registry runs it with its
// `execute.before`/`execute.after` hooks, so every tool is reachable,
// `subagent` included.
//
// Otherwise a call decodes the input against the tool's schema, as the
// registry would, and runs the tool's own `execute` with the kernel call's
// context, so the tool asks for permission and stops with the call as it does
// for a direct call. That skips the hooks, so the tools whose policy lives
// there are left out (../tools.ts).
//
// Either way a call resolves to its result's value as code mode gives it: its
// output (encoded by the tool's output schema), else its text, else null; an
// image in it reaches the cell as a marker (../tools.ts, `cellValue`).
import type { Plugin, Tool } from "@opencode/plugin/effect"
import { Cause, Effect, JsonSchema, Layer, Schema, SchemaRepresentation } from "effect"
import type { Json, Listing } from "../frame.ts"
import { silent, type Journal } from "../operations.ts"
import { Toolbox, type CellTools } from "../service.ts"
import { CallFailed, callable, cellValue, messageOf, notATool, reachable, type ContentPart, type Reached, type Registered } from "../tools.ts"

/** A tool result as the host gives it. */
export interface ToolResult {
  readonly output?: unknown
  readonly content?: string | ReadonlyArray<ContentPart>
  readonly metadata?: Record<string, unknown>
}

/** A registered tool, its `execute` bound to the kernel call's context. */
export interface RegistryTool extends Registered {
  readonly description: string
  /** An Effect Schema, a Standard Schema or a JSON Schema. */
  readonly input: unknown
  readonly output?: unknown
  readonly execute: (input: unknown) => Effect.Effect<ToolResult, unknown>
}

/** The agent's other tools, while the kernel is its runtime. */
export interface Runtime {
  readonly tools: ReadonlyArray<Reached>
  readonly call: (name: string, input: unknown) => Effect.Effect<ToolResult, unknown>
}

/** Where a call's tools come from: the runtime, or the registry's list. */
export type Source =
  | { readonly _tag: "Runtime"; readonly runtime: Runtime }
  | { readonly _tag: "Registry"; readonly list: Effect.Effect<ReadonlyArray<RegistryTool>> }

/** Any failure of a tool call, as the words the cell's `await` throws; an interruption stays one. */
const asCallFailed = <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, CallFailed, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(new CallFailed({ message: messageOf(Cause.squash(cause)) })),
    ),
  )

type Standard = { readonly "~standard": { readonly validate: (value: unknown) => unknown } }
type StandardResult = { readonly value?: unknown; readonly issues?: ReadonlyArray<{ readonly message: string }> }

const isStandard = (schema: unknown): schema is Standard => typeof schema === "object" && schema !== null && "~standard" in schema
const isJsonSchema = (schema: unknown): schema is JsonSchema.JsonSchema =>
  typeof schema === "object" && schema !== null && !Array.isArray(schema)

/** A JSON Schema as a codec, the way the registry builds one; none when it cannot. */
const jsonSchemaCodec = (schema: unknown): Effect.Effect<Schema.Codec<unknown> | undefined> =>
  isJsonSchema(schema)
    ? Effect.try({
        try: () => {
          const draft =
            (typeof schema.$schema === "string" && schema.$schema.includes("draft-07")) || "definitions" in schema
              ? JsonSchema.fromSchemaDraft07(schema)
              : JsonSchema.fromSchemaDraft2020_12(schema)
          return Schema.make<Schema.Codec<unknown>>(SchemaRepresentation.fromJsonSchemaDocument(draft).ast)
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    : Effect.succeed(undefined)

const invalid = (tool: RegistryTool, message: string) => new CallFailed({ message: `Invalid input for ${tool.id}: ${message}` })

/** The input decoded against the tool's schema, as the registry decodes it before `execute`. */
export const decodeInput = (tool: RegistryTool, input: unknown): Effect.Effect<unknown, CallFailed> => {
  const schema = tool.input
  if (isStandard(schema))
    return Effect.tryPromise({
      try: async (): Promise<StandardResult> => (await schema["~standard"].validate(input)) as StandardResult,
      catch: (cause) => invalid(tool, messageOf(cause)),
    }).pipe(
      Effect.flatMap((result) =>
        result.issues ? Effect.fail(invalid(tool, result.issues.map((issue) => issue.message).join("; "))) : Effect.succeed(result.value),
      ),
    )
  const codec = Schema.isSchema(schema) ? Effect.succeed(schema as Schema.Codec<unknown>) : jsonSchemaCodec(schema)
  return codec.pipe(
    Effect.flatMap((decoder) =>
      decoder === undefined
        ? Effect.succeed(input)
        : Schema.decodeUnknownEffect(decoder)(input).pipe(Effect.mapError((error) => invalid(tool, error.message))),
    ),
  )
}

/** A registered tool's result as a cell gets it: its output, encoded, else its content (tools.ts, `cellValue`). */
const registryValue = (tool: RegistryTool, result: ToolResult): Effect.Effect<Json, unknown> => {
  if (result.output === undefined) return cellValue(result)
  const encoded = Schema.isSchema(tool.output)
    ? Schema.encodeUnknownEffect(tool.output as Schema.Codec<unknown, unknown>)(result.output)
    : Effect.succeed(result.output)
  return encoded.pipe(Effect.flatMap((output) => cellValue({ output })))
}

/** A cell's tools without the runtime: each registered tool's own `execute`. */
const fromRegistry = (tools: ReadonlyMap<string, RegistryTool>, journal: Journal): CellTools => ({
  listing: [...tools.values()].map((tool): Listing => ({ id: tool.id, description: tool.description })),
  call: (id, input) => {
    const tool = tools.get(id)
    if (tool === undefined) return Effect.fail(new CallFailed({ message: notATool(id, tools.keys()) }))
    return asCallFailed(
      decodeInput(tool, input).pipe(
        Effect.flatMap((decoded) => journal.around(id, decoded, tool.execute(decoded))),
        Effect.flatMap((result) => registryValue(tool, result)),
      ),
    )
  },
})

/** A cell's tools while the kernel is the runtime: every other tool, run by the registry with its hooks. */
const fromRuntime = (runtime: Runtime, journal: Journal): CellTools => {
  const tools = reachable(runtime.tools)
  const names = new Set(tools.map((tool) => tool.name))
  return {
    listing: tools.map((tool): Listing => ({ id: tool.name, description: tool.description })),
    call: (id, input) => {
      if (!names.has(id)) return Effect.fail(new CallFailed({ message: notATool(id, names) }))
      return asCallFailed(
        journal.around(id, input, runtime.call(id, input)).pipe(Effect.flatMap(cellValue)),
      )
    },
  }
}

/** The toolbox over `source`; `journal` records each call a cell makes (../operations.ts). */
export const layer = (source: Source, journal: Journal = silent) =>
  Layer.succeed(
    Toolbox,
    Toolbox.of({
      reach: (rules) =>
        source._tag === "Runtime"
          ? Effect.succeed(fromRuntime(source.runtime, journal))
          : source.list.pipe(Effect.map((all) => fromRegistry(callable(all, rules), journal))),
    }),
  )

/** A registered tool as a cell calls it: its own `execute`, with the kernel call's context. */
const registered = (tool: Tool.Info & { readonly id: string }, context: Tool.Context): RegistryTool => ({
  id: tool.id,
  permission: tool.options?.permission,
  description: tool.description,
  input: tool.input,
  output: tool.output,
  execute: (input) => tool.execute(input, context),
})

/** A kernel call's tools: the runtime's while the kernel is it, else the registry's, each run with the call's context. */
export const forCall = (ctx: Plugin.Context, context: Tool.Context, journal: Journal = silent) => {
  if (context.runtime !== undefined) return layer({ _tag: "Runtime", runtime: context.runtime }, journal)
  // Inner tools must not replace the kernel call's own progress.
  const inner: Tool.Context = { ...context, progress: () => Effect.void }
  return layer({
    _tag: "Registry",
    list: ctx.tool.list().pipe(Effect.map((tools) => tools.map((tool) => registered(tool, inner)))),
  }, journal)
}
