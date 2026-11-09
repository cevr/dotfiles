// A live shell handle's output over a scripted shell tool: each method adds what
// is new when it continues from the handle's `next`, replaces it when another
// look moved the shell's read position, and keeps the newest output past the cap.
import { describe, expect, test } from "bun:test"
import type { Json } from "../frame.ts"
import { makeShellHandle, MAX_HANDLE_OUTPUT_CHARS, type ShellHandleData } from "./shell-handle.ts"

const exited = (output: string, next: number, truncated = false): ShellHandleData => ({
  id: "sh_1",
  state: "exited",
  exitCode: 0,
  runtimeMs: 5,
  output,
  next,
  truncated,
})

/** A shell tool that answers each call with the next of `answers`. */
const scripted = (...answers: ReadonlyArray<ShellHandleData>) => {
  const left = [...answers]
  return async (): Promise<Json> => left.shift() as unknown as Json
}

describe("a shell handle's output", () => {
  test("keeps the run's output through a wait that sees nothing new", async () => {
    const handle = makeShellHandle(exited("done\n", 5), scripted(exited("", 5)))
    expect((await handle.wait()).output).toBe("done\n")
  })

  test("adds what is new after the output it holds, by bytes", async () => {
    const handle = makeShellHandle(exited("café\n", 6), scripted(exited("après\n", 13)))
    await handle.refresh()
    expect([handle.output, handle.next]).toEqual(["café\naprès\n", 13])
  })

  test("replaces it when the new output does not start where it ends, or when read asks for a view", async () => {
    const handle = makeShellHandle(exited("one\n", 4), scripted(exited("three\n", 14), exited("one\n", 4)))
    expect((await handle.refresh()).output).toBe("three\n")
    expect((await handle.read({ lines: 1 })).output).toBe("one\n")
  })

  test("keeps the newest output past the cap and says earlier output is missing", async () => {
    const big = "x".repeat(MAX_HANDLE_OUTPUT_CHARS)
    const handle = makeShellHandle(exited("head\n", 5), scripted(exited(big, 5 + big.length)))
    await handle.wait()
    expect([handle.output.length, handle.output === big, handle.truncated]).toEqual([MAX_HANDLE_OUTPUT_CHARS, true, true])
  })
})
