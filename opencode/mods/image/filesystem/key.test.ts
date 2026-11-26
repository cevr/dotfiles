// @reads all
// @reads-reason subprocess reads at mods/image/filesystem/key.test.ts: Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "image-key"]).stdout.toString().trim()),
import { describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { Effect, Option, Redacted } from "effect"
import { openAiKeyLaws } from "../laws.ts"
import { OpenAiKey } from "../service.ts"
import { keyFile, layer, store } from "./key.ts"

/** A scratch data home for the case, removed with it. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "image-key"]).stdout.toString().trim()),
  (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
)

const keyOf = (env: Option.Option<string>, file: string) =>
  Effect.provide(Effect.service(OpenAiKey), layer({ env, file })).pipe(Effect.flatMap((key) => key.read), Effect.map(Redacted.value))

openAiKeyLaws("the key file", (value) =>
  Effect.gen(function* () {
    const file = keyFile(yield* scratch)
    yield* Effect.forEach(Option.toArray(value), (key) => store(file, Redacted.make(key)).pipe(Effect.orDie))
    return layer({ env: Option.none(), file })
  }),
)

describe("the key file", () => {
  test("a set, non-empty OPENAI_API_KEY wins over the file; an empty one does not", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const file = keyFile(yield* scratch)
          yield* store(file, Redacted.make("  sk-from-file-0001  "))
          expect(yield* keyOf(Option.some("sk-from-env-0002"), file)).toBe("sk-from-env-0002")
          expect(yield* keyOf(Option.some("   "), file)).toBe("sk-from-file-0001")
          expect(yield* keyOf(Option.none(), file)).toBe("sk-from-file-0001")
        }),
      ),
    ))

  test("store keeps the key readable by its owner alone, in a folder only the owner enters", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const file = keyFile(yield* scratch)
          yield* store(file, Redacted.make("sk-mode-check-0003"))
          const modes = [file, file.replace(/\/openai\.key$/u, "")].map((path) => spawnSync(["ls", "-ld", path]).stdout.toString().slice(0, 10))
          expect(modes).toEqual(["-rw-------", "drwx------"])
        }),
      ),
    ))
})
