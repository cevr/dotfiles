// A call's tools, both bridges: the Toolbox laws over the registry's tools,
// each run by its own `execute`, and over the runtime, which runs them with
// the registry's hooks; then what only the registry's bridge does.
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { toolboxLaws, type LawTool } from "../laws.ts"
import { Toolbox } from "../service.ts"
import { CallFailed } from "../tools.ts"
import * as OpenCodeToolbox from "./toolbox.ts"

const registryTool = (tool: LawTool): OpenCodeToolbox.RegistryTool => ({
  id: tool.id,
  description: tool.description,
  input: Schema.Json,
  execute: (input) =>
    Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
      Effect.flatMap(tool.answer),
      Effect.mapError((message) => new Error(typeof message === "string" ? message : message.message)),
      Effect.map((output) => ({ output })),
    ),
})

toolboxLaws("the registry's tools", (tools) =>
  OpenCodeToolbox.layer({ _tag: "Registry", list: Effect.succeed(tools.map(registryTool)) }),
)

toolboxLaws("the runtime's tools", (tools) =>
  OpenCodeToolbox.layer({
    _tag: "Runtime",
    runtime: {
      tools: tools.map((tool) => ({ name: tool.id, description: tool.description, input: {} })),
      call: (name, input) => {
        const tool = tools.find((item) => item.id === name)
        return tool === undefined
          ? Effect.fail(new Error(`no tool ${name}`))
          : Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
              Effect.flatMap(tool.answer),
              Effect.mapError((message) => new Error(typeof message === "string" ? message : message.message)),
              Effect.map((output) => ({ output })),
            )
      },
    },
  }),
)

describe("the registry's bridge", () => {
  test("decodes a call's input against the tool's schema, and leaves out the tools the rules deny", async () => {
    const strict: OpenCodeToolbox.RegistryTool = {
      id: "count",
      description: "counts",
      input: Schema.Struct({ n: Schema.Number }),
      execute: (input) => Effect.succeed({ content: `got ${JSON.stringify(input)}` }),
    }
    const reached = await Effect.runPromise(
      Toolbox.use((toolbox) => toolbox.reach([{ action: "bash", resource: "*", effect: "deny" }])).pipe(
        Effect.provide(
          OpenCodeToolbox.layer({
            _tag: "Registry",
            list: Effect.succeed([strict, { ...strict, id: "bash", description: "runs" }]),
          }),
        ),
      ),
    )
    expect(reached.listing.map((tool) => tool.id)).toEqual(["count"])
    expect(await Effect.runPromise(reached.call("count", { n: 1 }))).toBe('got {"n":1}')
    const invalid = await Effect.runPromise(Effect.flip(reached.call("count", { n: "one" })))
    expect(invalid).toBeInstanceOf(CallFailed)
    expect(invalid.message).toStartWith("Invalid input for count: ")
  })
})
