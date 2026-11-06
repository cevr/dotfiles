// The family read through a Solid store, as OpenCode's TUI holds the session
// data: a token streamed into one message re-reads that message alone, never
// the rest of a long family. Bun's tests resolve solid-js to its server build,
// which never re-runs a computation, so this file takes the reactive build
// OpenCode loads.
import { expect, mock, test } from "bun:test"
import { message, read, type Reads } from "../opencode/view.ts"

// The builds' files carry no types of their own; the imports below take solid-js's.
const REACTIVE = { core: "solid-js/dist/solid.js", store: "solid-js/store/dist/store.js" }
mock.module("solid-js", () => import(REACTIVE.core))
mock.module("solid-js/store", () => import(REACTIVE.store))
const { createMemo, createRoot } = await import("solid-js")
const { createStore, produce } = await import("solid-js/store")
const { familyReader, perItem } = await import("./reader.ts")

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
