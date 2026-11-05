// The btw model over the memory host and store, as cmd/btw/tui.tsx builds it
// over OpenCode's: what each one does to the
// host's sessions and to the session's side question, and what it refuses.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { bringBackID } from "@dotfiles/opencode-btw/bring-back"
import { answer, forksLayer, readingsLayer, world, type World } from "@dotfiles/opencode-btw/memory/forks"
import * as MemoryStore from "@dotfiles/opencode-btw/memory/store"
import { Btw, layer } from "@dotfiles/opencode-btw/model"
import { forkNote, MAXIMUM_QUESTION_CHARS } from "@dotfiles/opencode-btw/question"
import { HostFailed } from "@dotfiles/opencode-btw/service"
import { AlreadyBroughtBack, ForkBusy, NoFork, NoReply } from "@dotfiles/opencode-btw/side-question"

const bench = (host: World) =>
  Effect.gen(function* () {
    const shelf = yield* MemoryStore.shelf
    const btw = yield* Btw.pipe(Effect.provide(layer.pipe(Layer.provide(Layer.mergeAll(forksLayer(host), readingsLayer(host), MemoryStore.layer(shelf))))))
    return { btw, shelf, stored: (sessionID: string) => Ref.get(shelf.states).pipe(Effect.map((states) => states.get(sessionID))) }
  })

const run = <A, E>(body: (host: World) => Effect.Effect<A, E>) => Effect.runPromise(body(world({ main: 2 })))

const contents = (host: World, sessionID: string) =>
  (host.sessions.get(sessionID)?.messages ?? []).map((message) => [message.type, message.text, message.description])

describe("ask", () => {
  test("forks the session, names the fork after the question, asks it, and leaves the session untouched", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw, stored } = yield* bench(host)
        const before = contents(host, "main")
        const fork = yield* btw.ask("main", "why is it slow?")
        expect(fork).toEqual({ sessionID: "fork-1", name: "btw: why is it slow?", createdAt: expect.any(Number), broughtBack: [] })
        expect(host.sessions.get("fork-1")?.title).toBe("btw: why is it slow?")
        expect(contents(host, "fork-1")).toEqual([...before, ["synthetic", forkNote("main"), undefined], ["user", "why is it slow?", undefined]])
        expect(contents(host, "main")).toEqual(before)
        expect(yield* stored("main")).toEqual({ fork })
      }),
    ))

  test("with no question and no fork, opens a fork asking nothing", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw } = yield* bench(host)
        const fork = yield* btw.ask("main", "  ")
        expect(fork.name).toBe("btw")
        expect(contents(host, fork.sessionID)).toEqual(contents(host, "main"))
        expect(host.sessions.get(fork.sessionID)?.running).toBe(false)
      }),
    ))

  test("with no question, opens the fork the session opened last; a question forks afresh", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw, stored } = yield* bench(host)
        const first = yield* btw.ask("main", "why?")
        expect(yield* btw.ask("main", "")).toEqual(first)
        expect(host.forks).toBe(1)
        const second = yield* btw.ask("main", "and the tests?")
        expect(second.sessionID).toBe("fork-2")
        expect(yield* stored("main")).toEqual({ fork: second })
      }),
    ))

  test("a question too long is refused before anything forks", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw, stored } = yield* bench(host)
        const failure = yield* Effect.flip(btw.ask("main", "x".repeat(MAXIMUM_QUESTION_CHARS + 1)))
        expect(failure._tag).toBe("QuestionTooLong")
        expect(host.forks).toBe(0)
        expect(yield* stored("main")).toBeUndefined()
      }),
    ))

  test("a fork the host refuses fails HostFailed and keeps the side question as it was", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw, stored } = yield* bench(host)
        host.failing.add("fork")
        expect(yield* Effect.flip(btw.ask("main", "why?"))).toEqual(new HostFailed({ operation: "fork", message: "fork refused" }))
        expect(yield* stored("main")).toBeUndefined()
      }),
    ))
})

