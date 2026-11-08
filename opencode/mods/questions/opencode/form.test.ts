// /answer over a stand-in host: the forms it opens, one per asking session.
import { expect, test } from "bun:test"
import type { FormInput } from "../form.ts"
import type { Question } from "../question.ts"
import { type FormHost, openForms } from "./form.ts"

const asked = (sessionID: string, id: string, askedAt: number): Question => ({ id, sessionID, question: `${sessionID} ${id}?`, assume: "no", askedAt })

const host = (pending: Record<string, ReadonlyArray<{ fields: ReadonlyArray<{ key: string }> }>> = {}, failing: ReadonlyArray<string> = []) => {
  const created: Array<readonly [string, FormInput]> = []
  const view: FormHost = {
    pending: (sessionID) => pending[sessionID] ?? [],
    create: (sessionID, input) => (failing.includes(sessionID) ? Promise.reject(new Error("no")) : Promise.resolve(void created.push([sessionID, input]))),
    asker: (sessionID) => (sessionID === "ses_child" ? "general" : sessionID),
  }
  return { view, created }
}

test("one form per asking session: the screen's first with every one of its questions, the subagent's naming it", async () => {
  const { view, created } = host()
  const done = await openForms(view, "ses_root", [asked("ses_child", "q1", 1), asked("ses_root", "q2", 3), asked("ses_root", "q1", 2)])
  expect(done).toEqual({ opened: 2, already: 0, failed: [] })
  expect(created.map(([sessionID, input]) => [sessionID, input.fields.map((field) => field.key), input.metadata.message])).toEqual([
    ["ses_root", ["ask_user_async:q1", "ask_user_async:q2"], undefined],
    ["ses_child", ["ask_user_async:q1"], "Asked by general"],
  ])
})

test("a session with one of our forms pending gets no second; another form does not count; a failure is named", async () => {
  const { view, created } = host({ ses_root: [{ fields: [{ key: "ask_user_async:q1" }] }], ses_child: [{ fields: [{ key: "q0" }] }] }, ["ses_other"])
  const done = await openForms(view, "ses_root", [asked("ses_root", "q1", 1), asked("ses_child", "q1", 2), asked("ses_other", "q1", 3)])
  expect(done).toEqual({ opened: 1, already: 1, failed: ["ses_other"] })
  expect(created.map(([sessionID]) => sessionID)).toEqual(["ses_child"])
})
