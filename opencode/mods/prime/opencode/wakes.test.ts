import { describe, expect, test } from "bun:test"
import { WAKES } from "@dotfiles/opencode-wake/wake"
import type { Plugin } from "@opencode/plugin/tui"
import { cancelWake } from "./wakes.ts"

/** A context whose wake RPC answers `cancel` with `answer`, recording what it was asked. */
function context(answer: () => Promise<unknown>) {
  const asked: Array<{ readonly id: string; readonly input: unknown }> = []
  const fake = {
    location: { directory: "/nonexistent/loop-probe-x" },
    client: {
      rpc: (protocol: typeof WAKES) => ({
        cancel: (input: unknown) => {
          asked.push({ id: protocol.id, input })
          return answer()
        },
      }),
    },
  }
  return { context: fake as unknown as Plugin.Context, asked }
}

describe("the composer tabs' cancel", () => {
  test("asks the wake server to cancel the session's entry, and reads its going as no refusal", async () => {
    const { context: ctx, asked } = context(async () => ({ outcome: "cancelled", ids: ["walpha1"] }))
    expect(await cancelWake(ctx, "ses_a", "walpha1")).toBeUndefined()
    expect(asked).toEqual([{ id: WAKES.id, input: { sessionID: "ses_a", id: "walpha1" } }])
  })

  test("a refusal reads as its reason", async () => {
    const { context: ctx } = context(async () => ({ outcome: "refused", reason: "no wake walpha1 in this session" }))
    expect(await cancelWake(ctx, "ses_a", "walpha1")).toBe("no wake walpha1 in this session")
  })

  test("a failed call or an answer that does not read is a refusal too", async () => {
    expect(await cancelWake(context(() => Promise.reject(new Error("offline"))).context, "ses_a", "w1")).toBe("Error: offline")
    expect(await cancelWake(context(async () => ({ outcome: "maybe" })).context, "ses_a", "w1")).toBe("the wake server's answer did not read")
  })
})
