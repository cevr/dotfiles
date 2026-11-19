// The queued switch's two ways in and its tray line, on the simulated TUI
// (sim-tui/), each test at its first SEEDS seeds: the fork's real TUI in this
// process with Prime and the model-next plugin loaded by path, in front of the
// server double, on a virtual clock. The model-next server plugin is a stand-in
// on the double (`rpc`): it answers `queue` and `cancel` as the server does for
// a known model, and records each call. The double's catalog holds one model,
// the session's own, so the stand-in answers whatever the rule would say for
// another one: the TUI's half is what runs here.
import { Effect, Option, Schema } from "effect"
import { Cancelled, KEY, MODEL_NEXT, ModelRef, Queued } from "@dotfiles/opencode-model-next/pending"
import * as App from "../../sim-tui/app.ts"
import { MODEL_REF, type Model, type Rpc, text } from "../../sim-tui/server.ts"

const FILE = "cmd/model-next/model-next-tui.sim.test.tsx"
/** Seeds this file runs: each seed boots a session and opens one dialog. */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/model-next"], width: 110, height: 30 }

App.bootTest(BOOT)

const model: Model = () => [text("Done.")]
const NEXT = { providerID: "anthropic", id: "claude-fable-5-2" }

const readQueue = Schema.decodeUnknownOption(Schema.Struct({ model: ModelRef }))

type Call = { readonly method: string; readonly input: unknown }
/** The RPC's stand-in: `queue` answers Queued from the session's model, `cancel` Cancelled; every call is kept. */
const standIn = (calls: Array<Call>): Rpc => (call) => {
  if (call.rpcID !== MODEL_NEXT.id) return Option.none()
  calls.push({ method: call.method, input: call.input })
  if (call.method === "cancel") return Option.some(Cancelled.make({ had: true }))
  if (call.method !== "queue") return Option.none()
  return Option.map(readQueue(call.input), (input) => Queued.make({ model: input.model, from: MODEL_REF }))
}

const has = (needle: string) => (shown: ReadonlyArray<string>) => shown.some((line) => line.includes(needle))

seeded("a queued switch shows on the tray beside the model: old → new queued", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = yield* App.seed(
      BOOT,
      { key: "model-next-tray", seed, model, metadata: (sessionID) => ({ [KEY]: { sessionID, model: NEXT, from: MODEL_REF, queuedAt: 0 } }) },
      (tui) =>
        Effect.gen(function* () {
          yield* tui.until("the tray line", has("queued"))
          return tui.text()
        }),
    )
    const tray = shown.find((line) => line.includes("queued")) ?? ""
    expect(tray).toContain(`${MODEL_REF.id} → ${NEXT.id} queued`)
  }),
)

seeded("a value queued for another session (a parent's, copied) shows nothing", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = yield* App.seed(
      BOOT,
      { key: "model-next-other", seed, model, metadata: () => ({ [KEY]: { sessionID: "ses_parent", model: NEXT, from: MODEL_REF, queuedAt: 0 } }) },
      (tui) =>
        Effect.gen(function* () {
          yield* tui.until("the tray's model", has(MODEL_REF.id))
          yield* tui.advance(500)
          return tui.text()
        }),
    )
    expect(has("queued")(shown)).toBe(false)
  }),
)

seeded("/model-next queues the model picked, through the queue RPC", ({ seed, expect }) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    const seen = yield* App.seed(BOOT, { key: "model-next-command", seed, model, rpc: standIn(calls) }, (tui) =>
      Effect.gen(function* () {
        yield* tui.until("the composer", has(MODEL_REF.id))
        yield* tui.type("/model-next")
        yield* tui.advance(300)
        yield* tui.press({ name: "enter" })
        yield* tui.until("the dialog", has("Switch the model at the next compaction"))
        const dialog = tui.text()
        yield* tui.press({ name: "enter" })
        yield* tui.until("the toast", has("queued:"))
        return { dialog, after: tui.text() }
      }),
    )
    expect(has("Simulated Model")(seen.dialog)).toBe(true)
    expect(has("compact now")(seen.dialog)).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(["queue"])
    expect(calls[0]?.input).toMatchObject({ model: { providerID: MODEL_REF.providerID, id: MODEL_REF.id } })
  }),
)

seeded("with a switch queued, /model-next's first option cancels it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    const seen = yield* App.seed(
      BOOT,
      { key: "model-next-cancel", seed, model, rpc: standIn(calls), metadata: (sessionID) => ({ [KEY]: { sessionID, model: NEXT, from: MODEL_REF, queuedAt: 0 } }) },
      (tui) =>
        Effect.gen(function* () {
          yield* tui.until("the tray line", has("queued"))
          yield* tui.type("/model-next")
          yield* tui.advance(300)
          yield* tui.press({ name: "enter" })
          yield* tui.until("the dialog", has("Cancel the queued switch"))
          yield* tui.press({ name: "enter" })
          yield* tui.until("the toast", has("cancelled"))
          return tui.text()
        }),
    )
    expect(has("The queued switch is cancelled")(seen)).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(["cancel"])
  }),
)

seeded("the host's model picker offers `at next compaction`, and its key queues the highlighted model", ({ seed, expect }) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    yield* App.seed(BOOT, { key: "model-next-picker", seed, model, rpc: standIn(calls) }, (tui) =>
      Effect.gen(function* () {
        yield* tui.until("the composer", has(MODEL_REF.id))
        yield* tui.press({ name: "x", ctrl: true })
        yield* tui.press({ name: "m" })
        yield* tui.until("the picker's action", has("at next compaction"))
        yield* tui.press({ name: "g", ctrl: true })
        yield* tui.until("the toast", has("queued:"))
        return tui.text()
      }),
    )
    expect(calls.map((call) => call.method)).toEqual(["queue"])
    expect(calls[0]?.input).toMatchObject({ model: { providerID: MODEL_REF.providerID, id: MODEL_REF.id } })
  }),
)

App.closeTest()
