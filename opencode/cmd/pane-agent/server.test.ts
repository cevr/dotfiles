// @reads all
// @reads-reason computed read at mods/pane-agent/filestore/store.ts: fs.exists(file)
import { describe, expect } from "bun:test"
import type { Plugin, Tool } from "@opencode/plugin/effect"
import { Array as Arr, Duration, Effect, Layer, Option, Ref } from "effect"
import { READY_FRAME, WORKING_FRAME } from "@dotfiles/opencode-pane-agent/agy.fixture"
import {
  emptyRexState,
  makeMemoryNotifier,
  makeMemoryResults,
  makeMemoryRex,
  makeMemoryStore,
  type MemoryRexState,
} from "@dotfiles/opencode-pane-agent/memory/doubles"
import { formatUnsupportedRevision, RexUnsupportedRevision } from "@dotfiles/opencode-pane-agent/service"
import { PANE_AGENT_TOOL, type PaneAgentInput } from "@dotfiles/opencode-pane-agent/tool"
import { type BindPaneRequest, PANE_AGENT } from "@dotfiles/opencode-pane-agent/worker"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { hangGuard } from "../../tests/hang-guard.ts"
import { make } from "./server.ts"

interface AddedTool {
  readonly name: string
  readonly options?: { readonly codemode?: boolean }
  readonly execute: (
    input: PaneAgentInput,
    context: { readonly sessionID: string },
  ) => Effect.Effect<{ readonly content: ReadonlyArray<Tool.Content> }, Tool.Error>
}

interface RpcHandlers {
  readonly rows: (input: { readonly sessionID: string }) => Effect.Effect<{ readonly workers: ReadonlyArray<unknown> }>
  readonly bindPane: (input: BindPaneRequest) => Effect.Effect<{ readonly ok: boolean }>
}

const FAST_CONFIG = {
  quietFor: Duration.millis(10),
  pollTimeout: Duration.millis(20),
  pasteQuiet: Duration.millis(5),
  maxStartupChecks: 4,
}

const firstText = (content: ReadonlyArray<Tool.Content>): string =>
  Option.match(Arr.head(content), {
    onNone: () => "",
    onSome: (first) => {
      if (first.type === "text") return first.text
      return ""
    },
  })

const startPlugin = (rexInit: Partial<MemoryRexState> = {}) =>
  Effect.gen(function* () {
    const store = yield* makeMemoryStore()
    const rex = yield* makeMemoryRex({ ...emptyRexState, ...rexInit })
    const results = yield* makeMemoryResults()
    const notifier = yield* makeMemoryNotifier()
    const tools = new Map<string, AddedTool>()
    const emitted: Array<{ readonly event: string; readonly sessionID: string }> = []
    let rpcHandlers: Option.Option<RpcHandlers> = Option.none()

    const host: Plugin.Context = Object.assign(Object.create(null), {
      location: { directory: "/nonexistent/repo" },
      options: {},
      tool: {
        transform: (fn: (editor: { add: (tool: AddedTool) => void }) => void) =>
          Effect.sync(() => {
            fn({
              add: (tool) => {
                tools.set(tool.name, tool)
              },
            })
          }),
      },
      rpc: {
        register: (_def: typeof PANE_AGENT, handlers: RpcHandlers) =>
          Effect.sync(() => {
            rpcHandlers = Option.some(handlers)
            return {
              events: {
                emit: (event: string, data: { readonly sessionID: string }) =>
                  Effect.sync(() => {
                    emitted.push({ event, sessionID: data.sessionID })
                  }),
              },
            }
          }),
      },
    })

    const plugin = make(
      () => Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer),
      FAST_CONFIG,
    )
    yield* plugin.effect(host)
    return { store, rex, results, notifier, tools, emitted, rpc: () => Option.getOrThrow(rpcHandlers) }
  })

