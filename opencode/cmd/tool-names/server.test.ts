// The plugin seam: the composition root on a stand-in host whose registry
// lists its tools and runs the `execute.before` hooks the plugin registers.
// It checks what OpenCode sees: which calls fail and in which words.
// tests/rift.test.ts runs it in OpenCode on the scripted model.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Result, type Scope } from "effect"
import { statelessToolNameAliases } from "@dotfiles/opencode-anthropic-auth/tool-alias"
import { aliasOf } from "@dotfiles/opencode-tool-names/near-miss"
import ToolNames from "./server.ts"

type Host = Parameters<(typeof ToolNames)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void, { readonly _tag: string; readonly message: string }>

const TOOLS = ["shell", "read", "edit", "rift", "opencode_session_move"]

const start = Effect.gen(function* () {
  const hooks: Array<Hook> = []
  const host = {
    options: {},
    tool: {
      list: () => Effect.succeed(TOOLS.map((id) => ({ id }))),
      hook: (name: string, callback: Hook) =>
        Effect.sync(() => {
          if (name === "execute.before") hooks.push(callback)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Host
  yield* ToolNames.effect(host)
  /** One call through the hooks: the failure's message, or undefined when the call goes on. */
  return Effect.fn(function* (tool: string) {
    const event: Record<string, unknown> = { tool, sessionID: "ses_1", agent: "build", messageID: "msg", id: "call", input: { command: "ls" } }
    for (const hook of hooks) {
      const exit = yield* Effect.exit(hook(event))
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
        return reason?._tag === "Fail" ? `${reason.error._tag}: ${reason.error.message}` : "defect"
      }
    }
    expect(event.tool).toBe(tool)
    return undefined
  })
})

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("the tool-names plugin", () => {
  test("answers a near miss with the real name, and never runs it under that name", () =>
    scenario(
      Effect.gen(function* () {
        const call = yield* start
        expect(yield* call("shll")).toBe('Tool.Error: There is no "shll" tool; did you mean "shell"? Call "shell" with the same input.')
        expect(yield* call("Rift")).toBe('Tool.Error: There is no "Rift" tool; did you mean "rift"? Call "rift" with the same input.')
        expect(yield* call("mcp_TzWRpdA")).toBe(
          'Tool.Error: There is no "mcp_TzWRpdA" tool; did you mean "mcp_TZWRpdA" (edit)? Call "mcp_TZWRpdA" with the same input.',
        )
      }),
    ))

  test("lets a real tool, Code Mode's execute and a far-off name through untouched", () =>
    scenario(
      Effect.gen(function* () {
        const call = yield* start
        expect(yield* call("shell")).toBeUndefined()
        expect(yield* call("execute")).toBeUndefined()
        expect(yield* call("deploy_everything")).toBeUndefined()
      }),
    ))

  test("its alias is the one the Claude login sends a tool under", () => {
    const aliases = statelessToolNameAliases()
    for (const name of TOOLS) expect(aliasOf(name)).toBe(Result.getOrThrow(aliases.encode(name)))
  })
})
