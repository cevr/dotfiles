// The open background questions as the reporter follows them over the
// questions RPC. Bun's tests resolve solid-js to its server build, which never
// re-runs a computation, so this file takes the reactive build OpenCode loads
// (as mods/subagents/solid/reader.test.ts does).
import { expect, mock, test } from "bun:test"
import { CHANGED, type Question } from "@dotfiles/opencode-questions/question"
import type { Source } from "./asked.ts"

const REACTIVE = "solid-js/dist/solid.js"
mock.module("solid-js", () => import(REACTIVE))
const { createRoot, createSignal } = await import("solid-js")
const { followAsked } = await import("./asked.ts")

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
