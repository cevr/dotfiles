import { expect, test } from "bun:test"
import type { Question } from "./question.ts"
import { trayLine, truncate, under, width } from "./tray.ts"

const question = (id: string, extra: Partial<Question> = {}): Question => ({ id, sessionID: "ses_a", question: `Question ${id}?`, assume: "yes", askedAt: 0, ...extra })
const port = question("q1", { header: "Port", assume: "8080" })

test("one question shows its label, its assumption, the hotkey and the command", () => {
  expect(trayLine([port], 80)).toBe("1 open question · Port · assuming 8080 · shift+← /answer")
  expect(trayLine([question("q2")], 80)).toBe("1 open question · Question q2? · assuming yes · shift+← /answer")
})

test("several questions show the count and every label", () => {
  expect(trayLine([port, question("q2", { header: "Flag" })], 80)).toBe("2 open questions · Port, Flag · shift+← /answer")
})

test("as the width shrinks, the assumption drops, then the label is cut, then the hotkey, till only count and command stay", () => {
  const line = "1 open question · Port · assuming a very long assumption · shift+← /answer"
  const long = question("q1", { header: "Port", assume: "a very long assumption" })
  expect(trayLine([long], width(line))).toBe(line)
  expect(trayLine([long], width(line) - 1)).toBe("1 open question · Port · shift+← /answer")
  const wordy = question("q1", { question: "Which port should the dev server listen on?", assume: "8080" })
  expect(trayLine([wordy], 53)).toBe("1 open question · Which port shoul… · shift+← /answer")
  expect(width(trayLine([wordy], 53))).toBe(53)
  expect(trayLine([wordy], 33)).toBe("1 open question · shift+← /answer")
  expect(trayLine([wordy], 32)).toBe("1 open question · /answer")
})

test("truncate keeps text that fits and marks a cut", () => {
  expect(truncate("abc", 3)).toBe("abc")
  expect(truncate("abcdef", 4)).toBe("abc…")
})

test("a session's tray covers its subagents at any depth, not its parent or siblings", () => {
  const members = [
    { id: "ses_root" },
    { id: "ses_child", parentID: "ses_root" },
    { id: "ses_grandchild", parentID: "ses_child" },
    { id: "ses_sibling", parentID: "ses_root" },
  ]
  expect(under("ses_root", members)).toEqual(["ses_root", "ses_child", "ses_grandchild", "ses_sibling"])
  expect(under("ses_child", members)).toEqual(["ses_child", "ses_grandchild"])
  expect(under("ses_alone", [])).toEqual(["ses_alone"])
})
