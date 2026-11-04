// The KernelSession aggregate's stories: a call starts a worker from the
// stored bindings, runs its cell, names what a restart would lose, resets, and
// loses its worker; an idle or deleted session's worker stops.
import { describe, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "../../../lib/story.ts"
import { CellAnswer } from "./answer.ts"
import {
  CellRan,
  KernelLost,
  KernelReset,
  KernelSession,
  KernelSessionId,
  KernelStarted,
  KernelStopped,
  LiveKernel,
  LoseKernel,
  NoKernel,
  RecordCell,
  ResetKernel,
  StartKernel,
  StopKernel,
  type Event,
} from "./session.ts"

const session = KernelSessionId.make("ses_1")
const story = Story.make(KernelSession)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const cell = (fields: Partial<Omit<CellRan, "_tag" | "session">> = {}) =>
  CellRan.make({ session, ok: true, output: "", display: "", unkept: [], stored: true, ...fields })

describe("a call", () => {
  test("starts a worker; with nothing stored it restores nothing and says nothing of it", () =>
    run(
      Story.when(StartKernel.make({ session, stored: 0, restored: [] })),
      Story.then(KernelStarted.make({ session })),
      Story.state(LiveKernel.make({})),
      Story.view(CellAnswer, { notes: [], outcome: { _tag: "Pending" } }),
    ))

  test("starts a worker from the stored bindings, and its answer names those it restored", () =>
    run(
      Story.when(StartKernel.make({ session, stored: 2, restored: ["f", "kept"] })),
      Story.then(KernelStarted.make({ session, restored: ["f", "kept"] })),
      Story.view(CellAnswer, { notes: ["[new kernel; restored f, kept]"], outcome: { _tag: "Pending" } }),
    ))

  test("runs its cell; the bindings the store left out are named by the cell that bound them only", () =>
    run(
      Story.given(KernelStarted.make({ session })),
      Story.when(
        RecordCell.make({
          session,
          ok: true,
          output: "",
          display: "1",
          bindings: ["f", "n"],
          omitted: [
            { name: "f", reason: "function" },
            { name: "old", reason: "live" },
          ],
        }),
      ),
      Story.then(cell({ display: "1", unkept: [{ name: "f", reason: "function" }] })),
      Story.state(LiveKernel.make({})),
    ))

  test("whose worker died after its cell stores nothing, and the next call starts a new one", () =>
    run(
      Story.given(KernelStarted.make({ session })),
      Story.when(RecordCell.make({ session, ok: true, output: "", display: "2", bindings: [] })),
      Story.then(cell({ display: "2", stored: false })),
      Story.state(NoKernel.make({})),
    ))

  test("with reset drops the worker first", () =>
    run(
      Story.given(KernelStarted.make({ session })),
      Story.when(ResetKernel.make({ session })),
      Story.then(KernelReset.make({ session })),
      Story.state(NoKernel.make({})),
    ))

  test("loses its worker when the worker exits, runs past its compute or is aborted", () =>
    run(
      Story.given(KernelStarted.make({ session })),
      Story.when(LoseKernel.make({ session, message: "The kernel worker exited (code 5)" })),
      Story.then(KernelLost.make({ session, message: "The kernel worker exited (code 5)" })),
      Story.state(NoKernel.make({})),
    ))
})

describe("a session's worker", () => {
  test("stops when the session idles or is deleted", () =>
    run(
      Story.given(KernelStarted.make({ session })),
      Story.when(StopKernel.make({ session, reason: "idle" })),
      Story.then(KernelStopped.make({ session, reason: "idle" })),
      Story.state(NoKernel.make({})),
    ))

  test("that is not running records no stop", () =>
    run(
      Story.given<Event>(KernelStarted.make({ session }), KernelLost.make({ session, message: "gone" })),
      Story.when(StopKernel.make({ session, reason: "deleted" })),
      Story.then(),
    ))
})
