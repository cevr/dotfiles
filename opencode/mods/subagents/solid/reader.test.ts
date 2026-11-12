// The family read through a Solid store, as OpenCode's TUI holds the session
// data: a token streamed into one message re-reads that message alone, never
// the rest of a long family. Bun's tests resolve solid-js to its server build,
// which never re-runs a computation, so this file takes the reactive build
// OpenCode loads.
import { expect, mock, test } from "bun:test"
import type { Latch, Session, Shell } from "../family.ts"
import { message, read, type Reads } from "../opencode/view.ts"
import type { Paths } from "../same.ts"

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

/** `value` without its field `key`: an optional field left absent. */
const without = <T, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _, ...rest } = value
  return rest
}

test("two readings of a session are the same while every field it carries is, and its messages are the same array", () => {
  const messages: Session["messages"] = []
  // Every field present, optional ones too, so each can be changed or left out.
  const latch: Latch = { hold: "pace", reason: "too many", opensAt: 5, at: 4, cancelledAt: 6, failed: "no slot" }
  const shell: Shell = { id: "sh1", command: "bun test", description: "the suite" }
  const time: Session["time"] = { created: 1, busy: 2, idle: 3, updated: 4 }
  const base: Session = {
    id: "a",
    parentID: "root",
    title: "Fix it",
    agent: "general",
    model: "claude-opus-5-5",
    outcome: "succeeded",
    time,
    running: true,
    shells: [shell, { id: "sh2", command: "bun x" }],
    latch,
    permissions: ["edit a.ts"],
    questions: ["Which?"],
    messages,
  }
  // A new reading with new objects and lists that say the same is the same.
  const again: Session = { ...base, time: { ...time }, latch: { ...latch }, shells: base.shells.map((s) => ({ ...s })), permissions: ["edit a.ts"], questions: ["Which?"] }
  expect(sameSession(base, again)).toBe(true)
  // The copies that differ from it in one field each, one entry per field path of `Session`:
  // a field added to `Session` fails typecheck here until it has its entry.
  const withLatch = (over: Partial<Latch>): Session => ({ ...base, latch: { ...latch, ...over } })
  const withTime = (over: Partial<Session["time"]>): Session => ({ ...base, time: { ...time, ...over } })
  const withShell = (over: Shell): Session => ({ ...base, shells: [over, base.shells[1]!] })
  const changed = {
    id: [{ ...base, id: "b" }],
    parentID: [{ ...base, parentID: "other" }, without(base, "parentID")],
    title: [{ ...base, title: "Fix that" }, without(base, "title")],
    agent: [{ ...base, agent: "worker" }, without(base, "agent")],
    model: [{ ...base, model: "gpt-6" }, without(base, "model")],
    outcome: [{ ...base, outcome: "failed" }, without(base, "outcome")],
    time: [{ ...base, time: { created: 1 } }],
    "time.created": [withTime({ created: 9 })],
    "time.busy": [withTime({ busy: 9 }), { ...base, time: without(time, "busy") }],
    "time.idle": [withTime({ idle: 9 }), { ...base, time: without(time, "idle") }],
    "time.updated": [withTime({ updated: 9 }), { ...base, time: without(time, "updated") }],
    running: [{ ...base, running: false }],
    shells: [{ ...base, shells: [shell] }, { ...base, shells: [] }],
    "shells[].id": [withShell({ ...shell, id: "sh9" })],
    "shells[].command": [withShell({ ...shell, command: "bun y" })],
    "shells[].description": [withShell({ ...shell, description: "other" }), withShell(without(shell, "description"))],
    latch: [without(base, "latch")],
    "latch.hold": [withLatch({ hold: "sabbath" })],
    "latch.reason": [withLatch({ reason: "other" })],
    "latch.opensAt": [withLatch({ opensAt: 9 })],
    "latch.at": [withLatch({ at: 9 })],
    "latch.cancelledAt": [withLatch({ cancelledAt: 9 }), { ...base, latch: without(latch, "cancelledAt") }],
    "latch.failed": [withLatch({ failed: "other" }), { ...base, latch: without(latch, "failed") }],
    permissions: [{ ...base, permissions: ["edit b.ts"] }, { ...base, permissions: [] }],
    questions: [{ ...base, questions: ["What?"] }, { ...base, questions: [] }],
    // Compared as one value: the transcript memo keeps the array while no item changes.
    messages: [{ ...base, messages: [...messages] }],
  } satisfies { readonly [P in Paths<Session, "messages">]: ReadonlyArray<Session> }
  const copies = Object.entries(changed).flatMap(([path, sessions]) => sessions.map((session, index) => ({ path: `${path}#${index}`, session })))
  expect(copies.filter((copy) => sameSession(base, copy.session)).map((copy) => copy.path)).toEqual([])
  // And the other way round, an absent field read first.
  expect(copies.filter((copy) => sameSession(copy.session, base)).map((copy) => copy.path)).toEqual([])
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
