// The family read through a Solid store, as OpenCode's TUI holds the session
// data: a token streamed into one message re-reads that message alone, never
// the rest of a long family. Bun's tests resolve solid-js to its server build,
// which never re-runs a computation, so this file takes the reactive build
// OpenCode loads.
import { expect, mock, test } from "bun:test"
import type { Session } from "../family.ts"
import { message, read, type Reads } from "../opencode/view.ts"

// The builds' files carry no types of their own; the imports below take solid-js's.
const REACTIVE = { core: "solid-js/dist/solid.js", store: "solid-js/store/dist/store.js" }
mock.module("solid-js", () => import(REACTIVE.core))
mock.module("solid-js/store", () => import(REACTIVE.store))
const { createMemo, createRoot } = await import("solid-js")
const { createStore, produce } = await import("solid-js/store")
const { familyReader, perItem, sameSession } = await import("./reader.ts")

type Item = { type: string; id: string; content: Array<{ type: string; text: string }> }

/** A root with `steps` finished steps and a streaming one, and one child, in a Solid store. */
function world(steps: number) {
  const step = (id: string, text: string): Item => ({ type: "assistant", id, content: [{ type: "text", text }] })
  const [store, setStore] = createStore<{ messages: Record<string, Item[]> }>({
    messages: {
      root: [...Array.from({ length: steps }, (_, i) => step(`m${i}`, `step ${i}`)), step("live", "Work")],
      child: [step("c0", "Child")],
    },
  })
  const reads: Reads<string> = {
    session: {
      get: (id) => ({ id, parentID: id === "root" ? null : "root", time: { created: 0 } }),
      root: () => "root",
      family: () => ["root", "child"],
      status: () => "running",
      permission: { list: () => [] },
      form: { list: () => [] },
      message: { list: (id) => store.messages[id] ?? [] },
    },
    shell: { list: () => [] },
  }
  const stream = (session: string, at: number, more: string) =>
    setStore(produce((draft) => void (draft.messages[session]![at]!.content[0]!.text += more)))
  const append = (session: string, item: Item) => setStore(produce((draft) => void draft.messages[session]!.push(item)))
  return { reads, stream, append }
}

/** Each session's newest words, as a computation over the family sees them. */
const newest = (family: ReturnType<typeof read>) =>
  family.sessions.map((session) =>
    session.messages.flatMap((step) => (step.type === "assistant" ? step.parts.map((part) => (part.type === "words" ? part.text : "")) : [])).at(-1),
  )

/** A computation over the family read through `perItem`, and the items it converted since the last look. */
function watch(reads: Reads<string>) {
  const converted: string[] = []
  const convert = perItem((item) => {
    converted.push(String(Reflect.get(Object(item), "id")))
    return message(item)
  })
  const view = createRoot(() => createMemo(() => newest(read(reads, "root", undefined, convert))))
  return () => {
    const seen = { view: view(), converted: [...converted] }
    converted.length = 0
    return seen
  }
}

test("a family read converts every message once", () => {
  const look = watch(world(300).reads)
  const first = look()
  expect(first.view).toEqual(["Work", "Child"])
  expect(first.converted).toHaveLength(302)
})

test("a token streamed into one message re-reads that message alone", () => {
  const family = world(300)
  const look = watch(family.reads)
  look()
  family.stream("root", 300, " on it")
  expect(look()).toEqual({ view: ["Work on it", "Child"], converted: ["live"] })
  family.stream("child", 0, " works")
  expect(look()).toEqual({ view: ["Work on it", "Child works"], converted: ["c0"] })
})

test("a new message is read once, and the messages before it are not read again", () => {
  const family = world(300)
  const look = watch(family.reads)
  look()
  family.append("child", { type: "assistant", id: "c1", content: [{ type: "text", text: "Next" }] })
  expect(look()).toEqual({ view: ["Work", "Next"], converted: ["c1"] })
})

test("a family reader reads what `read` reads, and keeps up with the store", () => {
  const family = world(3)
  const reader = familyReader()
  const view = createRoot(() => createMemo(() => newest(reader(family.reads, "child"))))
  expect(view()).toEqual(newest(read(family.reads, "child")))
  family.stream("root", 3, " on it")
  expect(view()).toEqual(["Work on it", "Child"])
})

/** A root with `children` children of `steps` steps each, in a Solid store, counting each session's reads of its messages and info. */
function brood(children: number, steps: number) {
  const step = (id: string, text: string): Item => ({ type: "assistant", id, content: [{ type: "text", text }] })
  const ids = Array.from({ length: children }, (_, i) => `child${i}`)
  const [store, setStore] = createStore<{ messages: Record<string, Item[]> }>({
    messages: Object.fromEntries([
      ["root", [step("r0", "Root")]],
      ...ids.map((id) => [id, Array.from({ length: steps }, (_, i) => step(`${id}-${i}`, `${id} step ${i}`))] as const),
    ]),
  })
  const counted: string[] = []
  const reads: Reads<string> = {
    session: {
      get: (id) => (counted.push(`get ${id}`), { id, parentID: id === "root" ? null : "root", time: { created: 0 } }),
      root: () => "root",
      family: () => ["root", ...ids],
      status: () => "running",
      permission: { list: () => [] },
      form: { list: () => [] },
      message: { list: (id) => (counted.push(`list ${id}`), store.messages[id] ?? []) },
    },
    shell: { list: () => [] },
  }
  const stream = (session: string, at: number, more: string) =>
    setStore(produce((draft) => void (draft.messages[session]![at]!.content[0]!.text += more)))
  /** The reads since the last look. */
  const reads_ = () => counted.splice(0)
  return { reads, stream, counted: reads_ }
}

