// A session's own subagents over a host in memory: a stop interrupts a running
// subagent once (its own running subagents first) and refuses any session
// that is not the caller's descendant; a wait gives up at its limit; the state
// is read off the host's session.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import { make, type Host, type Outcome, type Session, stateOf } from "./subagents.ts"

/** A session the host holds: as the tool reads it, with its last words and the end its waits await. */
interface Stored {
  session: Session
  words: string
  readonly ended: Deferred.Deferred<void>
}

const NONE = Option.none<number>()

/** A session `id` under `parent` (none for a root), started at `busy` and, when it ended, with its end. */
const stored = (id: string, parent: Option.Option<string>, busy: Option.Option<number>, end: Option.Option<readonly [number, Outcome]>, words: string): Stored => ({
  session: {
    id,
    parentID: parent,
    agent: "worker",
    description: `task ${id}`,
    busy,
    idle: Option.map(end, ([idle]) => idle),
    outcome: Option.map(end, ([, outcome]) => outcome),
  },
  words,
  ended: Deferred.makeUnsafe<void>(),
})

/** A tree: root has children a (running, with a running grandchild g) and b (done); other is another root's child. */
const tree = (): Map<string, Stored> =>
  new Map([
    ["root", stored("root", Option.none(), NONE, Option.none(), "")],
    ["a", stored("a", Option.some("root"), Option.some(10), Option.none(), "")],
    ["g", stored("g", Option.some("a"), Option.some(11), Option.none(), "")],
    ["b", stored("b", Option.some("root"), Option.some(1), Option.some([2, "succeeded"]), "b done")],
    ["elsewhere", stored("elsewhere", Option.none(), NONE, Option.none(), "")],
    ["other", stored("other", Option.some("elsewhere"), Option.some(5), Option.none(), "")],
  ])

/** A host holding `sessions`: an interrupt ends a running one as interrupted; a wait ends when its session does. */
const memory = (sessions: Map<string, Stored>) => {
  const interrupted: Array<string> = []
  const find = (id: string) => Option.fromNullishOr(sessions.get(id))
  /** Ends a running session with `outcome`, as its execution settling does; whether it ran. */
  const end = (id: string, outcome: Outcome) =>
    Option.match(Option.filter(find(id), (held) => stateOf(held.session) === "running"), {
      onNone: () => Effect.succeed(false),
      onSome: (held) =>
        Effect.suspend(() => {
          held.session = { ...held.session, idle: Option.some(Option.getOrElse(held.session.busy, () => 0) + 1), outcome: Option.some(outcome) }
          return Effect.as(Deferred.done(held.ended, Exit.void), true)
        }),
    })
  const host: Host = {
    get: (id) => Effect.sync(() => Option.map(find(id), (held) => held.session)),
    children: (id) => Effect.sync(() => sessions.values().map((held) => held.session).filter((session) => Option.contains(session.parentID, id)).toArray()),
    interrupt: (id) => Effect.andThen(Effect.sync(() => void interrupted.push(id)), end(id, "interrupted")),
    wait: (id) =>
      Option.match(Option.filter(find(id), (held) => stateOf(held.session) === "running"), {
        onNone: () => Effect.void,
        onSome: (held) => Deferred.await(held.ended),
      }),
    lastWords: (id) => Effect.sync(() => Option.match(find(id), { onNone: () => "", onSome: (held) => held.words })),
  }
  return { interrupted, end, subagents: make(host) }
}

/** The refusal an effect fails with: its tag and message. */
const refusal = <A>(effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }>) =>
  Effect.flip(effect).pipe(Effect.map((failure) => [failure._tag, failure.message]))

const session = (fields: Partial<Session>): Session => ({ ...stored("s", Option.none(), NONE, Option.none(), "").session, ...fields })

