import { describe, expect, test } from "bun:test"
import { resumeBrief, taskBrief } from "./prompt.ts"

describe("task brief typed into a pane", () => {
  test("names the sender only as the orchestrator and never mentions OpenCode", () => {
    const brief = taskBrief({
      prompt: "Implement unit pane-agent in the lane.\nRun tests.",
      resultFile: "/tmp/run/pane-agent-request.md",
    })
    expect(brief).toContain("the orchestrator")
    expect(brief.toLowerCase()).not.toContain("opencode")
    expect(brief).toContain("Implement unit pane-agent in the lane.\nRun tests.")
    expect(brief).toContain("/tmp/run/pane-agent-request.md.tmp")
    expect(brief).toContain("rename it to /tmp/run/pane-agent-request.md")
  })

  test("supports follow-up and resume briefs without injecting a system prompt or mentioning OpenCode", () => {
    const follow = taskBrief({
      prompt: "Fix the failing assertion.",
      resultFile: "/tmp/run/r2.md",
      followUp: true,
    })
    expect(follow).toContain("Follow-up from the orchestrator")
    expect(follow.toLowerCase()).not.toContain("opencode")
    expect(follow).toContain("/tmp/run/r2.md")

    const resumed = resumeBrief({ resultFile: "/tmp/run/r2.md" })
    expect(resumed).toContain("the orchestrator")
    expect(resumed.toLowerCase()).not.toContain("opencode")
    expect(resumed).toContain("/tmp/run/r2.md")
  })
})
