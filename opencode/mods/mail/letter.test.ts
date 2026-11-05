import { describe, expect, test } from "bun:test"
import { AmbiguousTitle, NoSuchSession, SelfAddressed } from "./address.ts"
import { compose, deliveryOf, EmptyMessage, excerpt, explain, receipt } from "./letter.ts"

const A = { id: "ses_a", title: "Bite PR" }
const B = { id: "ses_b", title: 'The "dotfiles" run' }

describe("a letter", () => {
  test("opens with a header naming the sender and how to answer it, then the text", () => {
    const letter = compose(A, A, "  Can you rebase on main?\n")
    expect(letter.text).toBe(
      [
        '✉ Message from session "Bite PR" (ses_a), sent with the message tool. It is not the user speaking.',
        'To answer, call the message tool with { "to": "ses_a", "text": "…" }; answer only if it asks for something.',
        "",
        "Can you rebase on main?",
      ].join("\n"),
    )
  })

  test("names another session to answer when the sender gives one", () => {
    const [, answer] = compose(A, B, "hi").text.split("\n")
    expect(answer).toBe(
      'Answers go to session "The \\"dotfiles\\" run" (ses_b): call the message tool with { "to": "ses_b", "text": "…" }; answer only if it asks for something.',
    )
  })

  test("an untitled sender is named by its id", () => {
    expect(compose({ id: "ses_x" }, { id: "ses_x" }, "hi").text).toStartWith('✉ Message from session "ses_x" (ses_x)')
    expect(compose({ id: "ses_x", title: " " }, { id: "ses_x" }, "hi").description).toBe("✉ from ses_x · hi")
  })

  test("the transcript's line is ✉ from the sender and an excerpt on one line", () => {
    expect(compose(A, A, "Rebase\n  on   main").description).toBe("✉ from Bite PR · Rebase on main")
    const long = compose(A, A, "word ".repeat(40)).description
    expect(long).toStartWith("✉ from Bite PR · word word")
    expect(long).toEndWith("…")
    expect(long.length).toBe("✉ from Bite PR · ".length + 80)
  })

  test("its metadata marks it as mail, with the sender and the session to answer", () => {
    expect(compose(A, B, "hi").metadata).toEqual({
      source: "mail",
      from: { sessionID: "ses_a", title: "Bite PR" },
      replyTo: { sessionID: "ses_b", title: 'The "dotfiles" run' },
    })
  })
})

describe("the excerpt", () => {
  test("keeps short text whole and cuts long text at the limit with …", () => {
    expect(excerpt("a  b\n c", 10)).toBe("a b c")
    expect(excerpt("x".repeat(200), 200)).toBe("x".repeat(200))
    expect(excerpt("x".repeat(201), 200)).toBe(`${"x".repeat(199)}…`)
  })
})

describe("delivery", () => {
  test("is a steer for a running session, a wake for an idle one, and a wait when told not to wake", () => {
    expect(deliveryOf(true, true)).toBe("steered")
    expect(deliveryOf(true, false)).toBe("steered")
    expect(deliveryOf(false, true)).toBe("woke")
    expect(deliveryOf(false, false)).toBe("queued")
  })

  test("the sender reads how it went", () => {
    expect(receipt(A, "steered")).toBe('Delivered to session "Bite PR" (ses_a). It is running and reads it at its next step.')
    expect(receipt(A, "woke")).toBe('Delivered to session "Bite PR" (ses_a). It was idle and is now reading it.')
    expect(receipt(A, "queued")).toBe('Delivered to session "Bite PR" (ses_a). It is idle and reads it at its next turn (not woken).')
  })

  test("each refusal says what to do instead", () => {
    expect(explain(new NoSuchSession({ to: "billing" }))).toBe(
      'No session on this server is "billing". List them with the sessions tool, and give an id (ses_…) or a title.',
    )
    expect(explain(new AmbiguousTitle({ to: "money", matches: [{ id: "ses_a", title: "Money" }, { id: "ses_b", title: "Money 2" }] }))).toBe(
      'More than one session matches "money": ses_a "Money", ses_b "Money 2". Give the id.',
    )
    expect(explain(new SelfAddressed({ sessionID: "ses_a" }))).toBe("That is your own session (ses_a). Write to another one.")
    expect(explain(new EmptyMessage())).toBe("The message has no text.")
  })
})