describe("a subagent's state", () => {
  test("is running while its newest execution has not ended, or before its first; else its last outcome", () => {
    expect(stateOf(session({}))).toBe("running")
    expect(stateOf(session({ busy: Option.some(5) }))).toBe("running")
    expect(stateOf(session({ busy: Option.some(5), idle: Option.some(3), outcome: Option.some("succeeded") }))).toBe("running")
    expect(stateOf(session({ busy: Option.some(1), idle: Option.some(3), outcome: Option.some("succeeded") }))).toBe("done")
    expect(stateOf(session({ busy: Option.some(1), idle: Option.some(3), outcome: Option.some("failed") }))).toBe("failed")
    expect(stateOf(session({ busy: Option.some(1), idle: Option.some(3), outcome: Option.some("interrupted") }))).toBe("stopped")
  })
})

describe("a stop", () => {
  test("interrupts a running subagent, its own running subagents first, and reads it stopped; a second stop interrupts nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const world = memory(tree())
        expect(yield* world.subagents.stop("root", "a")).toMatchObject({ sessionID: "a", state: "stopped", note: "stopped; stopped 1 of its own subagents too" })
        expect(world.interrupted).toEqual(["g", "a"])
        expect(yield* world.subagents.stop("root", "a")).toMatchObject({ state: "stopped", note: "it was not running (stopped); nothing to stop" })
        expect(world.interrupted).toEqual(["g", "a"])
      }),
    ))

  test("of one that already finished changes nothing and keeps its last words", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const world = memory(tree())
        expect(yield* world.subagents.stop("root", "b")).toMatchObject({ state: "done", message: "b done" })
        expect(world.interrupted).toEqual([])
      }),
    ))

  test("reaches a descendant at any depth, and refuses another session's child, the caller's parent, itself, a sibling and an unknown one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const world = memory(tree())
        expect(yield* world.subagents.stop("root", "g")).toMatchObject({ state: "stopped" })
        expect(world.interrupted).toEqual(["g"])
        const pairs: ReadonlyArray<readonly [string, string]> = [
          ["root", "other"],
          ["a", "root"],
          ["root", "root"],
          ["b", "a"],
        ]
        for (const [caller, target] of pairs)
          expect(yield* refusal(world.subagents.stop(caller, target))).toEqual([
            "SubagentRefused",
            `${target} is not a subagent of this session: a session reaches only its own subagents.`,
          ])
        expect(yield* refusal(world.subagents.stop("root", "nope"))).toEqual(["SubagentRefused", "No session nope."])
        expect(world.interrupted).toEqual(["g"])
      }),
    ))
})

describe("a wait", () => {
  test("gives up at its limit on a subagent that still runs, and says so", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const world = memory(tree())
        expect(yield* world.subagents.wait("root", "a", 20)).toMatchObject({ state: "running", note: "still running after 20 ms" })
      }),
    ))

  test("ends when the subagent goes idle, with its final message", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = tree()
        const world = memory(sessions)
        const fiber = yield* Effect.forkChild(world.subagents.wait("root", "a", 60_000))
        // The wait starts on a running subagent, which then ends.
        yield* Effect.yieldNow
        for (const held of Option.toArray(Option.fromNullishOr(sessions.get("a")))) held.words = "a's answer"
        expect(yield* world.end("a", "succeeded")).toBe(true)
        expect(yield* Fiber.join(fiber)).toMatchObject({ state: "done", message: "a's answer", note: "" })
      }),
    ))

  test("and a read refuse a session that is not the caller's", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const world = memory(tree())
        expect((yield* refusal(world.subagents.wait("root", "other", 10)))[0]).toBe("SubagentRefused")
        expect((yield* refusal(world.subagents.get("root", "other")))[0]).toBe("SubagentRefused")
      }),
    ))
})

describe("a list", () => {
  test("names the caller's own children with their state, and no one else's", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const world = memory(tree())
        const listed = yield* world.subagents.list("root")
        expect(listed.subagents.map((view) => [view.sessionID, view.state])).toEqual([
          ["a", "running"],
          ["b", "done"],
        ])
      }),
    ))
})
