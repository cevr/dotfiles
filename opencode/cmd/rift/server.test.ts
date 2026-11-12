// The plugin seam: the composition root on a stand-in host whose tool
// registry holds OpenCode's worktree tools and applies the transform the
// plugin registers, over Rifts and sessions in memory. It checks what OpenCode
// sees: the tools offered, the rift tool's answers and refusals, the options.
// tests/rift.test.ts runs it in OpenCode on the scripted model and real Rift.
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema, type Scope } from "effect"
import * as MemoryDebts from "@dotfiles/opencode-rift/memory/debts"
import * as MemoryLanding from "@dotfiles/opencode-rift/memory/landing"
import * as MemoryNotices from "@dotfiles/opencode-rift/memory/notices"
import * as MemoryRifts from "@dotfiles/opencode-rift/memory/rifts"
import * as MemorySessionDirectories from "@dotfiles/opencode-rift/memory/session-directories"
import * as MemoryWorkbox from "@dotfiles/opencode-rift/memory/workbox"
import Rift, { make, WORKTREE_TOOLS } from "./server.ts"

type Host = Parameters<(typeof Rift)["effect"]>[0]

interface Registered {
  readonly name: string
  readonly options?: { readonly codemode?: boolean }
  /** The input schema the host decodes a call with before `execute`. */
  readonly input: Schema.Decoder<unknown>
  readonly execute: (input: unknown, context: { readonly sessionID: string }) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly text: string }> }, { readonly message: string }>
}
type Editor = { add: (tool: Registered) => void; remove: (id: string) => void }

const SOURCE = "/code/app"

/** The plugin started on a stand-in host whose registry already holds the built-in tools. */
const start = (options: Record<string, unknown> = { workrift: false }, state = MemoryRifts.world([SOURCE]), landing = MemoryLanding.world()) =>
  Effect.gen(function* () {
    const woken: Array<MemoryNotices.Woken> = []
    const tools = new Map<string, Registered | "builtin">([["shell", "builtin"], ["opencode_session_move", "builtin"], ...WORKTREE_TOOLS.map((id) => [id, "builtin"] as const)])
    const host = {
      options,
      tool: {
        transform: (callback: (editor: Editor) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void tools.set(tool.name, tool), remove: (id) => void tools.delete(id) })
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make(() =>
      Layer.mergeAll(
        MemoryRifts.layer(state),
        MemorySessionDirectories.layer({ ses_1: `${SOURCE}/src` }),
        MemoryLanding.layer(landing),
        MemoryNotices.layer(woken),
        MemoryWorkbox.layer(false),
        MemoryDebts.layer(MemoryDebts.world()),
      ),
    ).effect(host)

    /** One call of the rift tool: its text, or `error: <message>`. */
    const call = Effect.fn("RiftServerTest.call")(function* (input: Record<string, unknown>) {
      const tool = tools.get("rift")
      if (tool === undefined || tool === "builtin") return "no rift tool"
      // The input is decoded with the tool's own schema first, as the host does before it calls the tool.
      const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(tool.input)(input))
      if (Exit.isFailure(decoded)) return `refused input: ${String(Cause.squash(decoded.cause))}`
      const exit = yield* Effect.exit(tool.execute(decoded.value, { sessionID: "ses_1" }))
      if (Exit.isSuccess(exit)) return exit.value.content.map((item) => item.text).join("\n")
      const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
      return reason?._tag === "Fail" ? `error: ${reason.error.message}` : "defect"
    })
    return { call, tools, state, woken }
  })

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("the rift plugin", () => {
  test("offers the rift tool as a direct tool in place of OpenCode's worktree tools", () =>
    scenario(
      Effect.gen(function* () {
        const { tools } = yield* start()
        expect([...tools.keys()].sort()).toEqual(["opencode_session_move", "rift", "shell"])
        const rift = tools.get("rift")
        expect(rift !== "builtin" && rift?.options?.codemode).toBe(false)
      }),
    ))

  test("creates, lists and removes a Rift, and refuses to remove one holding unsaved work, in the model's words", () =>
    scenario(
      Effect.gen(function* () {
        const { call, state } = yield* start()
        expect(yield* call({ action: "create", branch: "feat/x" })).toStartWith("Created the Rift /code/.rifts/app/feat-x from /code/app, on branch feat/x.")
        expect(yield* call({ action: "list" })).toBe("Rifts of /code/app:\n- /code/.rifts/app/feat-x · branch feat/x · clean")
        MemoryRifts.change(state, "/code/.rifts/app/feat-x", (workspace) => ({ ...workspace, unpushed: ["d85f04d only here"] }))
        expect(yield* call({ action: "remove", name: "feat-x" })).toStartWith(
          "error: /code/.rifts/app/feat-x holds work found nowhere else:\n1 commit(s) on no remote and in no branch of its source:\n  d85f04d only here",
        )
        expect(yield* call({ action: "remove", name: "feat-x", force: true })).toBe("Moved the Rift /code/.rifts/app/feat-x (branch feat/x) to Rift's trash; it held 1 unpushed.")
        expect(yield* call({ action: "create" })).toStartWith("error: create needs a branch")
      }),
    ))

  test("lands Rifts as one batch, wakes the session with the accept check's result, and says the workbox's commands need the workbox", () =>
    scenario(
      Effect.gen(function* () {
        const state = MemoryRifts.world([SOURCE], [MemoryRifts.clean("/code/.rifts/app/feat-x", "feat/x")])
        const landing = MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept") })
        const { call, woken } = yield* start({ workrift: false }, state, landing)
        expect(yield* call({ action: "land", rifts: ["feat-x"] })).toStartWith("Landed 1 Rift(s) as one push: abc1234 Merge into main to main (merged feat/x; the gate passed in 3s).")
        yield* Effect.sleep("20 millis")
        expect(woken.map((wake) => wake.notice.description)).toEqual(["rift land · accept passed"])
        expect(yield* call({ action: "land", rifts: ["nope"] })).toStartWith("error: The warm source /code/app has no Rift named nope.")
        // An orchestrate run names each Rift with its unit, `{ path, unit }`, as an object or as the JSON a model may send.
        const named = MemoryRifts.clean("/code/.rifts/app/db-2", "p5/db-2")
        state.rifts.set(named.path, named)
        expect(yield* call({ action: "land", rifts: [{ path: "/code/.rifts/app/db-2", unit: "db" }] })).toStartWith("Landed 1 Rift(s) as one push: abc1234 Merge into main to main (merged p5/db-2;")
        yield* Effect.sleep("20 millis")
        state.rifts.set(named.path, named)
        expect(yield* call({ action: "land", rifts: '[{"path": "/code/.rifts/app/db-2", "unit": "db"}]' })).toStartWith("Landed 1 Rift(s) as one push")
        expect(yield* call({ action: "land", rifts: [{ path: "/code/.rifts/app/db-2" }] })).toStartWith("refused input:")
        expect(yield* call({ action: "prune" })).toBe("error: prune runs the workbox's workrift, which this machine does not have. Here the rift tool offers create, list, remove and land.")
      }),
    ))

  test("takes workrift from PATH when the option is absent, and stops on a malformed option", () =>
    scenario(
      Effect.gen(function* () {
        const { tools } = yield* start({ workrift: undefined })
        expect(tools.has("rift")).toBe(true)
        const exit = yield* Effect.exit(start({ workrift: "yes" }))
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("dotfiles-opencode.rift: invalid options")
      }),
    ))
})
