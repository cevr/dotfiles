import { describe, expect, test } from "bun:test"
import { taskBrief } from "./prompt.ts"

describe("task brief typed into a pane", () => {
  test("names the sender only as the orchestrator and never mentions OpenCode", () => {
    const text = taskBrief({
      prompt: "Inspect src/foo.ts and summarize the bug.",
      resultFile: "/tmp/run/result.md",
    })
    expect(text).toContain("the orchestrator")
    expect(text.toLowerCase()).not.toContain("opencode")
    expect(text).toContain("/tmp/run/result.md")
    expect(text).toContain("Inspect src/foo.ts and summarize the bug.")
  })

  test("supports follow-up without injecting a system prompt", () => {
    const text = taskBrief({
      prompt: "Now add a regression test for empty input.",
      resultFile: "/tmp/run/result-r2.md",
      followUp: true,
    })
    expect(text).toContain("the orchestrator")
    expect(text.toLowerCase()).not.toContain("opencode")
    expect(text).not.toContain("system prompt")
    expect(text).toContain("/tmp/run/result-r2.md")
  })
})
