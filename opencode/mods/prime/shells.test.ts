import { describe, expect, test } from "bun:test"
import { SHELLS_SHOWN, lastLine, sessionShells, shellOption, shellState, type ShellEntry } from "./shells.ts"

const shell = (over: Partial<ShellEntry> = {}): ShellEntry => ({
  id: "sh_1",
  status: "running",
  command: "bun run dev",
  metadata: { sessionID: "ses_a" },
  time: { started: 1_000 },
  ...over,
})

describe("the dock's shell list", () => {
  test("only the session's shells, running first, newest first within each", () => {
    const list = sessionShells(
      [
        shell({ id: "sh_old", time: { started: 1_000 } }),
        shell({ id: "sh_ended", status: "exited", exit: 0, time: { started: 5_000, completed: 6_000 } }),
        shell({ id: "sh_new", time: { started: 3_000 } }),
        shell({ id: "sh_other", metadata: { sessionID: "ses_b" }, time: { started: 9_000 } }),
      ],
      "ses_a",
    )
    expect(list.map((each) => each.id)).toEqual(["sh_new", "sh_old", "sh_ended"])
  })

  test("keeps the newest few", () => {
    const many = Array.from({ length: SHELLS_SHOWN + 5 }, (_, index) =>
      shell({ id: `sh_${index}`, time: { started: index } }),
    )
    const list = sessionShells(many, "ses_a")
    expect(list).toHaveLength(SHELLS_SHOWN)
    expect(list[0]?.id).toBe(`sh_${SHELLS_SHOWN + 4}`)
  })

  test("the state reads as a shell handle's list line leads with it", () => {
    expect(shellState(shell())).toBe("running")
    expect(shellState(shell({ status: "exited", exit: 2 }))).toBe("exited 2")
    expect(shellState(shell({ status: "killed", signal: "SIGTERM" }))).toBe("killed")
    expect(shellState(shell({ status: "exited", signal: "SIGKILL" }))).toBe("killed")
    expect(shellState(shell({ status: "timeout", signal: "SIGTERM" }))).toBe("timed out")
  })

  test("the last line is the last one with text, trimmed and clipped", () => {
    expect(lastLine("one\ntwo\n\n  \n")).toBe("two")
    expect(lastLine("")).toBeUndefined()
    expect(lastLine("x".repeat(200))).toHaveLength(72)
  })

  test("an option: the description as title, then state, runtime and last line, under its category", () => {
    const option = shellOption(
      shell({ metadata: { sessionID: "ses_a", description: "Dev server" } }),
      66_000,
      "ready on :3000\n",
    )
    expect(option).toEqual({
      title: "Dev server",
      value: "sh_1",
      description: "running · 1m 05s · ready on :3000",
      category: "Running",
    })
  })

  test("with no description, the command's first line; with no output, says so", () => {
    const option = shellOption(
      shell({ command: "sleep 5\necho done", status: "killed", signal: "SIGTERM", time: { started: 0, completed: 2_000 } }),
      99_000,
      "",
    )
    expect(option.title).toBe("sleep 5")
    expect(option.description).toBe("killed · 2s · no output")
    expect(option.category).toBe("Ended")
  })
})
