import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { Herdr, HerdrError } from "../src/services/Herdr.js"
import { Shell } from "../src/services/Shell.js"

/** herdr as it fails: exit 1, its error as JSON on stderr, nothing on stdout. */
const failing = (stderr: string) =>
  Herdr.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Shell,
        Shell.of({ run: () => Effect.succeed({ stdout: "", stderr, exitCode: 1 }) }),
      ),
    ),
  )

describe("herdr", () => {
  it.effect("a failed command keeps herdr's code and its words", () =>
    Effect.gen(function* () {
      const herdr = yield* Herdr
      const error = yield* Effect.flip(herdr.prompt("hymn-src-impl", "hi"))
      expect(error).toBeInstanceOf(HerdrError)
      expect(Schema.is(HerdrError)(error) && error.reason).toBe(
        "agent_not_found: agent target hymn-src-impl not found",
      )
    }).pipe(
      Effect.provide(
        failing(
          `{"error":{"code":"agent_not_found","message":"agent target hymn-src-impl not found"},"id":"cli:agent:prompt"}\n`,
        ),
      ),
    ),
  )

  it.effect("output that is not herdr's JSON is kept whole", () =>
    Effect.gen(function* () {
      const herdr = yield* Herdr
      const error = yield* Effect.flip(herdr.prompt("hymn-src-impl", "hi"))
      expect(error).toBeInstanceOf(HerdrError)
      expect(Schema.is(HerdrError)(error) && error.reason).toBe("exit_1: herdr: no server running")
    }).pipe(Effect.provide(failing("herdr: no server running\n"))),
  )
})
