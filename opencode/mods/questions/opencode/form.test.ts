// /answer over a stand-in host: the one form it opens in the session on
// screen, holding that session's questions and its subagents'.
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
    asker: (sessionID) => (sessionID === "ses_child" ? "implementor auth r1" : sessionID),
  }
  return { view, created }
}

test("one form in the session on screen: its own questions first, then its subagents', each naming who asked", async () => {
  const { view, created } = host()
  const done = await openForms(view, "ses_root", [asked("ses_child", "q1", 1), asked("ses_root", "q2", 3), asked("ses_root", "q1", 2)])
  expect(done).toEqual({ opened: 1, already: 0, failed: [] })
  expect(created.map(([sessionID, input]) => [sessionID, input.fields.map((field) => [field.key, field.description])])).toEqual([
    [
      "ses_root",
      [
        ["ask_user_async:q1", "ses_root q1?"],
        ["ask_user_async:q2", "ses_root q2?"],
        ["ask_user_async:ses_child:q1", "implementor auth r1 asks: ses_child q1?"],
      ],
    ],
  ])
})

test("a session with one of our forms pending gets no second; another form does not count; a failure is named", async () => {
  const pending = host({ ses_root: [{ fields: [{ key: "ask_user_async:q1" }] }] })
  expect(await openForms(pending.view, "ses_root", [asked("ses_root", "q1", 1), asked("ses_child", "q1", 2)])).toEqual({ opened: 0, already: 1, failed: [] })
  expect(pending.created).toEqual([])
  const other = host({ ses_root: [{ fields: [{ key: "q0" }] }] })
  expect(await openForms(other.view, "ses_root", [asked("ses_child", "q1", 2)])).toEqual({ opened: 1, already: 0, failed: [] })
  const failing = host({}, ["ses_root"])
  expect(await openForms(failing.view, "ses_root", [asked("ses_root", "q1", 1)])).toEqual({ opened: 0, already: 0, failed: ["ses_root"] })
})
