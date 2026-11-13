// The server plugin's answer to the fork's experimental.queue.deliver hook:
// every queued prompt the host offers goes out as one message, joined by a
// newline. tests/queue-merge.test.ts runs it in OpenCode, where three queued
// prompts arrive as one user message.
import { describe, expect, test } from "bun:test"
import { deliver } from "./server.ts"

describe("queue.deliver", () => {
  test("takes every offered prompt, joined by a newline", () => {
    const event = { prompts: [{ text: "A" }, { text: "B" }, { text: "C" }], take: 1, separator: "\n\n" }
    deliver(event)
    expect(event).toEqual({ prompts: event.prompts, take: 3, separator: "\n" })
  })
})
