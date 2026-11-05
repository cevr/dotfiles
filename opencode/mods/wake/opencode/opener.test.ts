// The opener over a stand-in for the plugin's RPC client.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { latch, openerLaws } from "../laws.ts"
import { Opener } from "../service.ts"
import { layer } from "./opener.ts"

openerLaws("the OpenCode opener", (answer) =>
  layer((asked) => (answer === undefined ? Effect.fail(new Error("no RPC server for dotfiles-opencode.wake.opener")) : Effect.succeed(answer(asked)))),
)

describe("the opener's answer", () => {
  test("one that is not Opened is OpenerUnavailable", async () => {
    const failure = await Effect.runPromise(
      Opener.use((opener) => opener.open(latch)).pipe(Effect.flip, Effect.provide(layer(() => Effect.succeed({ outcome: "maybe" })))),
    )
    expect(failure._tag).toBe("OpenerUnavailable")
  })
})
