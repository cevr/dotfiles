import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Clock, Context, Duration, Effect, FileSystem, Layer, Option, Ref } from "effect"
import { RexSdk, rexLayout, rexSdkLayerFromOptions } from "rex-sdk"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import { waitUntil } from "../../../tests/wait.ts"
import * as FsResults from "../filesystem/results.ts"
import * as FileStore from "../filestore/store.ts"
import { makeMemoryNotifier, type RecordedWake } from "../memory/doubles.ts"
import * as Model from "../model.ts"
import { WorkerStore } from "../service.ts"
import * as RexClientLive from "./client.ts"

const FAKE_AGY_SCRIPT = `
const RULE = "─".repeat(60)
const drawReady = (lastAnswer) => {
  process.stdout.write("\\x1b[2J\\x1b[H")
  if (lastAnswer) {
    process.stdout.write("> previous task\\n" + lastAnswer + "\\n\\n")
  }
  process.stdout.write(RULE + "\\n> \\n" + RULE + "\\n? for shortcuts\\n")
}
const drawWorking = () => {
  process.stdout.write("\\x1b[2J\\x1b[HGenerating...\\n" + RULE + "\\n> \\n" + RULE + "\\nesc to cancel\\n")
}
let buf = ""
let turn = 0
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.setEncoding("utf8")
drawReady("")
process.stdin.on("data", (chunk) => {
  if (chunk === "\\x1b") {
    process.exit(0)
  }
  buf += chunk
  if (chunk.includes("\\r") || chunk.includes("\\n")) {
    const text = buf.replace(/\\x1b\\[200~/g, "").replace(/\\x1b\\[201~/g, "").trim()
    buf = ""
    if (text.length === 0) return
    turn += 1
    drawWorking()
    const match = text.match(/write your final answer to ([^\\s]+?)\\.?\\s*$/m)
    const targetFile = match ? match[1] : ""
    const lines = text.split("\\n").length
    setTimeout(() => {
      const reply = "turn=" + turn + " lines=" + lines
      if (targetFile) {
        Bun.write(targetFile, reply + "\\n")
      }
      drawReady(reply)
    }, 150)
  }
})
`

const checkRexAvailable = Effect.scoped(
  Effect.gen(function* () {
    const built = yield* Layer.build(
      rexSdkLayerFromOptions({
        client: { kind: "agent", name: "pane-agent-probe", version: "0.1.0" },
      }),
    )
    const rex = Context.get(built, RexSdk)
    yield* rex.sessions.list()
    return true
  }),
).pipe(Effect.orElseSucceed(() => false))

const waitForWakes = (ref: Ref.Ref<ReadonlyArray<RecordedWake>>, expected: number) =>
  Effect.promise(() =>
    waitUntil(`at least ${expected} pane-agent wakes`, () => Ref.getUnsafe(ref).length >= expected, 15_000),
  )

