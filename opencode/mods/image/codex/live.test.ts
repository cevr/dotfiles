// One real image through the ChatGPT subscription, run by hand:
// `IMAGE_LIVE=1 bun test mods/image/codex/live.test.ts` (on a host with
// `codex login`). It costs nothing past the plan. The paid route is never run
// live: its stand-in here fails the case if anything reaches it. The image is
// kept at `$IMAGE_LIVE_OUT` (default: a scratch folder named in the output).
import { expect, test } from "bun:test"
import { spawnSync } from "bun"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { layer as files } from "../filesystem/files.ts"
import * as backends from "../memory/backends.ts"
import { Images, layer as model } from "../model.ts"
import { fail } from "../outcome.ts"
import { dimensionsOf } from "../size.ts"
import { ORIGIN, layer as subscription } from "./subscription.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const live = process.env.IMAGE_LIVE === "1"
const target = Option.fromNullishOr(process.env.IMAGE_LIVE_OUT)
const home = Option.getOrElse(Option.fromNullishOr(process.env.HOME), () => "")
const models = Option.getOrElse(
  Option.map(Option.fromNullishOr(process.env.IMAGE_LIVE_MODELS), (list) => list.split(",")),
  () => ["gpt-6.1-sol", "gpt-6-sol"],
)

test.skipIf(!live)(
  "the subscription makes one landscape PNG of the size asked, and nothing reaches the paid route",
  () =>
    Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const out = Option.getOrElse(target, () => `${spawnSync(["mktemp", "-d", "-t", "image-live"]).stdout.toString().trim()}/live.png`)
        const calls = yield* backends.log
        const externals = Layer.mergeAll(
          subscription({ origin: ORIGIN, home, timeoutMs: 300_000 }),
          backends.paid(calls, () => Effect.fail(fail("INVALID_INPUT", "the paid route was reached"))),
          files,
        )
        const images = yield* Layer.build(model.pipe(Layer.provide(externals))).pipe(Effect.map((built) => Context.get(built, Images)))
        const outcome = yield* images.generate({
          prompt: "A lighthouse on a rocky coast at dawn, soft light, wide view",
          images: [],
          path: out,
          size: "1536x1024",
          format: "png",
          models,
          paid: Option.none(),
        })
        expect(outcome.route).toBe("subscription")
        expect(yield* Ref.get(calls)).toEqual([])
        const saved = new Uint8Array(yield* Effect.promise(() => Bun.file(out).arrayBuffer()))
        const size = Option.getOrThrow(dimensionsOf(saved))
        expect(size.width).toBeGreaterThan(size.height)
        yield* Effect.log(`live image: ${out} ${size.width}x${size.height} ${Option.getOrElse(outcome.note, () => "exact size")}`)
      })),
    ),
  hangGuard("acceptance-plus-teardown"),
)