describe("cmd/pane-agent server plugin", () => {
  effectTest(
    "registers direct pane_agent tool (codemode: false), binds pane via RPC, starts worker, and returns rows via RPC",
    Effect.gen(function* () {
      const env = yield* startPlugin({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const tool = env.tools.get(PANE_AGENT_TOOL)
      expect(tool).toBeDefined()
      expect(tool?.options?.codemode).toBe(false)

      const bound = yield* env.rpc().bindPane({
        sessionID: "ses_root",
        rexSession: "session:1",
        rexBlock: "block:anchor",
      })
      expect(bound.ok).toBe(true)

      const started = yield* tool!.execute(
        {
          action: "start",
          harness: "agy",
          description: "implementor pane-agent r1",
          prompt: "Do the task.",
          resultFile: "/nonexistent/run/out.md",
        },
        { sessionID: "ses_root" },
      )
      const text = firstText(started.content)
      expect(text).toContain("harness: agy")
      expect(text).toContain("state: starting")

      const listed = yield* env.rpc().rows({ sessionID: "ses_root" })
      expect(listed.workers).toHaveLength(1)
      expect(listed.workers[0]).toMatchObject({ harness: "agy", role: "implementor", unit: "pane-agent r1" })

      const idMatch = /^id:\s+(\S+)/m.exec(text)
      const workerId = idMatch?.[1] ?? ""
      expect(workerId.length).toBeGreaterThan(0)

      let workingText = ""
      for (let step = 0; step < 400; step++) {
        const st = yield* tool!.execute({ action: "status", id: workerId }, { sessionID: "ses_root" })
        workingText = firstText(st.content)
        if (workingText.includes("state: working")) break
        yield* Effect.yieldNow
      }
      expect(workingText).toContain("state: working")

      // Steer action routes to Alt+M immediate steer
      yield* tool!.execute(
        { action: "steer", id: workerId, prompt: "Switch focus now." },
        { sessionID: "ses_root" },
      )
      let steeredText = ""
      for (let step = 0; step < 400; step++) {
        const st = yield* tool!.execute({ action: "status", id: workerId }, { sessionID: "ses_root" })
        steeredText = firstText(st.content)
        if (steeredText.includes("steered in Rex pane")) break
        yield* Effect.yieldNow
      }
      expect(steeredText).toContain("steered in Rex pane")

      // Vanished pane -> status reports pane_gone -> restart resumes with --continue
      const blockMatch = /^blockId:\s+(\S+)/m.exec(workingText)
      yield* env.rex.setAlive(blockMatch?.[1] ?? "", false)
      let goneText = ""
      for (let step = 0; step < 400; step++) {
        const st = yield* tool!.execute({ action: "status", id: workerId }, { sessionID: "ses_root" })
        goneText = firstText(st.content)
        if (goneText.includes("state: pane_gone")) break
        yield* Effect.yieldNow
      }
      expect(goneText).toContain("state: pane_gone")

      yield* tool!.execute(
        { action: "restart", id: workerId, prompt: "Resume work." },
        { sessionID: "ses_root" },
      )
      let restartedText = ""
      for (let step = 0; step < 400; step++) {
        const st = yield* tool!.execute({ action: "status", id: workerId }, { sessionID: "ses_root" })
        restartedText = firstText(st.content)
        if (restartedText.includes("restarted in Rex pane (--continue)")) break
        yield* Effect.yieldNow
      }
      expect(restartedText).toContain("restarted in Rex pane (--continue)")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "plugin loads cleanly even when Rex speaks a newer API revision, and start fails with both revisions named",
    Effect.gen(function* () {
      const mismatch = new RexUnsupportedRevision({
        requiredRevision: 18,
        serverRevision: Option.some(19),
        message: formatUnsupportedRevision(18, Option.some(19)),
      })
      const env = yield* startPlugin({ failWith: Option.some(mismatch) })
      const tool = env.tools.get(PANE_AGENT_TOOL)
      expect(tool).toBeDefined()

      yield* env.rpc().bindPane({
        sessionID: "ses_root",
        rexSession: "session:1",
        rexBlock: "block:anchor",
      })
      const started = yield* tool!.execute(
        {
          action: "start",
          harness: "agy",
          description: "worker mismatch",
          prompt: "hello",
          resultFile: "/nonexistent/run/m.md",
        },
        { sessionID: "ses_root" },
      )
      const idMatch = /^id:\s+(\S+)/m.exec(firstText(started.content))
      const workerId = idMatch?.[1] ?? ""
      let failedText = ""
      for (let step = 0; step < 400; step++) {
        const snap = yield* Ref.get(env.store.state)
        const found = snap.workers.find((w) => w.id === workerId)
        if (found?.state === "failed") {
          failedText = found.update
          break
        }
        yield* Effect.yieldNow
      }
      expect(failedText).toContain("18")
      expect(failedText).toContain("19")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )
})