test("a token in one child re-reads that child alone, once for all the views that read the family", () => {
  const family = brood(20, 50)
  const reader = familyReader()
  const seen: Array<ReturnType<typeof read>> = []
  // Three views, as the dock's count, the rows and the queue's sidebar each read the family.
  const views = createRoot(() =>
    [0, 1, 2].map(() =>
      createMemo(() => {
        const read = reader(family.reads, "child3")
        seen.push(read)
        return newest(read)
      }),
    ),
  )
  views.forEach((view) => view())
  family.counted()
  const before = seen.at(-1)!
  family.stream("child7", 49, " more")
  expect(views.map((view) => view()[8])).toEqual(["child7 step 49 more", "child7 step 49 more", "child7 step 49 more"])
  expect(family.counted().toSorted()).toEqual(["get child7", "list child7"])
  const after = seen.at(-1)!
  // The three views read one family object, which keeps every other session as it was.
  expect(seen.slice(-3).every((read) => read === after)).toBe(true)
  after.sessions.forEach((session, index) => {
    if (session.id === "child7") expect(session).not.toBe(before.sessions[index])
    else expect(session).toBe(before.sessions[index]!)
  })
})

test("a family no view reads any more stops reading the store", async () => {
  const family = brood(3, 2)
  const reader = familyReader()
  let dispose = () => {}
  const view = createRoot((end) => {
    dispose = end
    return createMemo(() => newest(reader(family.reads, "root")))
  })
  view()
  dispose()
  await Promise.resolve()
  family.counted()
  family.stream("child1", 1, " more")
  expect(family.counted()).toEqual([])
})

test("the rows of a family are worked out once, however many views read them", async () => {
  const { subagents } = await import("../subagent-row.ts")
  const family = brood(4, 2)
  const reader = familyReader()
  const rows = createRoot(() => [0, 1].map(() => createMemo(() => subagents(reader(family.reads, "root"), "root"))))
  expect(rows[0]!()).toBe(rows[1]!())
  const before = rows[0]!()
  family.stream("child2", 1, " more")
  expect(rows[0]!()).toBe(rows[1]!())
  expect(rows[0]!()).not.toBe(before)
  expect(rows[0]!().map((row) => row.update)).toEqual(["child0 step 1", "child1 step 1", "child2 step 1 more", "child3 step 1"])
})

test("two readings of a session are the same while every field it carries is, and its messages are the same array", () => {
  const messages: Session["messages"] = []
  const base: Session = { id: "a", parentID: "root", time: { created: 1 }, running: true, shells: [{ id: "sh1", command: "bun test" }], permissions: [], questions: [], messages }
  expect(sameSession(base, { ...base, time: { created: 1 }, shells: [{ id: "sh1", command: "bun test" }], permissions: [] })).toBe(true)
  const changed: ReadonlyArray<Session> = [
    { ...base, title: "Fix it" },
    { ...base, agent: "general" },
    { ...base, model: "claude-opus-5-5" },
    { ...base, outcome: "failed" },
    { ...base, running: false },
    { ...base, time: { created: 1, busy: 2 } },
    { ...base, time: { created: 1, updated: 3 } },
    { ...base, latch: { hold: "pace", reason: "too many", opensAt: 5, at: 4 } },
    { ...base, shells: [{ id: "sh1", command: "bun test", description: "the suite" }] },
    { ...base, shells: [] },
    { ...base, permissions: ["edit a.ts"] },
    { ...base, questions: ["Which?"] },
    { ...base, messages: [] },
  ]
  expect(changed.filter((session) => sameSession(base, session))).toEqual([])
})

test("a session update that changes nothing the family carries keeps the family, and nothing that reads it runs", () => {
  // The root's parent is "": no parent, as `sessionOf` reads it.
  type Info = { id: string; parentID: string; title: string; time: { created: number }; cost: number }
  const info = (id: string, title: string, cost = 0): Info => ({ id, parentID: "root", title, time: { created: 0 }, cost })
  const [store, setStore] = createStore<{ sessions: Record<string, Info> }>({
    sessions: { root: { ...info("root", "Root"), parentID: "" }, child: info("child", "Fix it") },
  })
  const reads: Reads<string> = {
    session: {
      get: (id) => store.sessions[id],
      root: () => "root",
      family: () => ["root", "child"],
      status: () => "running",
      permission: { list: () => [] },
      form: { list: () => [] },
      message: { list: () => [] },
    },
    shell: { list: () => [{ id: "sh1", status: "running", command: "bun test", metadata: { sessionID: "child" } }] },
  }
  const reader = familyReader()
  let runs = 0
  const view = createRoot(() => createMemo(() => (runs++, reader(reads, "root"))))
  const before = view()
  // A step's cost lands on the session: the host replaces its record.
  setStore("sessions", "child", info("child", "Fix it", 0.42))
  expect(view()).toBe(before)
  expect(runs).toBe(1)
  // A new title is something the family carries.
  setStore("sessions", "child", info("child", "Fix it well", 0.42))
  expect(view()).not.toBe(before)
  expect(view().sessions[1]).toMatchObject({ title: "Fix it well", shells: [{ id: "sh1", command: "bun test" }] })
  expect(runs).toBe(2)
})
