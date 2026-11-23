// The reporter's reactive reads: the open background questions as it follows
// them over the questions RPC, and the view it keeps (keptView). Bun's tests
// resolve solid-js to its server build, which never re-runs a computation, so
// this file takes the reactive build OpenCode loads (as
// mods/subagents/solid/reader.test.ts does).
import { expect, mock, test } from "bun:test"
import { CHANGED, type Question } from "@dotfiles/opencode-questions/question"
import type { Source } from "./asked.ts"
import { read, type Reads, type Route } from "./view.ts"

const REACTIVE = "solid-js/dist/solid.js"
mock.module("solid-js", () => import(REACTIVE))
const { createRoot, createSignal } = await import("solid-js")
const { followAsked, keptView } = await import("./asked.ts")

const question = (sessionID: string, id: string, askedAt: number, over: Partial<Question> = {}): Question => ({
  id,
  sessionID,
  question: `Question ${id}?`,
  assume: "the default",
  askedAt,
  ...over,
})

/** A questions plugin whose open questions the test sets, and the reads and listeners it saw. */
function plugin() {
  let open: ReadonlyArray<Question> = []
  let failing = false
  const reads: Array<ReadonlyArray<string>> = []
  const listeners = new Set<(event: { readonly details: unknown }) => void>()
  const source: Source = {
    open: (sessionIDs) => {
      reads.push(sessionIDs)
      if (failing) return Promise.reject(new Error("no questions plugin"))
      return Promise.resolve({ questions: open.filter((q) => sessionIDs.includes(q.sessionID)) })
    },
    listen: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  return {
    source,
    reads,
    listeners,
    set: (questions: ReadonlyArray<Question>) => void (open = questions),
    fail: (on: boolean) => void (failing = on),
    changed: (sessionID: string) => listeners.forEach((listen) => listen({ details: { type: CHANGED, data: { sessionID } } })),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function follow(questions: ReturnType<typeof plugin>, initial: ReadonlyArray<string>) {
  const [members, setMembers] = createSignal(initial)
  const { asked, dispose } = createRoot((dispose) => ({ asked: followAsked(questions.source, members), dispose }))
  return { asked, dispose, setMembers }
}

test("reads the members' open questions at once, each under the session that asked, labelled as the tray labels them", async () => {
  const questions = plugin()
  questions.set([question("ses_root", "q1", 10, { header: "DB choice" }), question("ses_child", "q1", 5), question("ses_other", "q1", 1)])
  const { asked, dispose } = follow(questions, ["ses_root", "ses_child"])
  await settle()
  expect(questions.reads).toEqual([["ses_root", "ses_child"]])
  expect(asked("ses_root")).toEqual([{ label: "DB choice", at: 10 }])
  expect(asked("ses_child")).toEqual([{ label: "Question q1?", at: 5 }])
  expect(asked("ses_other")).toEqual([])
  dispose()
})

test("a change to a member's questions reads again, so a withdrawn or answered question drops out; another session's change does not", async () => {
  const questions = plugin()
  questions.set([question("ses_root", "q1", 1), question("ses_root", "q2", 2)])
  const { asked, dispose } = follow(questions, ["ses_root"])
  await settle()
  expect(asked("ses_root").map((q) => q.label)).toEqual(["Question q1?", "Question q2?"])
  questions.set([question("ses_root", "q2", 2)])
  questions.changed("ses_elsewhere")
  await settle()
  expect(questions.reads.length).toBe(1)
  questions.changed("ses_root")
  await settle()
  expect(asked("ses_root").map((q) => q.label)).toEqual(["Question q2?"])
  dispose()
})

test("a failed read keeps the last reading", async () => {
  const questions = plugin()
  questions.set([question("ses_root", "q1", 1)])
  const { asked, dispose } = follow(questions, ["ses_root"])
  await settle()
  questions.fail(true)
  questions.changed("ses_root")
  await settle()
  expect(questions.reads.length).toBe(2)
  expect(asked("ses_root")).toEqual([{ label: "Question q1?", at: 1 }])
  dispose()
})

test("new members read again; with none, nothing is read and none are open", async () => {
  const questions = plugin()
  questions.set([question("ses_a", "q1", 1), question("ses_b", "q1", 2)])
  const { asked, dispose, setMembers } = follow(questions, ["ses_a"])
  await settle()
  setMembers(["ses_a"])
  await settle()
  expect(questions.reads).toEqual([["ses_a"]])
  setMembers(["ses_b"])
  await settle()
  expect(questions.reads).toEqual([["ses_a"], ["ses_b"]])
  expect(asked("ses_b")).toEqual([{ label: "Question q1?", at: 2 }])
  setMembers([])
  await settle()
  expect(questions.reads.length).toBe(2)
  expect(asked("ses_b")).toEqual([])
  dispose()
})

test("disposing stops listening", async () => {
  const questions = plugin()
  const { dispose } = follow(questions, ["ses_root"])
  await settle()
  expect(questions.listeners.size).toBe(1)
  dispose()
  expect(questions.listeners.size).toBe(0)
})

type Message = { readonly type: string; readonly content: ReadonlyArray<unknown> }

const runningPart = (name: string) => ({ type: "tool", name, state: { status: "running", input: { command: name } }, time: { created: 1 } })
const working = (name: string): ReadonlyArray<Message> => [{ type: "assistant", content: [{ type: "text", text: "" }, runningPart(name)] }]

/** A family of `size` subagents under `ses_root`, each session's messages a signal as the TUI's store gives them, and how often each was read. */
function family(size: number) {
  const children = Array.from({ length: size }, (_, i) => `ses_c${i}`)
  const [members, setMembers] = createSignal<ReadonlyArray<string>>(["ses_root", ...children])
  const messages = new Map(["ses_root", ...children].map((id) => [id, createSignal(working(`work ${id}`))]))
  const listed = new Map<string, number>()
  const reads: Reads = {
    session: {
      get: () => ({ title: "Root" }),
      root: () => "ses_root",
      family: () => members(),
      status: () => "running",
      pending: { list: () => [] },
      permission: { list: () => [] },
      form: { list: () => [] },
      message: {
        list: (id) => {
          listed.set(id, (listed.get(id) ?? 0) + 1)
          return messages.get(id)?.[0]() ?? []
        },
      },
    },
  }
  const post = (id: string, value: ReadonlyArray<Message>) => messages.get(id)?.[1](value)
  return { children, setMembers, post, reads, listed }
}

test("the kept view: a part added to one subagent reads that subagent's messages alone, and says what read says", () => {
  const { post, reads, listed } = family(30)
  const route: Route = { type: "session", sessionID: "ses_c3" }
  createRoot((dispose) => {
    const kept = keptView(reads, () => route, () => [])
    expect(kept.view()).toEqual(read(reads, route))
    listed.clear()
    post("ses_c7", [{ type: "assistant", content: [{ type: "text", text: "" }, runningPart("work ses_c7"), runningPart("second")] }])
    const after = kept.view()
    expect([...listed.keys()]).toEqual(["ses_c7"])
    expect(after).toEqual(read(reads, route))
    kept.dispose()
    dispose()
  })
})

test("the kept view: opening subagents of a large family reads no session's messages again", () => {
  const { children, reads, listed } = family(40)
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "ses_root" })
  createRoot((dispose) => {
    const kept = keptView(reads, route, () => [])
    kept.view()
    listed.clear()
    for (const child of children.slice(0, 10)) {
      setRoute({ type: "session", sessionID: child })
      expect(kept.view().root?.id).toBe("ses_root")
    }
    expect(listed.size).toBe(0)
    kept.dispose()
    dispose()
  })
})

test("the kept view: a session that leaves the family is no longer read", () => {
  const { children, setMembers, post, reads, listed } = family(3)
  createRoot((dispose) => {
    const kept = keptView(reads, () => ({ type: "session", sessionID: "ses_root" }), () => [])
    expect(kept.view().descendants.map((member) => member.id)).toEqual(children)
    setMembers(["ses_root", "ses_c0"])
    expect(kept.view().descendants.map((member) => member.id)).toEqual(["ses_c0"])
    listed.clear()
    post("ses_c2", working("after it left"))
    kept.view()
    expect(listed.get("ses_c2")).toBeUndefined()
    kept.dispose()
    dispose()
  })
})
