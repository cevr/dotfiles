// OpenCode's models over a stand-in for the host's session, agent and model
// lookups: the laws, the subagent tool's order (the agent's own model, else
// the session's, else the default), and a lookup that fails.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { modelsLaws } from "../laws.ts"
import type { ModelRef } from "../pace.ts"
import { Models } from "../service.ts"
import * as OpenCodeModels from "./models.ts"

modelsLaws("OpenCode's Models", (world) =>
  OpenCodeModels.layer({
    session: () => Effect.succeed({ directory: "/work", ...(world.model === undefined ? {} : { model: world.model }) }),
    agentModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.succeed(undefined),
    offered: () =>
      Effect.succeed(world.model === undefined ? [] : [{ ...world.model, variants: world.variants.map((id) => ({ id })) }]),
  }),
)

const own = { providerID: "anthropic", id: "claude-opus" }
const session = { providerID: "openai", id: "gpt-5" }
const fallback = { providerID: "google", id: "gemini" }

const base = (port: Partial<OpenCodeModels.Port>) =>
  Effect.runPromise(
    Models.use((models) => models.base("ses_a", "planner")).pipe(
      Effect.provide(
        OpenCodeModels.layer({
          session: () => Effect.succeed({ directory: "/work", model: session }),
          agentModel: () => Effect.succeed<ModelRef | undefined>(own),
          defaultModel: () => Effect.succeed<ModelRef | undefined>(fallback),
          offered: () => Effect.succeed([]),
          ...port,
        }),
      ),
    ),
  )

test("the agent's own model, else the session's, else the default", async () => {
  expect(await base({})).toEqual(own)
  expect(await base({ agentModel: () => Effect.fail("no agent") })).toEqual(session)
  expect(await base({ agentModel: () => Effect.succeed(undefined), session: () => Effect.succeed({ directory: "/work" }) })).toEqual(
    fallback,
  )
})

test("a session the host cannot read is none", async () => {
  expect(await base({ session: () => Effect.fail("no session") })).toBeUndefined()
})
