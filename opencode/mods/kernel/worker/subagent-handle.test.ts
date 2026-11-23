// A cell's subagent handle in the real worker process over scripted subagent
// and subagents tools: `tools.subagent` resolves to a live handle, each method
// calls the subagents tool with the handle's sessionID and updates the handle
// in place, a refusal reaches the cell, and after a kernel restart the handle
// keeps its data and `tools.subagent.handle` rebuilds its methods.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Schema } from "effect"
import type { Json } from "../frame.ts"
import { Workers, type Cell } from "../service.ts"
import { KernelSessionId } from "../session.ts"
import { CallFailed } from "../tools.ts"
import * as ProcessWorkers from "./workers.ts"
import { runSubagent } from "./subagent-handle.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "kernel-subagent-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const session = KernelSessionId.make("ses_parent")

/** What a scripted call reads of its input. */
const Asked = Schema.Struct({
  action: Schema.optionalKey(Schema.String),
  sessionID: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
})
const asked = Schema.decodeUnknownSync(Asked)

const view = (state: string, note: string, message: string): Json => ({ sessionID: "ses_c", description: "probe", agent: "worker", state, message, note })

const ask = { agent: "verifier", description: "Check fixture", prompt: "Read fixture." }

test("a kept latch is distinguishable without extending the old state enum", () =>
  Effect.runPromise(Effect.gen(function* () {
    const handle = yield* Effect.promise(() => runSubagent(ask, () =>
      Effect.runPromise(Effect.succeed({ sessionID: "ses_c", status: "latched", latch: { id: "w_fixture", hold: "pace", opensAt: 200, recheckAt: 100 } })),
    ))
    expect(handle.state).toBe("running")
    expect(handle.observation?.phase._tag).toBe("Latched")
    expect(handle.observation?.phase).toMatchObject({ opensAt: 200, recheckAt: 100 })
    expect(handle.observation).not.toHaveProperty("route")
  })),
)

const orders = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
]

for (const order of orders) {
  test(`overlapping legacy reads expose one snapshot, latest issued reply so far (${order.join(",")})`, () =>
    Effect.runPromise(Effect.gen(function* () {
      const replies = yield* Effect.forEach(order, () => Deferred.make<Json>())
      const states = ["failed", "running", "done"]
      const messages = ["old terminal", "new start", "new terminal"]
      const pending = replies.values()
      const handle = yield* Effect.promise(() => runSubagent(ask, (tool) => {
        if (tool === "subagent") return Effect.runPromise(Effect.succeed({ sessionID: "ses_c", status: "running" }))
        const next = pending.next()
        if (next.done) return Effect.runPromise(Effect.fail("unexpected call"))
        return Effect.runPromise(Deferred.await(next.value))
      }))
      const reads = [handle.refresh(), handle.read(), handle.refresh()]
      const arrived: number[] = []
      for (const index of order) {
        yield* Deferred.succeed(replies[index], { subagents: [view(states[index], "", messages[index])] })
        expect(yield* Effect.promise(() => reads[index])).toBe(handle)
        arrived.push(index)
        const latest = Math.max(...arrived)
        expect([handle.state, handle.message]).toEqual([states[latest], messages[latest]])
      }
    })),
  )
}

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
              if (call.action === "get" && !stopped) return Effect.succeed({ subagents: [view("running", "", "")] })
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
          expect(yield* run("(await h.refresh()) === h && [h.state, h.note]")).toBe('[ "running", "" ]')
          // No wait: a finished subagent's report arrives as the session's next message.
          expect(yield* run("typeof h.wait")).toBe("undefined")
          expect(yield* run("await h.stop(); [h.state, h.note, h.message]")).toBe('[ "stopped", "stopped", "half done" ]')
          expect(yield* run("await h.read(); h.state")).toBe("stopped")
          expect(calls).toEqual([
            ["subagent", { agent: "worker", description: "probe", prompt: "go" }],
            ["subagents", { action: "get", sessionID: "ses_c" }],
            ["subagents", { action: "stop", sessionID: "ses_c" }],
            ["subagents", { action: "get", sessionID: "ses_c" }],
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
          expect(yield* run("const again = await tools.subagent.handle(h.sessionID); [again.state, again.message, typeof again.stop, typeof again.refresh]")).toBe(
            '[ "stopped", "half done", "function", "function" ]',
          )
          expect(calls.at(-1)).toEqual(["subagents", { action: "get", sessionID: "ses_c" }])
        }),
      ).pipe(Effect.provide(ProcessWorkers.layer({ timeoutMs: 5_000 }))),
    ))

  // handle-model: a root started verifiers through a cell believing they ran on Opus; the start's answer said the
  // Codex fallback, and the handle dropped it.
  test("carries what the start answered: a fallback start's note and model show in the handle and its printed form; a plain start has neither", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* Workers
          yield* workers.start(session, yield* scratch)
          const NOTE = "orchestrate: this agent runs on openai/gpt-6.1-sol#medium, the Codex fallback (anthropic/claude-opus#medium held: all pool accounts are held)."
          // The subagent tool's answers as the orchestrate plugin widens them: a fallback start names its note and model.
          const tools: Cell["call"] = (name, input) =>
            Effect.sync((): Json => {
              const call = asked(input)
              if (name === "subagents") return { subagents: [view("running", "", "")] }
              if (call.agent === "verifier")
                return { sessionID: "ses_c", status: "running", output: `${NOTE}\nworking`, note: NOTE, model: "openai/gpt-6.1-sol#medium" }
              return { sessionID: "ses_c", status: "running", output: "working" }
            })
          const listing = [
            { id: "subagent", description: "starts a subagent" },
            { id: "subagents", description: "lists and stops subagents" },
          ]
          const run = (source: string) => workers.evaluate(session, { source, tools: listing, call: tools }).pipe(Effect.map((result) => result.display))

          expect(yield* run('const v = await tools.subagent({ agent: "verifier", description: "probe", prompt: "go" }); v.note')).toBe(NOTE)
          expect(yield* run("v.model")).toBe("openai/gpt-6.1-sol#medium")
          const printed = yield* run("v")
          expect(printed).toContain(NOTE)
          expect(printed).toContain('model: "openai/gpt-6.1-sol#medium"')
          // A read updates the handle as before; the model it started on stays.
          expect(yield* run("await v.read(); [v.state, v.note, v.model]")).toBe('[ "running", "", "openai/gpt-6.1-sol#medium" ]')

          expect(yield* run('const p = await tools.subagent({ agent: "worker", description: "probe", prompt: "go" }); Object.keys(p).join()')).toBe(
            "sessionID,description,agent,state,message,note",
          )
          expect(yield* run("p.note")).toBe("")
        }),
      ).pipe(Effect.provide(ProcessWorkers.layer({ timeoutMs: 5_000 }))),
    ))
})