describe("live Rex pane-agent lifecycle (simulated CLI in temporary Rex session)", () => {
  effectTest(
    "start right-split, multi-line submit, result file wake, follow-up in same pane, restart reattach without retyping, and stop",
    Effect.gen(function* () {
      const available = yield* checkRexAvailable
      if (!available) {
        yield* Effect.logInfo("Skipping live Rex pane-agent test: no local Rex server answered.")
        return
      }

      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pane-agent-live-" })
      const fakeCli = `${dir}/fake-agy.ts`
      const fakeBin = `${dir}/fake-agy`
      const stateFile = `${dir}/state.json`
      const result1 = `${dir}/result-1.md`
      const result2 = `${dir}/result-2.md`
      const result3 = `${dir}/result-3.md`

      yield* fs.writeFileString(fakeCli, FAKE_AGY_SCRIPT)
      yield* fs.writeFileString(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`)
      yield* fs.chmod(fakeBin, 0o755)

      const sdkBuilt = yield* Layer.build(
        rexSdkLayerFromOptions({
          client: { kind: "agent", name: "pane-agent-live-test", version: "0.1.0" },
        }),
      )
      const rawRex = Context.get(sdkBuilt, RexSdk)
      const nowMs = yield* Clock.currentTimeMillis

      const tempSession = yield* Effect.acquireRelease(
        rawRex.sessions.create({
          label: `pane-agent-live-${nowMs}`,
          initialWindows: [
            {
              windowLabel: "main",
              layout: rexLayout.terminal({
                shell: "none",
                command: ["/bin/sh", "-c", "exec cat"],
                cwd: dir,
                label: "anchor",
              }),
            },
          ],
        }),
        (created) => rawRex.sessions.destroy({ sessionId: created.sessionId }).pipe(Effect.ignore),
      )

      const anchorBlockOpt = Option.flatMap(Arr.head(tempSession.initialWindows), (win) => Arr.head(win.blockIds))
      if (Option.isNone(anchorBlockOpt)) {
        return yield* Effect.die("temp Rex session returned no anchor block")
      }
      const anchorBlockId = String(anchorBlockOpt.value)
      const rexSessionId = String(tempSession.sessionId)
      const notifier = yield* makeMemoryNotifier()

      const modelConfig: Model.ModelConfig = {
        quietFor: Duration.millis(250),
        pollTimeout: Duration.seconds(2),
        pasteQuiet: Duration.millis(120),
        maxStartupChecks: 30,
        binaryOverrides: { agy: fakeBin },
      }

      const liveDeps = Layer.mergeAll(
        RexClientLive.layer(),
        FileStore.layer(stateFile),
        FsResults.layer,
        notifier.layer,
      )
      const modelLayer = Layer.merge(
        Model.layer(modelConfig).pipe(Layer.provide(liveDeps)),
        FileStore.layer(stateFile),
      )

      let workerId = ""
      let workerBlockId = ""

      // Phase 1: start, result-1 wake, follow-up in same pane, result-2 wake, seed restart turn 3.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const built = yield* Layer.build(modelLayer)
          const model = Context.get(built, Model.PaneAgentModel)
          const store = Context.get(built, WorkerStore)

          yield* model.bindPane("ses_live", { session: rexSessionId, block: anchorBlockId })
          const started = yield* model.start({
            parentSessionID: "ses_live",
            directory: dir,
            harness: "agy",
            description: "implementor live-sim r1",
            prompt: "Line one of task.\nLine two of task.",
            resultFile: result1,
            cwd: dir,
          })
          workerId = started.id
          workerBlockId = started.blockId
          expect(started.ownedBlock).toBe(true)

          yield* waitForWakes(notifier.wakes, 1)
          const wakes1 = yield* Ref.get(notifier.wakes)
          expect(wakes1[0]?.letter.text).toContain("turn=1")

          const followed = yield* model.followUp({
            parentSessionID: "ses_live",
            id: workerId,
            prompt: "Follow-up line 1.\nFollow-up line 2.",
            resultFile: result2,
          })
          expect(followed.blockId).toBe(workerBlockId)
          expect(followed.turn).toBe(2)

          yield* waitForWakes(notifier.wakes, 2)
          const wakes2 = yield* Ref.get(notifier.wakes)
          expect(wakes2[1]?.letter.text).toContain("turn=2")

          const current = yield* store.read()
          const found = Option.fromUndefinedOr(current.workers.find((w) => w.id === workerId))
          expect(Option.isSome(found)).toBe(true)
          if (Option.isSome(found)) {
            const stamp = yield* Clock.currentTimeMillis
            yield* store.upsertWorker({
              ...found.value,
              state: "working",
              turn: 3,
              notifiedTurn: 2,
              resultFile: result3,
              startedAt: stamp - 500,
              updatedAt: stamp - 500,
            })
          }
        }),
      )

      // Turn 3 finishes while server is down.
      yield* fs.writeFileString(result3, "completed-during-restart\n")

      // Phase 2: fresh server instance reattaches, wakes once without retyping, then stops & closes pane.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const built = yield* Layer.build(modelLayer)
          const model = Context.get(built, Model.PaneAgentModel)
          const reattached = yield* model.reattach(dir)
          expect(reattached).toHaveLength(1)
          expect(reattached[0]?.state).toBe("done")

          const wakes3 = yield* Ref.get(notifier.wakes)
          expect(wakes3).toHaveLength(3)
          expect(wakes3[2]?.letter.text).toContain("completed-during-restart")

          const stopped = yield* model.stop({ parentSessionID: "ses_live", id: workerId, close: true })
          expect(stopped.state).toBe("stopped")
        }),
      )

      expect(workerId.length).toBeGreaterThan(0)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    hangGuard("process-fixture"),
  )
})
