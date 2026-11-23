// The controller between /btw, the pane and the btw model, over the memory
// host and store: a question stays pending until the fork's reading after it
// lands; the pane's reading follows the fork's events while it is watched and
// only then; one reading runs at a time; every refusal and failure reaches
// the reader as one line; a follow-up with no fork opens one.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { manualTuiClock } from "../../../tests/manual-tui-clock.ts"
import { waitUntil } from "../../../tests/wait.ts"
import { answer, forksLayer, readingsLayer, world, type World } from "../memory/forks.ts"
import * as MemoryStore from "../memory/store.ts"
import { Btw, layer } from "../model.ts"
import { HostFailed } from "../service.ts"
import { INITIAL, NoFork } from "../side-question.ts"
import { controller, failureText, SETTLE_MS } from "./controller.tsx"

/**
 * A controller over the World. Each reading waits for `release` while
 * `holding` is set; `reads` counts the readings taken; `emit` is a host event
 * about a session.
 */
const bench = (host: World) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const shelf = yield* MemoryStore.shelf
      const btw = yield* Btw.pipe(Effect.provide(layer.pipe(Layer.provide(Layer.mergeAll(forksLayer(host), readingsLayer(host), MemoryStore.layer(shelf))))))
      const notices: Array<string> = []
      const listeners = new Set<(sessionID: string) => void>()
      const gate = { holding: false, reads: 0, release: () => {} }
      const held = Effect.promise(() => {
        gate.reads += 1
        if (gate.holding) return new Promise<void>((resolve) => (gate.release = resolve))
        return Promise.resolve()
      })
      const control = controller({
        btw: {
          ...btw,
          read: (sessionID) => held.pipe(Effect.andThen(btw.read(sessionID))),
        },
        state: (sessionID) => Effect.runSync(Ref.get(shelf.states)).get(sessionID) ?? INITIAL,
        listen: (handler) => {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
        notify: (message) => notices.push(message),
      })
      const emit = (sessionID: string) => listeners.forEach((listener) => listener(sessionID))
      return { control, notices, gate, emit, listeners }
    }),
  )

/** Hang guard while waiting for the fixture's read/refresh events. */
const HANG_GUARD_MS = 30_000

describe("ask", () => {
  test("holds the question as pending until the fork's reading lands, which shows it unanswered", async () => {
    const host = world({ main: 1 })
    const { control, gate, notices } = await bench(host)
    gate.holding = true
    const asking = control.ask("main", " why? ")
    expect(control.pending("main")).toBe("why?")
    await waitUntil("the first read waiting at its gate", () => gate.reads >= 1)
    expect(gate.reads).toBe(1)
    expect(control.pending("main")).toBe("why?")
    expect(control.reading("main").turns).toEqual([])
    gate.release()
    await asking
    expect(control.pending("main")).toBeUndefined()
    expect(control.fork("main")?.name).toBe("btw: why?")
    expect(control.reading("main")).toEqual({ turns: [{ question: "why?", answer: "" }], replying: true })
    expect(notices).toEqual([])
  }, HANG_GUARD_MS)

  test("a failure is told on one line and the question is no longer pending", async () => {
    const host = world({ main: 1 })
    host.failing.add("fork")
    const { control, notices } = await bench(host)
    await control.ask("main", "why?")
    expect(notices).toEqual(["btw: could not fork: fork refused"])
    expect(control.pending("main")).toBeUndefined()
    expect(control.fork("main")).toBeUndefined()
  })

  test("a new fork reads nothing until its own reading lands, never the last fork's turns", async () => {
    const host = world({ main: 1 })
    const { control, gate } = await bench(host)
    await control.ask("main", "why?")
    gate.holding = true
    const asking = control.ask("main", "and the tests?")
    await waitUntil("the new fork's read waiting at its gate", () => gate.reads >= 2)
    expect(control.fork("main")?.sessionID).toBe("fork-2")
    expect(control.reading("main").turns).toEqual([])
    gate.release()
    await asking
    expect(control.reading("main").turns.map((turn) => turn.question)).toEqual(["and the tests?"])
  }, HANG_GUARD_MS)
})

