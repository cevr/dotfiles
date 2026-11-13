// A cell's subagent handle in the real worker process over scripted subagent
// and subagents tools: `tools.subagent` resolves to a live handle, each method
// calls the subagents tool with the handle's sessionID and updates the handle
// in place, a refusal reaches the cell, and after a kernel restart the handle
// keeps its data and `tools.subagent.handle` rebuilds its methods.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { Json } from "../frame.ts"
import { Workers, type Cell } from "../service.ts"
import { KernelSessionId } from "../session.ts"
import { CallFailed } from "../tools.ts"
import * as ProcessWorkers from "./workers.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "kernel-subagent-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const session = KernelSessionId.make("ses_parent")

/** What a scripted call reads of its input. */
const Asked = Schema.Struct({
  action: Schema.optionalKey(Schema.String),
  sessionID: Schema.optionalKey(Schema.String),
  ms: Schema.optionalKey(Schema.Number),
  agent: Schema.optionalKey(Schema.String),
})
const asked = Schema.decodeUnknownSync(Asked)

const view = (state: string, note: string, message: string): Json => ({ sessionID: "ses_c", description: "probe", agent: "worker", state, message, note })

describe("a cell's subagent handle", () => {
  test("starts a subagent as a live handle whose methods call the subagents tool with its sessionID; a restart keeps its data and handle() rebuilds it", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* Workers
          yield* workers.start(session, yield* scratch)
          // The tools as the plugin answers them: the subagent tool's background result, the subagents tool's views.
          const calls: Array<readonly [string, Json]> = []
          const tools: Cell["call"] = (name, input) =>
            Effect.suspend((): Effect.Effect<Json, CallFailed> => {
              calls.push([name, input])
              const call = asked(input)
              if (name === "subagent") return Effect.succeed({ sessionID: "ses_c", status: "running", output: "working in the background" })
              if (call.sessionID === "ses_other") return Effect.fail(new CallFailed({ message: "ses_other is not a subagent of this session" }))
              if (call.action === "list") return Effect.succeed({ subagents: [view("running", "", "")] })
              const stopped = calls.some(([, earlier]) => asked(earlier).action === "stop")
              if (call.action === "wait" && !stopped) return Effect.succeed({ subagents: [view("running", `still running after ${call.ms} ms`, "")] })
              if (call.action === "stop") return Effect.succeed({ subagents: [view("stopped", "stopped", "half done")] })
              return Effect.succeed({ subagents: [view("stopped", "", "half done")] })
            })
          const listing = [
            { id: "subagent", description: "starts a subagent" },
            { id: "subagents", description: "lists and stops subagents" },
          ]
          const run = (source: string) => workers.evaluate(session, { source, tools: listing, call: tools }).pipe(Effect.map((result) => result.display))

          // Data only: the methods are not enumerable.
          expect(yield* run('const h = await tools.subagent({ agent: "worker", description: "probe", prompt: "go" }); Object.keys(h).join()')).toBe(
            "sessionID,description,agent,state,message,note",
          )
          expect(yield* run("[h.sessionID, h.description, h.agent, h.state, h.message, h.note]")).toBe('[ "ses_c", "probe", "worker", "running", "", "" ]')
          expect(yield* run("(await h.wait(50)) === h && [h.state, h.note]")).toBe('[ "running", "still running after 50 ms" ]')
          expect(yield* run("await h.stop(); [h.state, h.note, h.message]")).toBe('[ "stopped", "stopped", "half done" ]')
          expect(yield* run("await h.refresh(); await h.read(); await h.wait(); h.state")).toBe("stopped")
          expect(calls).toEqual([
            ["subagent", { agent: "worker", description: "probe", prompt: "go" }],
            ["subagents", { action: "wait", ms: 50, sessionID: "ses_c" }],
            ["subagents", { action: "stop", sessionID: "ses_c" }],
            ["subagents", { action: "get", sessionID: "ses_c" }],
            ["subagents", { action: "get", sessionID: "ses_c" }],
            ["subagents", { action: "wait", ms: 600_000, sessionID: "ses_c" }],
          ])

          // One list call, a live handle for each subagent; a refusal reaches the cell as its message.
          expect(yield* run("const all = await tools.subagent.list(); [all.length, all[0].sessionID, typeof all[0].stop]")).toBe('[ 1, "ses_c", "function" ]')
          expect(calls.at(-1)).toEqual(["subagents", { action: "list" }])
          expect(yield* run('await tools.subagent.handle("ses_other")')).toBe("Error: ses_other is not a subagent of this session")

          // A kernel restart keeps the handle's data; its methods come back through tools.subagent.handle.
          const snapshot = yield* workers.snapshot(session)
          expect(snapshot.omitted).toEqual([])
          yield* workers.start(session, yield* scratch)
          yield* workers.restore(session, snapshot.bindings)
          expect(yield* run("[h.sessionID, h.state, h.message, typeof h.stop]")).toBe('[ "ses_c", "stopped", "half done", "undefined" ]')
          expect(yield* run("const again = await tools.subagent.handle(h.sessionID); [again.state, again.message, typeof again.stop, typeof again.wait]")).toBe(
            '[ "stopped", "half done", "function", "function" ]',
          )
          expect(calls.at(-1)).toEqual(["subagents", { action: "get", sessionID: "ses_c" }])
        }),
      ).pipe(Effect.provide(ProcessWorkers.layer({ timeoutMs: 5_000 }))),
    ))
})
