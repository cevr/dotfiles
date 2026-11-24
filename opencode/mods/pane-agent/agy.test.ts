import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { adapterFor } from "./adapter.ts"
import { agyAdapter } from "./agy.ts"
import { DONE_FRAME, PASTED_FRAME, PERMISSION_FRAME, READY_FRAME, SIGNIN_FRAME, TRUST_FRAME, WORKING_FRAME } from "./agy.fixture.ts"

describe("agy harness adapter", () => {
  test("launches unmodified agy with no forbidden flags unless dangerousSkipPermissions is requested", () => {
    expect(agyAdapter.command({})).toEqual(["agy"])
    expect(agyAdapter.command({ dangerousSkipPermissions: true })).toEqual(["agy", "--dangerously-skip-permissions"])
    const cmd = agyAdapter.command({})
    expect(cmd).not.toContain("-p")
    expect(cmd).not.toContain("--print")
    expect(cmd).not.toContain("acp")
    expect(cmd).not.toContain("--dangerously-skip-permissions")
  })

  test("adapter registry resolves agy", () => {
    expect(adapterFor("agy").harness).toBe("agy")
  })

  test("submits multi-line text using bracketed paste followed by Return", () => {
    const steps = agyAdapter.formatSubmit("line one\nline two\nline three")
    expect(steps).toEqual(["\x1b[200~line one\nline two\nline three\x1b[201~", "\r"])
  })

  test("interrupts with Escape", () => {
    expect(agyAdapter.interruptSequence).toBe("\x1b")
  })

  test("detects ready for input on real ready frame, not on working or trust frames", () => {
    expect(agyAdapter.readyForInput(READY_FRAME)).toBe(true)
    expect(agyAdapter.readyForInput(DONE_FRAME)).toBe(true)
    expect(agyAdapter.readyForInput(WORKING_FRAME)).toBe(false)
    expect(agyAdapter.readyForInput(TRUST_FRAME)).toBe(false)
    expect(agyAdapter.readyForInput(PERMISSION_FRAME)).toBe(false)
    expect(agyAdapter.readyForInput(SIGNIN_FRAME)).toBe(false)
    expect(agyAdapter.readyForInput("")).toBe(false)
  })

  test("detects turn ended only when esc to cancel is gone and input box is back", () => {
    expect(agyAdapter.turnEnded(WORKING_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(PASTED_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(TRUST_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(PERMISSION_FRAME)).toBe(false)
    expect(agyAdapter.turnEnded(DONE_FRAME)).toBe(true)
  })

  test("surfaces trust, permission, and sign-in prompts as needs-input with the pane's last lines", () => {
    const trust = agyAdapter.needsInput(TRUST_FRAME)
    expect(Option.isSome(trust)).toBe(true)
    if (Option.isSome(trust)) {
      expect(trust.value.summary).toContain("trust")
      expect(trust.value.tail).toContain("Yes, I trust this folder")
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
    expect(Option.isNone(agyAdapter.needsInput(WORKING_FRAME))).toBe(true)
    expect(Option.isNone(agyAdapter.needsInput(DONE_FRAME))).toBe(true)
  })

  test("reads the last answer from a completed frame", () => {
    expect(agyAdapter.readLastAnswer(DONE_FRAME)).toBe("pong")
  })
})