describe("followUp", () => {
  test("asks the open fork once it has answered, without the note it already holds", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw } = yield* bench(host)
        const fork = yield* btw.ask("main", "why?")
        expect(yield* Effect.flip(btw.followUp("main", "and?"))).toEqual(new ForkBusy({ sessionID: fork.sessionID }))
        answer(host, fork.sessionID, "Because.")
        yield* btw.followUp("main", "and?")
        expect(contents(host, fork.sessionID).slice(-3)).toEqual([
          ["user", "why?", undefined],
          ["assistant", undefined, undefined],
          ["user", "and?", undefined],
        ])
        expect(contents(host, fork.sessionID).filter(([type]) => type === "synthetic")).toEqual([["synthetic", forkNote("main"), undefined]])
      }),
    ))

  test("the first question to a fork opened asking nothing carries the note", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw } = yield* bench(host)
        const fork = yield* btw.ask("main", "")
        yield* btw.followUp("main", "why?")
        expect(contents(host, fork.sessionID).slice(-2)).toEqual([
          ["synthetic", forkNote("main"), undefined],
          ["user", "why?", undefined],
        ])
      }),
    ))

  test("with no fork is refused", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw } = yield* bench(host)
        expect(yield* Effect.flip(btw.followUp("main", "and?"))).toEqual(new NoFork())
      }),
    ))
})

describe("bringBack", () => {
  test("sends the fork's newest answer into the session once, and a later answer again", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw, stored } = yield* bench(host)
        const fork = yield* btw.ask("main", "why?")
        expect(yield* Effect.flip(btw.bringBack("main"))).toEqual(new ForkBusy({ sessionID: fork.sessionID }))
        answer(host, fork.sessionID, "Because.")
        const before = contents(host, "main").length
        yield* btw.bringBack("main")
        const replyID = (yield* stored("main"))?.fork?.broughtBack[0] ?? ""
        const added = (host.sessions.get("main")?.messages ?? []).slice(before)
        expect(added.map((message) => [message.type, message.id, message.description])).toEqual([["synthetic", bringBackID(replyID), "btw · why?"]])
        expect(String(added[0]?.text)).toContain("Answer:\nBecause.")
        expect(yield* Effect.flip(btw.bringBack("main"))).toEqual(new AlreadyBroughtBack({ sessionID: fork.sessionID, replyID }))

        yield* btw.followUp("main", "and?")
        answer(host, fork.sessionID, "Also this.")
        yield* btw.bringBack("main")
        expect((yield* stored("main"))?.fork?.broughtBack).toHaveLength(2)
      }),
    ))

  test("refused with no fork, and before the fork answers anything", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw } = yield* bench(host)
        expect(yield* Effect.flip(btw.bringBack("main"))).toEqual(new NoFork())
        const fork = yield* btw.ask("main", "")
        expect(yield* Effect.flip(btw.bringBack("main"))).toEqual(new NoReply({ sessionID: fork.sessionID }))
      }),
    ))

  test("a store that refuses the write fails HostFailed after the notice went in", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw, shelf } = yield* bench(host)
        const fork = yield* btw.ask("main", "why?")
        answer(host, fork.sessionID, "Because.")
        yield* Ref.set(shelf.refusing, true)
        expect((yield* Effect.flip(btw.bringBack("main")))._tag).toBe("HostFailed")
        // The host admits one message per id, so a retry after the store recovers adds nothing twice.
        yield* Ref.set(shelf.refusing, false)
        yield* btw.bringBack("main")
        expect(contents(host, "main").filter(([type]) => type === "synthetic")).toHaveLength(1)
      }),
    ))
})

describe("read", () => {
  test("reads the session's open fork, its own turns only; a session with none reads nothing", () =>
    run((host) =>
      Effect.gen(function* () {
        const { btw } = yield* bench(host)
        expect(yield* btw.read("main")).toEqual({ turns: [], replying: false })
        yield* btw.ask("main", "why?")
        expect(yield* btw.read("main")).toEqual({ turns: [{ question: "why?", answer: "" }], replying: true })
        answer(host, "fork-1", "Because.")
        const reading = yield* btw.read("main")
        expect(reading.replying).toBe(false)
        expect(reading.turns.map((turn) => [turn.question, turn.answer])).toEqual([["why?", "Because."]])
        yield* btw.ask("main", "and the tests?")
        expect((yield* btw.read("main")).turns.map((turn) => turn.question)).toEqual(["and the tests?"])
      }),
    ))
})
