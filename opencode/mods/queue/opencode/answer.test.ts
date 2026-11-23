// Opening the answer form over a stand-in host: once in the session on
// screen, no second while one of ours is pending, and a refusal said.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { formOf } from "../answer.ts"
import { type FormHost, FormRefused, openAnswer } from "./answer.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const form = formOf("ses_root", { id: "panes", text: "Close old Claude panes" })

const host = (pending: ReadonlyArray<string>, created: Array<{ readonly sessionID: string }>, refuses = false): FormHost => ({
  pending: () => [pending],
  create: (sessionID) =>
    Effect.suspend(() => {
      if (refuses) return Effect.fail(new FormRefused({ sessionID }))
      created.push({ sessionID })
      return Effect.void
    }),
})

describe("opening the answer form", () => {
  effectTest(
    "opens it in the session on screen; one of ours pending opens no second, another form does not count; a refusal says so",
    Effect.gen(function* () {
      const created: Array<{ readonly sessionID: string }> = []
      expect(yield* openAnswer(host(["ask_user_async:q1"], created), "ses_screen", form)).toBe("opened")
      expect(created).toEqual([{ sessionID: "ses_screen" }])
      expect(yield* openAnswer(host(["queue:ses_root:other"], created), "ses_screen", form)).toBe("already")
      expect(yield* openAnswer(host([], created, true), "ses_screen", form)).toBe("failed")
      expect(created).toHaveLength(1)
    }),
    hangGuard("local-fixture"),
  )
})
