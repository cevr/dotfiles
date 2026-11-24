import { layer } from "@effect/platform-bun/BunServices"
import { Effect, FileSystem } from "effect"
import { expect, it } from "effect-bun-test"

// The Round 6 verifier's precise reader, kept on an actual tracked link.
it.live.layer(layer)("reads the file named by a tracked link", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    expect(yield* fs.readFileString("sim/fixtures/read-links/verification-link.txt")).toBe("head\n")
  }),
)
