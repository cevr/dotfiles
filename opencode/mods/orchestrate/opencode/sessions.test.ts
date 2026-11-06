// OpenCode's sessions over a stand-in for the host's `session.get` and
// `session.context`, which fail for a session they do not know.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { type SessionsWorld, sessionsLaws } from "../laws.ts"
import { lastWords } from "./sessions.ts"
import * as OpenCodeSessions from "./sessions.ts"

sessionsLaws("OpenCode's Sessions", (world) => {
  const get = (sessionID: string): Effect.Effect<SessionsWorld[string], Error> => {
    const session = Object.hasOwn(world, sessionID) ? world[sessionID] : undefined
    return session === undefined ? Effect.fail(new Error(`Session not found: ${sessionID}`)) : Effect.succeed(session)
  }
  return OpenCodeSessions.layer(get, (sessionID) =>
    get(sessionID).pipe(
      Effect.map((session) => [
        { type: "user", text: "go" },
        ...(session.lastWords === undefined ? [] : [{ type: "assistant", content: [{ type: "text", text: session.lastWords }] }]),
      ]),
    ),
  )
})

test("the last words are the newest assistant message that wrote text, its text parts joined", () => {
  const said = (...content: Array<unknown>) => ({ type: "assistant", content })
  const text = (words: string) => ({ type: "text", text: words })
  const tool = { type: "tool", name: "shell" }
  expect(
    lastWords([said(text("first")), { type: "user", text: "more" }, said(text("implementor auth r1: ready /r/auth/round-1-request.md"), tool, text("Gate green.")), said(tool), said(text("  "))]),
  ).toBe("implementor auth r1: ready /r/auth/round-1-request.md\nGate green.")
  expect(lastWords([{ type: "user", text: "go" }, said({ type: "reasoning", text: "thinking" })])).toBeUndefined()
  expect(lastWords([])).toBeUndefined()
})
