import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { adapterFor } from "./adapter.ts"
import { agyAdapter } from "./agy.ts"
import { DONE_FRAME, PASTED_FRAME, PERMISSION_FRAME, READY_FRAME, SIGNIN_FRAME, TRUST_FRAME, WORKING_FRAME } from "./agy.fixture.ts"

describe("agy harness adapter", () => {
  test("launches agy with --dangerously-skip-permissions by default and --add-dir for outside directories", () => {
    expect(agyAdapter.command({})).toEqual(["agy", "--dangerously-skip-permissions"])
    expect(agyAdapter.command({ binary: "/opt/bin/agy" })).toEqual(["/opt/bin/agy", "--dangerously-skip-permissions"])
    expect(agyAdapter.command({ addDirs: ["/tmp/run", "/tmp/other", "/tmp/run"] })).toEqual([
      "agy",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/tmp/run",
      "--add-dir",
      "/tmp/other",
    ])
    expect(agyAdapter.command({ skipPermissions: false })).toEqual(["agy"])
  })

  test("builds resumeCommand with --continue --dangerously-skip-permissions --add-dir and -i prompt", () => {
    expect(
      agyAdapter.resumeCommand({
        addDirs: ["/tmp/run"],
        initialPrompt: "Continue the task.",
      }),
    ).toEqual([
      "agy",
      "--continue",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/tmp/run",
      "-i",
      "Continue the task.",
    ])
  })

  test("adapter registry resolves agy", () => {
    expect(adapterFor("agy")).toBe(agyAdapter)
  })

  test("submits queued text with bracketed paste + Return, steers with Alt+M, and strips ESC from pasted text", () => {
    const submitChunks = agyAdapter.formatSubmit("line 1\x1b[201~\nline 2\x1b")
    expect(submitChunks).toEqual(["\x1b[200~line 1[201~\nline 2\x1b[201~", "\r"])

    const steerChunks = agyAdapter.formatSteer("stop \x1band check X")
    expect(steerChunks).toEqual(["\x1b[200~stop and check X\x1b[201~", "\x1bm"])
  })

  test("interrupts with Escape", () => {
    expect(agyAdapter.interruptSequence).toBe("\x1b")
  })

  test("detects ready for input on real ready frame, not on working or trust frames", () => {
    expect(agyAdapter.readyForInput(READY_FRAME)).toBe(true)
    expect(agyAdapter.readyForInput(WORKING_FRAME)).toBe(false)
    expect(agyAdapter.readyForInput(TRUST_FRAME)).toBe(false)
    expect(agyAdapter.readyForInput("")).toBe(false)
  })

  test("detects turn ended only when esc to cancel is gone and input box is back", () => {
    expect(agyAdapter.turnEnded(WORKING_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(PASTED_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(DONE_FRAME)).toBe(true)
    expect(agyAdapter.turnEnded(TRUST_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(PERMISSION_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(SIGNIN_FRAME)).toBe(false)
  })

  test("surfaces trust, permission, and sign-in prompts as needs-input with the pane's last lines", () => {
    const trust = agyAdapter.needsInput(TRUST_FRAME)
    expect(Option.isSome(trust)).toBe(true)
    if (Option.isSome(trust)) {
      expect(trust.value.summary).toContain("trust")
      expect(trust.value.tail).toContain("Do you trust the contents of this project?")
    }

    const perm = agyAdapter.needsInput(PERMISSION_FRAME)
    expect(Option.isSome(perm)).toBe(true)
    if (Option.isSome(perm)) {
      expect(perm.value.tail).toContain("Allow once")
    }

    const signin = agyAdapter.needsInput(SIGNIN_FRAME)
    expect(Option.isSome(signin)).toBe(true)
    if (Option.isSome(signin)) {
      expect(signin.value.tail).toContain("Select login method")
    }

    expect(Option.isNone(agyAdapter.needsInput(READY_FRAME))).toBe(true)
    expect(Option.isNone(agyAdapter.needsInput(DONE_FRAME))).toBe(true)

    // Scrollback text mentioning (y/n) or Approve/Deny above an active input box must NOT trigger needs_input
    const doneWithPromptTextInAnswer = DONE_FRAME.replace(
      "  pong",
      "  The CLI displays (y/n) and Approve\n  Deny in its docs.",
    )
    expect(Option.isNone(agyAdapter.needsInput(doneWithPromptTextInAnswer))).toBe(true)
    expect(agyAdapter.turnEnded(doneWithPromptTextInAnswer)).toBe(true)
  })

  test("reads the last answer from a completed frame", () => {
    expect(agyAdapter.readLastAnswer(DONE_FRAME)).toBe("pong")
  })
})