describe("the reading", () => {
  test("while watched, follows the fork's events a moment after them, once for a burst", async () => {
    using clock = manualTuiClock()
    const host = world({ main: 1 })
    const { control, gate, emit } = await bench(host)
    await control.ask("main", "why?")
    const stop = control.watch("main")
    answer(host, "fork-1", "Because.")
    const before = gate.reads
    emit("fork-1")
    emit("fork-1")
    emit("fork-1")
    expect(control.reading("main").replying).toBe(true)
    clock.advance(SETTLE_MS - 1)
    expect(gate.reads).toBe(before)
    clock.advance(1)
    await waitUntil("the watch read the answer from the fork", () => !control.reading("main").replying)
    expect(gate.reads).toBe(before + 1)
    expect(control.reading("main").turns.map((turn) => [turn.question, turn.answer])).toEqual([["why?", "Because."]])
    expect(control.reading("main").replying).toBe(false)
    stop()
  }, HANG_GUARD_MS)

  test("unwatched, or about another session, an event reads nothing", async () => {
    using clock = manualTuiClock()
    const host = world({ main: 1 })
    const { control, gate, emit } = await bench(host)
    await control.ask("main", "why?")
    const before = gate.reads
    emit("fork-1")
    const stop = control.watch("main")
    emit("main")
    emit("elsewhere")
    stop()
    emit("fork-1")
    clock.advance(SETTLE_MS)
    expect(gate.reads).toBe(before)
  })

  test("one reading runs at a time; refreshes asked during it share one more after it", async () => {
    const host = world({ main: 1 })
    const { control, gate } = await bench(host)
    await control.ask("main", "why?")
    const before = gate.reads
    gate.holding = true
    const first = control.refresh("main")
    const second = control.refresh("main")
    const third = control.refresh("main")
    await waitUntil("the first refresh waiting at its gate", () => gate.reads >= before + 1)
    expect(gate.reads).toBe(before + 1)
    gate.release()
    await first
    await waitUntil("the shared follow-up refresh waiting at its gate", () => gate.reads >= before + 2)
    expect(gate.reads).toBe(before + 2)
    gate.release()
    await Promise.all([second, third])
    expect(gate.reads).toBe(before + 2)
  }, HANG_GUARD_MS)

  test("dispose stops listening to the host", async () => {
    const { control, listeners } = await bench(world({ main: 1 }))
    expect(listeners.size).toBe(1)
    control.dispose()
    expect(listeners.size).toBe(0)
  })
})

describe("followUp", () => {
  test("with no fork, opens one with the question", async () => {
    const host = world({ main: 1 })
    const { control } = await bench(host)
    expect(await control.followUp("main", "why?")).toBe(true)
    expect(control.fork("main")?.name).toBe("btw: why?")
  })

  test("refused while the fork answers: told, and the line is kept", async () => {
    const host = world({ main: 1 })
    const { control, notices } = await bench(host)
    await control.ask("main", "why?")
    expect(await control.followUp("main", "and?")).toBe(false)
    expect(notices).toEqual(["btw: the fork is still answering; try again when it is done"])
    expect(control.pending("main")).toBeUndefined()
  })

  test("once answered, goes to the fork and reads it back", async () => {
    const host = world({ main: 1 })
    const { control } = await bench(host)
    await control.ask("main", "why?")
    answer(host, "fork-1", "Because.")
    expect(await control.followUp("main", "and?")).toBe(true)
    expect(control.reading("main").turns.map((turn) => [turn.question, turn.answer])).toEqual([
      ["why?", "Because."],
      ["and?", ""],
    ])
  })
})

test("bringBack is true once the answer is in the session, and told when refused", async () => {
  const host = world({ main: 1 })
  const { control, notices } = await bench(host)
  await control.ask("main", "why?")
  answer(host, "fork-1", "Because.")
  expect(await control.bringBack("main")).toBe(true)
  expect(await control.bringBack("main")).toBe(false)
  expect(notices).toEqual(["btw: this answer is already brought back"])
})

test("failureText says what the host refused, or explains the rejection", () => {
  expect(failureText(new HostFailed({ operation: "fork", message: "ForkEmptyError" }))).toBe("btw: could not fork: ForkEmptyError")
  expect(failureText(new NoFork())).toBe("btw: no side question here yet; ask one with /btw <question>")
})
