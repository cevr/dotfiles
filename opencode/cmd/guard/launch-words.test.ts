// What a launch and status say. A launch whose width no controller
// enforces is refused only with its cause: the command, its width by the
// tool model and the lease's width (round-2 review N3: "width mismatch on
// run <id>" gave none). Status says what the user-scope probe found, a
// timed-out probe as such (N4).
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { widthOf } from "@dotfiles/opencode-guard/admission-wire"
import { SCOPE_PROBE_TIMEOUT_MS } from "@dotfiles/opencode-guard/process/scope-probe"
import { probeText, widthMismatch } from "./admission.ts"

const wide = (n: number) => Option.getOrThrow(widthOf(n))
const advice = "Pass --parallel=N."
const refusalOf = (width: ReturnType<typeof wide> | "unknown" | "full", args: ReadonlyArray<string>, model: number | "unknown" | "invalid") =>
  Option.map(widthMismatch({ width, cpuMilli: 1000 }, args, { width: model, advice }), ({ reason, detail }) => ({ reason, detail }))

describe("the width a launch runs at", () => {
  test("a tool its model proves wider than its lease is refused naming the command and both widths", () => {
    expect(refusalOf(wide(1), ["bun", "test"], 4)).toEqual(Option.some({ reason: "unqualified",
      detail: "bun's width by its tool model is 4, not within the lease's width 1: lease it at that width, or pass the tool a width within it (Pass --parallel=N.)" }))
  })
  test("under a numeric lease a command no model knows runs at the declared width (host-admit-queue law c)", () => {
    expect(refusalOf(wide(2), ["sleep", "1"], "unknown")).toEqual(Option.none())
    expect(refusalOf(wide(2), ["timeout", "600", "sh", "leg.sh"], "unknown")).toEqual(Option.none())
  })
  test("a command within its lease, or under an unknown or full lease, is no mismatch", () => {
    expect(refusalOf(wide(4), ["bun", "test"], 4)).toEqual(Option.none())
    expect(refusalOf("unknown", ["sleep", "1"], "unknown")).toEqual(Option.none())
    expect(refusalOf("full", ["bun", "test"], 16)).toEqual(Option.none())
  })
  test("an invalid width option is refused naming the command", () => {
    expect(refusalOf(wide(2), ["make"], "invalid")).toEqual(
      Option.some({ reason: "invalid-width", detail: "make: its width option is not a positive integer" }))
  })
})

describe("what status says of the user-scope probe", () => {
  test("its own result: a scope, none with the failure, or timed out with each launch probing again", () => {
    expect(probeText({ kind: "scope" }).launcher).toBe("nice + user scope")
    expect(probeText({ kind: "none", why: "exit 1" })).toEqual({ launcher: "nice", through: "nice alone: no user scope for this caller (exit 1)" })
    expect(probeText({ kind: "timed-out", afterMs: SCOPE_PROBE_TIMEOUT_MS })).toEqual({ launcher: "undecided",
      through: `nice, with a user scope where each launch's own probe answers: this probe timed out after ${SCOPE_PROBE_TIMEOUT_MS} ms` })
  })
})
